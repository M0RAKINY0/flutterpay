import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FlutterPay,
  FlutterPayAuthenticationError,
  FlutterPayConflictError,
  FlutterPayNotFoundError,
  FlutterPayValidationError,
  FlutterPayWebhookSignatureError,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type ChargeCompletedEvent,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const apiDir = join(repoRoot, "apps/api");
const apiServerEntry = join(apiDir, "src/server.ts");

async function getFreePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected TCP address");
  }
  const { port } = addr;
  await new Promise<void>((resolveClose, rejectClose) =>
    srv.close(err => (err ? rejectClose(err) : resolveClose())),
  );
  return port;
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof spawn>, stderrRef: { value: string }) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API server exited early (code=${child.exitCode}, signal=${child.signalCode}): ${stderrRef.value}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Server still booting.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 75));
  }
  throw new Error(`Timed out waiting for API server at ${baseUrl}. stderr: ${stderrRef.value}`);
}

async function startApiServer(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flutterpay-sdk-test-"));
  const dbUrl = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
  const env = { ...process.env, DATABASE_URL: dbUrl };

  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    cwd: apiDir,
    env,
    stdio: "pipe",
  });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const stderrRef = { value: "" };

  const tsxImportUrl = pathToFileURL(require.resolve("tsx/esm")).href;
  const child = spawn(process.execPath, ["--import", tsxImportUrl, apiServerEntry], {
    cwd: apiDir,
    env: {
      ...env,
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_BASE_URL: baseUrl,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr.on("data", chunk => {
    stderrRef.value += chunk.toString();
  });

  const hasExited = () => child.exitCode !== null || child.signalCode !== null;

  t.after(async () => {
    if (!hasExited()) {
      const exited = once(child, "exit");
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>(resolveDelay => {
          timer = setTimeout(resolveDelay, 5_000);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!hasExited()) {
        const forceExited = once(child, "exit");
        child.kill("SIGKILL");
        await forceExited.catch(() => undefined);
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitForHealth(baseUrl, child, stderrRef);
  return baseUrl;
}

async function signupMerchant(baseUrl: string, businessName: string, email: string) {
  const res = await fetch(`${baseUrl}/v1/merchants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      business_name: businessName,
      email,
      password: "a-long-integration-password",
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as {
    merchant: { id: string; business_name: string; email: string };
    keys: { public_key: string; secret_key: string };
  };
}

async function readStream(req: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}

test("Node SDK end-to-end payment flow, verification, typed errors, webhooks, and duplicate delivery handling", async t => {
  const baseUrl = await startApiServer(t);

  const merchantA = await signupMerchant(baseUrl, "Merchant A", "merchant-a@example.com");
  const merchantB = await signupMerchant(baseUrl, "Merchant B", "merchant-b@example.com");

  const sdkA = new FlutterPay({ secretKey: merchantA.keys.secret_key, baseUrl });
  const sdkB = new FlutterPay({ secretKey: merchantB.keys.secret_key, baseUrl });
  const badKeySdk = new FlutterPay({ secretKey: "fp_sec_test_" + "0".repeat(64), baseUrl });

  // Local HTTP receiver capturing raw payloads and signature headers.
  let webhookSecret = "";
  let failNextDelivery = false;
  const processedEventIds = new Set<string>();
  let appliedEffectCount = 0;
  const receivedRequests: Array<{ rawBody: Buffer; signature: string; eventId: string; event: ChargeCompletedEvent }> = [];
  let waitNextWebhook: (() => void) | null = null;

  const receiver = createHttpServer(async (req, res) => {
    const rawBody = await readStream(req);
    const signature = typeof req.headers[WEBHOOK_SIGNATURE_HEADER] === "string" ? req.headers[WEBHOOK_SIGNATURE_HEADER] : "";
    const eventId = typeof req.headers[WEBHOOK_EVENT_ID_HEADER] === "string" ? req.headers[WEBHOOK_EVENT_ID_HEADER] : "";

    if (failNextDelivery) {
      failNextDelivery = false;
      res.statusCode = 500;
      res.end("temporary receiver outage");
      waitNextWebhook?.();
      waitNextWebhook = null;
      return;
    }

    const event = sdkA.webhooks.verify({
      payload: rawBody,
      signature,
      secret: webhookSecret,
    });

    if (!processedEventIds.has(event.id)) {
      processedEventIds.add(event.id);
      appliedEffectCount += 1;
    }
    receivedRequests.push({ rawBody, signature, eventId, event });
    res.statusCode = 200;
    res.end("ok");
    waitNextWebhook?.();
    waitNextWebhook = null;
  });

  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(
    () =>
      new Promise<void>((resolveClose, rejectClose) => {
        receiver.closeAllConnections();
        receiver.close(err => (err ? rejectClose(err) : resolveClose()));
      }),
  );
  const receiverAddr = receiver.address();
  assert.ok(receiverAddr && typeof receiverAddr !== "string");
  const webhookUrl = `http://127.0.0.1:${receiverAddr.port}/webhook`;

  const webhookConfigRes = await fetch(`${baseUrl}/v1/merchants/me/webhook`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${merchantA.keys.secret_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ webhook_url: webhookUrl }),
  });
  assert.equal(webhookConfigRes.status, 200);
  const webhookConfig = (await webhookConfigRes.json()) as { webhook: { secret: string } };
  webhookSecret = webhookConfig.webhook.secret;

  // 1. Create payment via SDK.
  const created = await sdkA.payments.create({
    tx_ref: "sdk-order-1",
    amount_kobo: 500_000,
    currency: "NGN",
    customer_email: "buyer@example.com",
    redirect_url: "http://127.0.0.1:4000/callback",
  });
  assert.equal(created.transaction.status, "pending");
  assert.equal(created.transaction.tx_ref, "sdk-order-1");
  assert.equal(created.transaction.amount_kobo, 500_000);
  assert.equal(created.transaction.currency, "NGN");
  assert.equal(created.link, `${baseUrl}/pay/${created.transaction.id}`);

  // 2. Duplicate tx_ref produces FlutterPayConflictError.
  await assert.rejects(
    () =>
      sdkA.payments.create({
        tx_ref: "sdk-order-1",
        amount_kobo: 500_000,
        currency: "NGN",
        customer_email: "buyer@example.com",
        redirect_url: "http://127.0.0.1:4000/callback",
      }),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayConflictError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "DUPLICATE_TX_REF");
      return true;
    },
  );

  // 3. Invalid input produces FlutterPayValidationError.
  await assert.rejects(
    () =>
      sdkA.payments.create({
        tx_ref: "sdk-order-bad",
        amount_kobo: 50,
        currency: "NGN",
        customer_email: "buyer@example.com",
        redirect_url: "http://127.0.0.1:4000/callback",
      }),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayValidationError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );

  // 4. Invalid secret key produces FlutterPayAuthenticationError.
  await assert.rejects(
    () => badKeySdk.transactions.verify(created.transaction.id),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayAuthenticationError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    },
  );

  // 5. Cross-merchant verification produces FlutterPayNotFoundError.
  await assert.rejects(
    () => sdkB.transactions.verify(created.transaction.id),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayNotFoundError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "NOT_FOUND");
      return true;
    },
  );

  // 6. Complete payment on hosted checkout with test card and await webhook.
  const firstWebhookDone = new Promise<void>(resolveWait => {
    waitNextWebhook = resolveWait;
  });
  const chargeRes = await fetch(`${created.link}/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      card_number: "4242 4242 4242 4242",
      expiry: "12/30",
      cvv: "123",
    }),
  });
  assert.equal(chargeRes.status, 200);
  await Promise.race([
    firstWebhookDone,
    new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("Webhook not received")), 5_000)),
  ]);

  // 7. Verify transaction via SDK.
  const verified = await sdkA.transactions.verify(created.transaction.id);
  assert.equal(verified.transaction.status, "successful");
  assert.equal(verified.transaction.tx_ref, "sdk-order-1");
  assert.equal(verified.transaction.amount_kobo, 500_000);
  assert.equal(verified.transaction.currency, "NGN");
  assert.equal(verified.transaction.card_last4, "4242");

  // 8. Check verified webhook, tampered rejection, and duplicate delivery deduplication.
  assert.equal(receivedRequests.length, 1);
  const first = receivedRequests[0]!;
  assert.equal(first.event.event, "charge.completed");
  assert.equal(first.event.id, first.eventId);
  assert.equal(first.event.data.id, created.transaction.id);
  assert.equal(first.event.data.status, "successful");
  assert.equal(appliedEffectCount, 1);

  assert.throws(
    () =>
      sdkA.webhooks.verify({
        payload: first.rawBody.toString("utf8").replace("500000", "999999"),
        signature: first.signature,
        secret: webhookSecret,
      }),
    FlutterPayWebhookSignatureError,
  );

  // Replaying the exact same signed webhook simulates duplicate delivery; receiver deduplicates by event.id.
  const replayRes = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: first.signature,
      [WEBHOOK_EVENT_ID_HEADER]: first.eventId,
    },
    body: new Uint8Array(first.rawBody),
  });
  assert.equal(replayRes.status, 200);
  assert.equal(receivedRequests.length, 2);
  assert.equal(appliedEffectCount, 1);

  // 9. OTP + Decline flows verified through SDK, plus failed webhook delivery retry log inspection.
  const otpPayment = await sdkA.payments.create({
    tx_ref: "sdk-order-otp",
    amount_kobo: 250_000,
    currency: "NGN",
    customer_email: "otp@example.com",
    redirect_url: "http://127.0.0.1:4000/callback",
  });
  const otpChargeRes = await fetch(`${otpPayment.link}/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      card_number: "5060 9900 0000 0001",
      expiry: "12/30",
      cvv: "123",
    }),
  });
  assert.equal(otpChargeRes.status, 200);
  assert.equal((await sdkA.transactions.verify(otpPayment.transaction.id)).transaction.status, "awaiting_otp");

  failNextDelivery = true;
  const failedAttemptDone = new Promise<void>(resolveWait => {
    waitNextWebhook = resolveWait;
  });
  const otpVerifyRes = await fetch(`${otpPayment.link}/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ otp: "123456" }),
  });
  assert.equal(otpVerifyRes.status, 200);
  await Promise.race([
    failedAttemptDone,
    new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("Webhook failure attempt not received")), 5_000)),
  ]);

  const verifiedOtp = await sdkA.transactions.verify(otpPayment.transaction.id);
  assert.equal(verifiedOtp.transaction.status, "successful");

  // Poll briefly for the API to record the failed attempt + scheduled attempt #2.
  let otpDeliveries = await sdkA.webhooks.listDeliveries({ transaction_id: otpPayment.transaction.id });
  const deliveryDeadline = Date.now() + 3_000;
  while (otpDeliveries.deliveries.length < 2 && Date.now() < deliveryDeadline) {
    await new Promise(r => setTimeout(r, 50));
    otpDeliveries = await sdkA.webhooks.listDeliveries({ transaction_id: otpPayment.transaction.id });
  }
  assert.equal(otpDeliveries.deliveries.length, 2);
  assert.ok(otpDeliveries.deliveries.some(d => d.attempt === 1 && d.status === "failed" && d.response_code === 500));
  assert.ok(otpDeliveries.deliveries.some(d => d.attempt === 2 && d.status === "pending" && d.next_retry_at !== null));

  // 10. List transactions via SDK.
  const listed = await sdkA.transactions.list({ period: "daily", page: 1, limit: 10 });
  assert.equal(listed.pagination.total, 2);
  assert.deepEqual(
    listed.transactions.map(tx => tx.tx_ref).sort(),
    ["sdk-order-1", "sdk-order-otp"],
  );
});

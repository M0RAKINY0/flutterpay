import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { TEST_CARDS, TEST_OTP } from "../src/fake-bank.js";
import {
  createWebhookTracker,
  deliverWebhookAttempt,
  processDueWebhooks,
  signWebhookPayload,
  startWebhookWorker,
  verifyWebhookSignature,
  WEBHOOK_EVENT_CHARGE_COMPLETED,
} from "../src/webhooks.js";
import { postJson, testDatabase, testServer } from "./helpers.js";

const password = "a long learning password";

async function registerMerchant(url: string, email: string, business_name = "Ada's business") {
  const response = await postJson(url, { business_name, email, password });
  assert.equal(response.status, 201);
  return response.json() as Promise<{
    merchant: { id: string; business_name: string; email: string };
    keys: { public_key: string; secret_key: string };
  }>;
}

async function configureWebhook(
  url: string,
  secretKey: string,
  body: { webhook_url: string | null; rotate_secret?: boolean },
) {
  return fetch(`${url}/v1/merchants/me/webhook`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createTestPayment(url: string, secretKey: string, txRef: string, amountKobo = 500_000) {
  const response = await fetch(`${url}/v1/payments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount_kobo: amountKobo,
      currency: "NGN",
      customer_email: "buyer@example.com",
      redirect_url: "http://127.0.0.1:4000/callback",
    }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ transaction: { id: string; tx_ref: string; status: string }; link: string }>;
}

function submitJson(endpoint: string, body: unknown) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

type CapturedRequest = {
  path: string;
  headers: IncomingMessage["headers"];
  rawBody: string;
};

async function startTestReceiver(
  t: TestContext,
  handler: (req: CapturedRequest, res: ServerResponse) => void,
) {
  const received: CapturedRequest[] = [];
  const waiters: Array<() => void> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const captured = {
        path: req.url ?? "/",
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(captured);
      handler(captured, res);
      while (waiters.length > 0) waiters.shift()!();
    });
  });
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");

  async function waitForCount(count: number, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${count} webhook(s); got ${received.length}`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(remaining, 100));
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    waitForCount,
  };
}

test("webhook HMAC signing and verification", () => {
  const secret = "fp_whsec_test_" + "a".repeat(64);
  const payload = JSON.stringify({ id: "evt_123", event: WEBHOOK_EVENT_CHARGE_COMPLETED, data: { status: "successful" } });
  const now = new Date("2026-11-21T12:00:00.000Z");
  const ts = Math.floor(now.getTime() / 1000);
  const signed = signWebhookPayload(payload, secret, ts);

  // Independent reference check against raw node:crypto HMAC-SHA256("${timestamp}.${payload}")
  const expectedDigest = createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  assert.equal(signed.digest, expectedDigest);
  assert.equal(signed.signature, `t=${ts},v1=${expectedDigest}`);

  assert.deepEqual(
    verifyWebhookSignature({ payload, header: signed.signature, secret, now }),
    { valid: true, timestamp: ts },
  );

  // Tampered payload fails
  const tampered = payload.replace("successful", "failed");
  assert.equal(verifyWebhookSignature({ payload: tampered, header: signed.signature, secret, now }).valid, false);

  // Wrong secret fails
  assert.equal(
    verifyWebhookSignature({ payload, header: signed.signature, secret: "fp_whsec_test_" + "b".repeat(64), now }).valid,
    false,
  );

  // Malformed headers fail
  for (const badHeader of ["", "v1=deadbeef", "t=abc,v1=" + "a".repeat(64), `t=${ts},v1=not-hex`, `t=${ts},t=${ts},v1=${signed.digest}`]) {
    assert.equal(verifyWebhookSignature({ payload, header: badHeader, secret, now }).valid, false, badHeader);
  }

  // Expired timestamp fails (outside 5-minute tolerance window)
  const sixMinutesLater = new Date(now.getTime() + 6 * 60_000);
  assert.equal(
    verifyWebhookSignature({ payload, header: signed.signature, secret, now: sixMinutesLater }).valid,
    false,
  );
});

test("webhook configuration, delivery, retries, recovery and isolation", async t => {
  const db = await testDatabase(t);

  await t.test("configures, rotates and clears merchant webhook settings and returns secret only on issue/rotation", async t => {
    const url = await testServer(t, db);
    const merchant = await registerMerchant(url, "wh-config@example.com");

    const initial = await fetch(`${url}/v1/merchants/me/webhook`, {
      headers: { Authorization: `Bearer ${merchant.keys.secret_key}` },
    });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.deepEqual(await initial.json(), { webhook: { url: null, secret_configured: false } });

    const setRes = await configureWebhook(url, merchant.keys.secret_key, { webhook_url: "http://127.0.0.1:4500/hook" });
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(setBody.webhook.url, "http://127.0.0.1:4500/hook");
    assert.equal(setBody.webhook.secret_configured, true);
    assert.match(setBody.webhook.secret, /^fp_whsec_test_[a-f0-9]{64}$/);

    // GET hides the secret
    const afterSet = await (await fetch(`${url}/v1/merchants/me/webhook`, {
      headers: { Authorization: `Bearer ${merchant.keys.secret_key}` },
    })).json();
    assert.deepEqual(afterSet, { webhook: { url: "http://127.0.0.1:4500/hook", secret_configured: true } });

    // Routine URL update preserves secret in DB without re-exposing it in response
    const keepSecret = await (await configureWebhook(url, merchant.keys.secret_key, {
      webhook_url: "http://127.0.0.1:4500/hook-v2",
    })).json();
    assert.deepEqual(keepSecret, {
      webhook: { url: "http://127.0.0.1:4500/hook-v2", secret: null, secret_configured: true },
    });
    const storedBeforeRotate = await db.merchant.findUniqueOrThrow({ where: { id: merchant.merchant.id } });
    assert.equal(storedBeforeRotate.webhookSecret, setBody.webhook.secret);

    const rotated = await (await configureWebhook(url, merchant.keys.secret_key, {
      webhook_url: "http://127.0.0.1:4500/hook-v2",
      rotate_secret: true,
    })).json();
    assert.equal(rotated.webhook.secret_configured, true);
    assert.match(rotated.webhook.secret, /^fp_whsec_test_[a-f0-9]{64}$/);
    assert.notEqual(rotated.webhook.secret, setBody.webhook.secret);

    // Invalid URLs are rejected
    for (const bad of ["javascript:alert(1)", "ftp://example.com/hook", "https://user:pass@example.com/hook", ""]) {
      const badRes = await configureWebhook(url, merchant.keys.secret_key, { webhook_url: bad });
      assert.equal(badRes.status, 400);
      assert.equal((await badRes.json()).error.code, "INVALID_INPUT");
    }

    // Disabling with null clears URL and secret
    const cleared = await (await configureWebhook(url, merchant.keys.secret_key, { webhook_url: null })).json();
    assert.deepEqual(cleared, { webhook: { url: null, secret: null, secret_configured: false } });
  });

  await t.test("delivers signed charge.completed webhooks on approve, OTP completion and decline", async t => {
    const fixedNow = new Date("2026-11-21T12:00:00.000Z");
    const tracker = createWebhookTracker();
    const url = await testServer(t, db, { now: () => fixedNow, webhookTracker: tracker });
    const receiver = await startTestReceiver(t, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"received":true}');
    });

    const merchant = await registerMerchant(url, "wh-live@example.com");
    const wh = await (await configureWebhook(url, merchant.keys.secret_key, { webhook_url: receiver.url })).json();
    const secret: string = wh.webhook.secret;

    // 1. Direct approve
    const approveTx = await createTestPayment(url, merchant.keys.secret_key, "wh-approve", 500_000);
    assert.equal(
      (await submitJson(`${url}/pay/${approveTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.APPROVE,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );
    await tracker.drain();

    assert.equal(receiver.received.length, 1);
    const first = receiver.received[0]!;
    assert.equal(first.headers["x-flutterpay-event"], WEBHOOK_EVENT_CHARGE_COMPLETED);
    const sigHeader = String(first.headers["x-flutterpay-signature"] ?? "");
    assert.equal(verifyWebhookSignature({ payload: first.rawBody, header: sigHeader, secret, now: fixedNow }).valid, true);
    const firstPayload = JSON.parse(first.rawBody);
    assert.equal(firstPayload.id, first.headers["x-flutterpay-event-id"]);
    assert.equal(firstPayload.event, WEBHOOK_EVENT_CHARGE_COMPLETED);
    assert.equal(firstPayload.data.id, approveTx.transaction.id);
    assert.equal(firstPayload.data.status, "successful");
    assert.equal(firstPayload.data.amount_kobo, 500_000);

    // 2. OTP flow (should NOT deliver on awaiting_otp, ONLY after valid OTP)
    const otpTx = await createTestPayment(url, merchant.keys.secret_key, "wh-otp", 250_000);
    assert.equal(
      (await submitJson(`${url}/pay/${otpTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.OTP,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );
    assert.equal(await db.webhookDelivery.count({ where: { transactionId: otpTx.transaction.id } }), 0);

    assert.equal((await submitJson(`${url}/pay/${otpTx.transaction.id}/otp`, { otp: TEST_OTP })).status, 200);
    await tracker.drain();
    assert.equal(receiver.received.length, 2);
    const secondPayload = JSON.parse(receiver.received[1]!.rawBody);
    assert.equal(secondPayload.data.id, otpTx.transaction.id);
    assert.equal(secondPayload.data.status, "successful");

    // 3. Decline card
    const declineTx = await createTestPayment(url, merchant.keys.secret_key, "wh-decline", 150_000);
    assert.equal(
      (await submitJson(`${url}/pay/${declineTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.DECLINE_BLOCKED,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );
    await tracker.drain();
    const thirdPayload = JSON.parse(receiver.received[2]!.rawBody);
    assert.equal(thirdPayload.data.id, declineTx.transaction.id);
    assert.equal(thirdPayload.data.status, "failed");
    assert.equal(thirdPayload.data.failure_reason, "Card blocked");

    // 4. 3 wrong OTPs
    const otpFailTx = await createTestPayment(url, merchant.keys.secret_key, "wh-otp-fail", 100_000);
    await submitJson(`${url}/pay/${otpFailTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.OTP,
      expiry: "12/30",
      cvv: "123",
    });
    await submitJson(`${url}/pay/${otpFailTx.transaction.id}/otp`, { otp: "111111" });
    await submitJson(`${url}/pay/${otpFailTx.transaction.id}/otp`, { otp: "222222" });
    await submitJson(`${url}/pay/${otpFailTx.transaction.id}/otp`, { otp: "333333" });
    await tracker.drain();
    const fourthPayload = JSON.parse(receiver.received[3]!.rawBody);
    assert.equal(fourthPayload.data.id, otpFailTx.transaction.id);
    assert.equal(fourthPayload.data.status, "failed");
    assert.equal(fourthPayload.data.failure_reason, "Too many invalid OTP attempts");

    const listRes = await fetch(`${url}/v1/webhooks/deliveries?transaction_id=${approveTx.transaction.id}`, {
      headers: { Authorization: `Bearer ${merchant.keys.secret_key}` },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.deliveries.length, 1);
    assert.equal(listBody.deliveries[0].status, "delivered");
    assert.equal(listBody.deliveries[0].response_code, 200);
    assert.equal(listBody.deliveries[0].attempt, 1);
    assert.equal(listBody.deliveries[0].next_retry_at, null);
  });

  await t.test("retries after 1, 5 and 30 minutes with identical event_id and stops after 4 attempts", async t => {
    let currentTime = new Date("2026-11-21T12:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime, autoDeliverWebhooks: false });

    const seenEventIds: string[] = [];
    const seenBodies: string[] = [];
    let attemptResponses = [500, 503, 302, 200];
    const receiver = await startTestReceiver(t, (req, res) => {
      seenEventIds.push(String(req.headers["x-flutterpay-event-id"]));
      seenBodies.push(req.rawBody);
      const status = attemptResponses.shift() ?? 200;
      res.writeHead(status, status === 302 ? { Location: "http://127.0.0.1:9999/elsewhere" } : {});
      res.end();
    });

    const merchant = await registerMerchant(url, "wh-retry@example.com");
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: receiver.url });

    const tx = await createTestPayment(url, merchant.keys.secret_key, "wh-retry-succeeds");
    assert.equal(
      (await submitJson(`${url}/pay/${tx.transaction.id}/charge`, {
        card_number: TEST_CARDS.APPROVE,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );

    // Attempt 1 at T+0 -> 500, schedules attempt 2 at T+1m
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 1);
    let rows = await db.webhookDelivery.findMany({ where: { transactionId: tx.transaction.id }, orderBy: { attempt: "asc" } });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.status, "FAILED");
    assert.equal(rows[0]!.responseCode, 500);
    assert.equal(rows[0]!.nextRetryAt?.toISOString(), "2026-11-21T12:01:00.000Z");
    assert.equal(rows[1]!.status, "PENDING");
    assert.equal(rows[1]!.attempt, 2);
    assert.equal(rows[1]!.nextRetryAt?.toISOString(), "2026-11-21T12:01:00.000Z");

    // Before T+1m, nothing is due
    currentTime = new Date("2026-11-21T12:00:59.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 0);

    // Attempt 2 at T+1m -> 503, schedules attempt 3 at T+6m (+5m)
    currentTime = new Date("2026-11-21T12:01:00.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 1);
    rows = await db.webhookDelivery.findMany({ where: { transactionId: tx.transaction.id }, orderBy: { attempt: "asc" } });
    assert.equal(rows[1]!.status, "FAILED");
    assert.equal(rows[1]!.responseCode, 503);
    assert.equal(rows[2]!.attempt, 3);
    assert.equal(rows[2]!.nextRetryAt?.toISOString(), "2026-11-21T12:06:00.000Z");

    // Attempt 3 at T+6m -> 302 (redirects not followed), schedules attempt 4 at T+36m (+30m)
    currentTime = new Date("2026-11-21T12:06:00.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 1);
    rows = await db.webhookDelivery.findMany({ where: { transactionId: tx.transaction.id }, orderBy: { attempt: "asc" } });
    assert.equal(rows[2]!.status, "FAILED");
    assert.equal(rows[2]!.responseCode, 302);
    assert.equal(rows[3]!.attempt, 4);
    assert.equal(rows[3]!.nextRetryAt?.toISOString(), "2026-11-21T12:36:00.000Z");

    // Attempt 4 at T+36m -> 200 OK -> delivered, no more retries
    currentTime = new Date("2026-11-21T12:36:00.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 1);
    rows = await db.webhookDelivery.findMany({ where: { transactionId: tx.transaction.id }, orderBy: { attempt: "asc" } });
    assert.equal(rows.length, 4);
    assert.equal(rows[3]!.status, "DELIVERED");
    assert.equal(rows[3]!.responseCode, 200);
    assert.equal(rows[3]!.nextRetryAt, null);

    // Every retry carried the exact same event ID and raw payload bytes for receiver deduplication
    assert.equal(new Set(seenEventIds).size, 1);
    assert.equal(new Set(seenBodies).size, 1);

    // Second scenario: all 4 attempts fail -> stops permanently at attempt 4
    attemptResponses = [500, 500, 500, 500];
    currentTime = new Date("2026-11-21T13:00:00.000Z");
    const doomedTx = await createTestPayment(url, merchant.keys.secret_key, "wh-retry-exhausted");
    await submitJson(`${url}/pay/${doomedTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });

    for (const nextTime of [
      "2026-11-21T13:00:00.000Z",
      "2026-11-21T13:01:00.000Z",
      "2026-11-21T13:06:00.000Z",
      "2026-11-21T13:36:00.000Z",
    ]) {
      currentTime = new Date(nextTime);
      assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 1);
    }

    const exhausted = await db.webhookDelivery.findMany({
      where: { transactionId: doomedTx.transaction.id },
      orderBy: { attempt: "asc" },
    });
    assert.equal(exhausted.length, 4);
    assert.equal(exhausted[3]!.status, "FAILED");
    assert.equal(exhausted[3]!.nextRetryAt, null);
    currentTime = new Date("2026-11-21T15:00:00.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 0);
  });

  await t.test("recovers expired PROCESSING claims, guards claim ownership and handles thrown senders", async t => {
    let currentTime = new Date("2026-11-21T14:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime, autoDeliverWebhooks: false });
    const merchant = await registerMerchant(url, "wh-recover@example.com");
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: "http://127.0.0.1:4999/hook" });

    // 1. Simulated crash leaving a row stuck in PROCESSING with an expired lease -> recovered and delivered
    const tx1 = await createTestPayment(url, merchant.keys.secret_key, "wh-stuck-tx");
    await submitJson(`${url}/pay/${tx1.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const stuckRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: tx1.transaction.id } });
    await db.webhookDelivery.update({
      where: { id: stuckRow.id },
      data: {
        status: "PROCESSING",
        claimToken: "crashed-worker-token",
        claimExpiresAt: new Date("2026-11-21T14:00:30.000Z"),
      },
    });

    // While lease is active, worker skips it
    currentTime = new Date("2026-11-21T14:00:20.000Z");
    assert.equal(await processDueWebhooks(db, { now: () => currentTime }), 0);

    // Once lease expires, worker reclaims and delivers it
    currentTime = new Date("2026-11-21T14:00:30.000Z");
    let deliveredCount = 0;
    assert.equal(
      await processDueWebhooks(db, {
        now: () => currentTime,
        sender: async () => {
          deliveredCount += 1;
          return { ok: true, statusCode: 200, errorMessage: null };
        },
      }),
      1,
    );
    assert.equal(deliveredCount, 1);
    const recovered = await db.webhookDelivery.findUniqueOrThrow({ where: { id: stuckRow.id } });
    assert.equal(recovered.status, "DELIVERED");
    assert.equal(recovered.claimToken, null);
    assert.equal(recovered.claimExpiresAt, null);

    // 2. Stale worker finishing after lease expiry cannot overwrite a newer worker's result
    currentTime = new Date("2026-11-21T14:10:00.000Z");
    const tx2 = await createTestPayment(url, merchant.keys.secret_key, "wh-stale-owner");
    await submitJson(`${url}/pay/${tx2.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const raceRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: tx2.transaction.id } });

    let releaseSlowWorker!: () => void;
    const slowStarted = new Promise<void>(resolve => {
      void deliverWebhookAttempt(db, raceRow.id, {
        now: () => currentTime,
        claimLeaseMs: 1_000,
        sender: async () => {
          resolve();
          await new Promise<void>(r => {
            releaseSlowWorker = r;
          });
          return { ok: false, statusCode: 500, errorMessage: "Stale HTTP 500" };
        },
      });
    });
    await slowStarted;

    // Lease expires and fast worker reclaims and succeeds
    currentTime = new Date("2026-11-21T14:10:02.000Z");
    assert.equal(
      await deliverWebhookAttempt(db, raceRow.id, {
        now: () => currentTime,
        sender: async () => ({ ok: true, statusCode: 200, errorMessage: null }),
      }),
      true,
    );
    // Now slow worker finishes with a failure — must NOT overwrite DELIVERED or schedule attempt 2
    releaseSlowWorker();
    await new Promise(r => setTimeout(r, 30));

    const raceRows = await db.webhookDelivery.findMany({ where: { transactionId: tx2.transaction.id } });
    assert.equal(raceRows.length, 1);
    assert.equal(raceRows[0]!.status, "DELIVERED");
    assert.equal(raceRows[0]!.responseCode, 200);

    // 3. Thrown sender records FAILED + schedules retry instead of leaving row stuck in PROCESSING
    currentTime = new Date("2026-11-21T14:20:00.000Z");
    const tx3 = await createTestPayment(url, merchant.keys.secret_key, "wh-thrown-sender");
    await submitJson(`${url}/pay/${tx3.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const thrownRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: tx3.transaction.id } });
    await deliverWebhookAttempt(db, thrownRow.id, {
      now: () => currentTime,
      sender: async () => {
        throw new Error("boom");
      },
    });
    const afterThrow = await db.webhookDelivery.findMany({
      where: { transactionId: tx3.transaction.id },
      orderBy: { attempt: "asc" },
    });
    assert.equal(afterThrow.length, 2);
    assert.equal(afterThrow[0]!.status, "FAILED");
    assert.equal(afterThrow[0]!.errorMessage, "Webhook sender error");
    assert.equal(afterThrow[1]!.status, "PENDING");
  });

  await t.test("handles HTTP timeouts, network errors, URL/secret updates and disabling pending retries", async t => {
    const fixedNow = new Date("2026-11-21T15:00:00.000Z");
    const url = await testServer(t, db, { now: () => fixedNow, autoDeliverWebhooks: false });
    const merchant = await registerMerchant(url, "wh-net@example.com");

    // 1. Timeout receiver (delays response longer than timeoutMs)
    const slowReceiver = await startTestReceiver(t, (_req, res) => {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end();
        }
      }, 400);
      timer.unref();
    });
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: `${slowReceiver.baseUrl}/slow` });
    const timeoutTx = await createTestPayment(url, merchant.keys.secret_key, "wh-timeout");
    await submitJson(`${url}/pay/${timeoutTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const timeoutRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: timeoutTx.transaction.id } });
    await deliverWebhookAttempt(db, timeoutRow.id, { now: () => fixedNow, timeoutMs: 50 });
    const afterTimeout = await db.webhookDelivery.findUniqueOrThrow({ where: { id: timeoutRow.id } });
    assert.equal(afterTimeout.status, "FAILED");
    assert.equal(afterTimeout.responseCode, null);
    assert.equal(afterTimeout.errorMessage, "Request timed out");

    // 2. Network error (closed localhost port)
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: "http://127.0.0.1:1/unreachable" });
    const netTx = await createTestPayment(url, merchant.keys.secret_key, "wh-neterr");
    await submitJson(`${url}/pay/${netTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const netRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: netTx.transaction.id } });
    await deliverWebhookAttempt(db, netRow.id, { now: () => fixedNow });
    const afterNet = await db.webhookDelivery.findUniqueOrThrow({ where: { id: netRow.id } });
    assert.equal(afterNet.status, "FAILED");
    assert.equal(afterNet.responseCode, null);
    assert.equal(afterNet.errorMessage, "Network delivery error");

    // 3. Updating URL + rotating secret sends queued retry to NEW URL signed with NEW secret
    const multiReceiver = await startTestReceiver(t, (_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: `${multiReceiver.baseUrl}/old` });
    const migrateTx = await createTestPayment(url, merchant.keys.secret_key, "wh-migrate");
    await submitJson(`${url}/pay/${migrateTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    const rotated = await (await configureWebhook(url, merchant.keys.secret_key, {
      webhook_url: `${multiReceiver.baseUrl}/new`,
      rotate_secret: true,
    })).json();
    const migrateRow = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: migrateTx.transaction.id } });
    await deliverWebhookAttempt(db, migrateRow.id, { now: () => fixedNow });
    assert.equal(multiReceiver.received.length, 1);
    assert.equal(multiReceiver.received[0]!.path, "/new");
    assert.equal(
      verifyWebhookSignature({
        payload: multiReceiver.received[0]!.rawBody,
        header: String(multiReceiver.received[0]!.headers["x-flutterpay-signature"] ?? ""),
        secret: rotated.webhook.secret,
        now: fixedNow,
      }).valid,
      true,
    );

    // 4. Disabling webhooks cancels pending deliveries for that merchant
    const cancelTx = await createTestPayment(url, merchant.keys.secret_key, "wh-cancel");
    await submitJson(`${url}/pay/${cancelTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    await configureWebhook(url, merchant.keys.secret_key, { webhook_url: null });
    const cancelled = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: cancelTx.transaction.id } });
    assert.equal(cancelled.status, "FAILED");
    assert.equal(cancelled.errorMessage, "Webhooks disabled by merchant");
    assert.equal(cancelled.nextRetryAt, null);
  });

  await t.test("handles concurrent claim safely, drains worker shutdown and isolates delivery logs", async t => {
    const fixedNow = new Date("2026-11-21T16:00:00.000Z");
    const tracker = createWebhookTracker();
    const url = await testServer(t, db, { now: () => fixedNow, autoDeliverWebhooks: false, webhookTracker: tracker });
    const merchantA = await registerMerchant(url, "wh-iso-a@example.com");
    const merchantB = await registerMerchant(url, "wh-iso-b@example.com");

    await configureWebhook(url, merchantA.keys.secret_key, { webhook_url: "http://127.0.0.1:4999/unused" });
    const txA = await createTestPayment(url, merchantA.keys.secret_key, "wh-iso-tx");
    await submitJson(`${url}/pay/${txA.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });

    const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { transactionId: txA.transaction.id } });
    let sendCalls = 0;
    const fakeSender = async () => {
      sendCalls += 1;
      return { ok: true, statusCode: 200, errorMessage: null };
    };

    const claims = await Promise.all([
      deliverWebhookAttempt(db, delivery.id, { now: () => fixedNow, sender: fakeSender }),
      deliverWebhookAttempt(db, delivery.id, { now: () => fixedNow, sender: fakeSender }),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal(sendCalls, 1);

    // Worker stop drains tracked deliveries cleanly
    let drained = false;
    tracker.track(
      new Promise<void>(resolve => setTimeout(() => {
        drained = true;
        resolve();
      }, 25)),
      "drain-test",
    );
    const worker = startWebhookWorker(db, { intervalMs: 60_000, tracker });
    await worker.stop();
    assert.equal(drained, true);

    // Merchant B sees zero deliveries even when querying Merchant A's transaction_id
    const bList = await (await fetch(`${url}/v1/webhooks/deliveries?transaction_id=${txA.transaction.id}`, {
      headers: { Authorization: `Bearer ${merchantB.keys.secret_key}` },
    })).json();
    assert.deepEqual(bList.deliveries, []);
    assert.equal(bList.pagination.total, 0);

    // Invalid query params & public key are rejected
    const badQuery = await fetch(`${url}/v1/webhooks/deliveries?page=0`, {
      headers: { Authorization: `Bearer ${merchantA.keys.secret_key}` },
    });
    assert.equal(badQuery.status, 400);
    assert.equal((await badQuery.json()).error.code, "INVALID_INPUT");

    const pubKey = await fetch(`${url}/v1/webhooks/deliveries`, {
      headers: { Authorization: `Bearer ${merchantA.keys.public_key}` },
    });
    assert.equal(pubKey.status, 401);
  });
});

test("webhook enqueue failure rolls back payment completion atomically and redacts DB errors", async t => {
  const db = await testDatabase(t);
  const url = await testServer(t, db, { autoDeliverWebhooks: false });
  const merchant = await registerMerchant(url, "wh-rollback@example.com");
  await configureWebhook(url, merchant.keys.secret_key, { webhook_url: "http://127.0.0.1:4999/hook" });
  const tx = await createTestPayment(url, merchant.keys.secret_key, "wh-atomic-rollback");

  // Drop WebhookDelivery so enqueue fails inside the checkout completion transaction.
  await db.$executeRawUnsafe('DROP TABLE "WebhookDelivery"');

  const chargeRes = await submitJson(`${url}/pay/${tx.transaction.id}/charge`, {
    card_number: TEST_CARDS.APPROVE,
    expiry: "12/30",
    cvv: "123",
  });
  assert.equal(chargeRes.status, 500);
  assert.deepEqual(await chargeRes.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });

  // Payment must have rolled back to PENDING rather than finishing without a webhook outbox row.
  const storedTx = await db.transaction.findUniqueOrThrow({ where: { id: tx.transaction.id } });
  assert.equal(storedTx.status, "PENDING");
  assert.equal(storedTx.cardLast4, null);

  const deliveriesRes = await fetch(`${url}/v1/webhooks/deliveries`, {
    headers: { Authorization: `Bearer ${merchant.keys.secret_key}` },
  });
  assert.equal(deliveriesRes.status, 500);
  assert.deepEqual(await deliveriesRes.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
});

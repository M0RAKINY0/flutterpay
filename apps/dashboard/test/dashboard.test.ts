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
import { createDashboardApp } from "../src/app.js";

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
  if (!addr || typeof addr === "string") throw new Error("Expected TCP address");
  const { port } = addr;
  await new Promise<void>((res, rej) => srv.close(err => (err ? rej(err) : res())));
  return port;
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof spawn>, stderrRef: { value: string }) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API exited early (code=${child.exitCode}, signal=${child.signalCode}): ${stderrRef.value}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Booting
    }
    await new Promise(r => setTimeout(r, 75));
  }
  throw new Error(`Timed out waiting for API at ${baseUrl}. stderr: ${stderrRef.value}`);
}

async function startApiServer(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flutterpay-dash-test-"));
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

async function startDashboardServer(t: TestContext, apiBaseUrl: string): Promise<string> {
  const server = createDashboardApp({ apiBaseUrl }).listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise<void>((res, rej) => {
        server.closeAllConnections();
        server.close(err => (err ? rej(err) : res()));
      }),
  );
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return `http://127.0.0.1:${addr.port}`;
}

function extractCookieHeader(response: Response): string {
  const raw = response.headers.getSetCookie().find(c => c.startsWith("fp_session="));
  assert.ok(raw, "Expected fp_session Set-Cookie header");
  return raw.split(";")[0]!;
}

function extractCsrfToken(html: string): string {
  const match = /name="_csrf"\s+value="([a-f0-9]{64})"/i.exec(html);
  assert.ok(match?.[1], "Expected hidden _csrf token in HTML");
  return match[1];
}

test("merchant dashboard end-to-end: login, transactions, webhooks, CSRF, and immediate key replacement", async t => {
  const apiUrl = await startApiServer(t);
  const dashUrl = await startDashboardServer(t, apiUrl);

  // 1. Health + unauthenticated redirects + security headers.
  const health = await fetch(`${dashUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  for (const path of ["/", "/transactions", "/webhooks", "/keys"]) {
    const res = await fetch(`${dashUrl}${path}`, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/login");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }

  // 2. Sign up via dashboard (with XSS chars in business name) creates account, sets cookie, displays keys once.
  const signupRes = await fetch(`${dashUrl}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      business_name: `Ada <script>alert(1)</script> Store`,
      email: "ada@example.com",
      password: "a-long-dashboard-password",
    }),
    redirect: "manual",
  });
  assert.equal(signupRes.status, 201);
  const signupHtml = await signupRes.text();
  assert.ok(!signupHtml.includes("<script>alert(1)</script>"), "business_name must be HTML-escaped");
  assert.ok(signupHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));

  const initialSecretMatch = /fp_sec_test_[a-f0-9]{64}/.exec(signupHtml);
  assert.ok(initialSecretMatch, "signup view should display initial secret key once");
  const initialSecretKey = initialSecretMatch[0];

  const signupCookie = extractCookieHeader(signupRes);
  const signupCsrf = extractCsrfToken(signupHtml);

  // Log out, verify old cookie no longer works, then log back in via /login.
  const logoutRes = await fetch(`${dashUrl}/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: signupCookie,
    },
    body: new URLSearchParams({ _csrf: signupCsrf }),
    redirect: "manual",
  });
  assert.equal(logoutRes.status, 303);
  assert.equal(logoutRes.headers.get("location"), "/login?logged_out=1");

  const afterLogout = await fetch(`${dashUrl}/transactions`, {
    headers: { Cookie: signupCookie },
    redirect: "manual",
  });
  assert.equal(afterLogout.status, 303);
  assert.equal(afterLogout.headers.get("location"), "/login");

  // Bad login does not echo password.
  const badLogin = await fetch(`${dashUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "ada@example.com", password: "secret-wrong-password" }),
    redirect: "manual",
  });
  assert.equal(badLogin.status, 401);
  const badLoginHtml = await badLogin.text();
  assert.ok(!badLoginHtml.includes("secret-wrong-password"));

  // Valid login succeeds and sets fresh session cookie.
  const loginRes = await fetch(`${dashUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "ada@example.com", password: "a-long-dashboard-password" }),
    redirect: "manual",
  });
  assert.equal(loginRes.status, 303);
  assert.equal(loginRes.headers.get("location"), "/transactions");
  const sessionCookie = extractCookieHeader(loginRes);

  // 3. Configure webhook URL via dashboard (and verify CSRF + cross-origin protections).
  const webhooksPageRes = await fetch(`${dashUrl}/webhooks`, {
    headers: { Cookie: sessionCookie },
    redirect: "manual",
  });
  assert.equal(webhooksPageRes.status, 200);
  const csrfToken = extractCsrfToken(await webhooksPageRes.text());

  const badCsrfWebhook = await fetch(`${dashUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: sessionCookie },
    body: new URLSearchParams({ _csrf: "bad", webhook_url: "http://127.0.0.1:4000/hook", action: "save" }),
    redirect: "manual",
  });
  assert.equal(badCsrfWebhook.status, 403);

  const crossOriginPost = await fetch(`${dashUrl}/webhooks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessionCookie,
      Origin: "https://evil.example",
    },
    body: new URLSearchParams({ _csrf: csrfToken, webhook_url: "http://127.0.0.1:4000/hook", action: "save" }),
    redirect: "manual",
  });
  assert.equal(crossOriginPost.status, 403);

  // Start local webhook receiver so we can see a real delivered attempt in the dashboard.
  let resolveDelivered!: () => void;
  const webhookDelivered = new Promise<void>(r => {
    resolveDelivered = r;
  });
  const receiver = createHttpServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    resolveDelivered();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(
    () =>
      new Promise<void>((res, rej) => {
        receiver.closeAllConnections();
        receiver.close(err => (err ? rej(err) : res()));
      }),
  );
  const receiverAddr = receiver.address();
  assert.ok(receiverAddr && typeof receiverAddr !== "string");
  const receiverUrl = `http://127.0.0.1:${receiverAddr.port}/hook`;

  const saveWebhookRes = await fetch(`${dashUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: sessionCookie },
    body: new URLSearchParams({ _csrf: csrfToken, webhook_url: receiverUrl, action: "save" }),
    redirect: "manual",
  });
  assert.equal(saveWebhookRes.status, 200);
  const saveWebhookHtml = await saveWebhookRes.text();
  assert.match(saveWebhookHtml, /fp_whsec_test_[a-f0-9]{64}/);
  assert.ok(saveWebhookHtml.includes(receiverUrl));

  // 4. Create and pay a transaction using Merchant A's secret key, then verify it shows up in dashboard.
  const paymentRes = await fetch(`${apiUrl}/v1/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${initialSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tx_ref: "dash-order-1",
      amount_kobo: 750_000,
      currency: "NGN",
      customer_email: "shopper@example.com",
      redirect_url: "http://127.0.0.1:4000/cb",
    }),
  });
  assert.equal(paymentRes.status, 201);
  const payment = (await paymentRes.json()) as { transaction: { id: string }; link: string };

  const chargeRes = await fetch(`${payment.link}/charge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ card_number: "4242 4242 4242 4242", expiry: "12/30", cvv: "123" }),
  });
  assert.equal(chargeRes.status, 200);
  await Promise.race([
    webhookDelivered,
    new Promise<never>((_r, rej) => setTimeout(() => rej(new Error("Webhook not delivered")), 5_000)),
  ]);

  const txPage = await fetch(`${dashUrl}/transactions?period=daily`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(txPage.status, 200);
  const txHtml = await txPage.text();
  assert.ok(txHtml.includes("dash-order-1"));
  assert.ok(txHtml.includes("₦7,500.00"));
  assert.ok(txHtml.includes("shopper@example.com"));

  // Poll briefly for delivery row to reflect delivered status in dashboard /webhooks.
  let deliveriesHtml = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${dashUrl}/webhooks?transaction_id=${encodeURIComponent(payment.transaction.id)}`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    deliveriesHtml = await res.text();
    if (deliveriesHtml.includes("delivered") && deliveriesHtml.includes("HTTP 200")) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(deliveriesHtml.includes("charge.completed"));
  assert.ok(deliveriesHtml.includes("delivered"));
  assert.ok(deliveriesHtml.includes("HTTP 200"));

  // 5. Phase 7 done-when check: replace a leaked secret key via dashboard -> old key stops working immediately!
  const keysPage = await fetch(`${dashUrl}/keys`, { headers: { Cookie: sessionCookie } });
  assert.equal(keysPage.status, 200);
  const keysCsrf = extractCsrfToken(await keysPage.text());

  const rotateRes = await fetch(`${dashUrl}/keys/rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: sessionCookie },
    body: new URLSearchParams({ _csrf: keysCsrf, kind: "secret" }),
    redirect: "manual",
  });
  assert.equal(rotateRes.status, 200);
  const rotateHtml = await rotateRes.text();
  const newSecretMatch = /fp_sec_test_[a-f0-9]{64}/.exec(rotateHtml);
  assert.ok(newSecretMatch, "keys page should show newly rotated secret key once");
  const newSecretKey = newSecretMatch[0];
  assert.notEqual(newSecretKey, initialSecretKey);
  assert.ok(rotateHtml.includes("revoked"));

  // Replaced secret key fails immediately with 401.
  const oldKeyAttempt = await fetch(`${apiUrl}/v1/merchants/me`, {
    headers: { Authorization: `Bearer ${initialSecretKey}` },
  });
  assert.equal(oldKeyAttempt.status, 401);

  // Replacement secret key succeeds immediately.
  const newKeyAttempt = await fetch(`${apiUrl}/v1/merchants/me`, {
    headers: { Authorization: `Bearer ${newSecretKey}` },
  });
  assert.equal(newKeyAttempt.status, 200);
});

test("dashboard resilience: preserves sessions on API 500, fails honestly on logout 500, never drops issued secrets, and enforces per-client login rate limit", async t => {
  const sessionToken = "a".repeat(64);
  const csrfToken = "b".repeat(64);
  const sampleSession = {
    session: { id: "sess_1", expires_at: "2026-11-23T10:00:00.000Z", csrf_token: csrfToken },
    merchant: { id: "m_1", business_name: "Resilient Co", email: "resilient@example.com" },
  };
  const cookieHeader = `fp_session=${sessionToken}`;

  type RouteBehavior = (url: string, init?: RequestInit) => Response | Promise<Response>;
  let handler: RouteBehavior = () => new Response(JSON.stringify(sampleSession), { status: 200 });

  const server = createDashboardApp({
    apiBaseUrl: "http://api.internal.test",
    proxySecret: "shared-proxy-secret",
    fetch: async (input, init) => handler(String(input), init),
  }).listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise<void>((res, rej) => {
        server.closeAllConnections();
        server.close(err => (err ? rej(err) : res()));
      }),
  );
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const dashUrl = `http://127.0.0.1:${addr.port}`;

  // 1. Transient API 500 on session check returns 502 and does NOT clear the browser cookie.
  handler = url => {
    if (url.endsWith("/v1/sessions/me")) {
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "db busy" } }), { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };
  const session500 = await fetch(`${dashUrl}/transactions`, {
    headers: { Cookie: cookieHeader },
    redirect: "manual",
  });
  assert.equal(session500.status, 502);
  assert.equal(session500.headers.getSetCookie().length, 0, "must not clear valid session cookie on API 500");

  // 2. Logout upstream 500 returns 502 and does NOT clear cookie or redirect to logged_out=1.
  handler = url => {
    if (url.endsWith("/v1/sessions/logout")) {
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "db busy" } }), { status: 500 });
    }
    return new Response(JSON.stringify(sampleSession), { status: 200 });
  };
  const logout500 = await fetch(`${dashUrl}/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: new URLSearchParams({ _csrf: csrfToken }),
    redirect: "manual",
  });
  assert.equal(logout500.status, 502);
  assert.equal(logout500.headers.getSetCookie().length, 0);

  // Logout when session is already invalid (401) clears cookie and redirects to logged_out=1.
  handler = url => {
    if (url.endsWith("/v1/sessions/logout")) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired" } }), { status: 401 });
    }
    return new Response("{}", { status: 200 });
  };
  const logout401 = await fetch(`${dashUrl}/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: new URLSearchParams({ _csrf: csrfToken }),
    redirect: "manual",
  });
  assert.equal(logout401.status, 303);
  assert.equal(logout401.headers.get("location"), "/login?logged_out=1");
  assert.match(logout401.headers.getSetCookie().join(";"), /Max-Age=0/);

  // 3. Key rotation still displays newly issued secret key when follow-up GET /v1/merchants/me/keys throws.
  const rotatedSecret = `fp_sec_test_${"9".repeat(64)}`;
  handler = (url, init) => {
    if (url.endsWith("/v1/sessions/me")) {
      return new Response(JSON.stringify(sampleSession), { status: 200 });
    }
    if (url.endsWith("/v1/merchants/me/keys/rotate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          key: { id: "k_new", kind: "secret", prefix: rotatedSecret.slice(0, 20), value: rotatedSecret, created_at: "2026-11-22T12:00:00.000Z" },
          revoked_count: 1,
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/merchants/me/keys")) {
      throw new TypeError("simulated network blip");
    }
    return new Response("{}", { status: 200 });
  };
  const rotateRes = await fetch(`${dashUrl}/keys/rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: new URLSearchParams({ _csrf: csrfToken, kind: "secret" }),
    redirect: "manual",
  });
  assert.equal(rotateRes.status, 200);
  const rotateHtml = await rotateRes.text();
  assert.ok(rotateHtml.includes(rotatedSecret), "replacement secret key must still be shown");
  assert.ok(rotateHtml.includes("key history could not be loaded"));

  // 4. Webhook update still displays newly issued webhook secret when follow-up GET /v1/webhooks/deliveries fails.
  const newWhSecret = `fp_whsec_test_${"8".repeat(64)}`;
  handler = (url, init) => {
    if (url.endsWith("/v1/sessions/me")) {
      return new Response(JSON.stringify(sampleSession), { status: 200 });
    }
    if (url.endsWith("/v1/merchants/me/webhook") && init?.method === "PUT") {
      return new Response(
        JSON.stringify({
          webhook: { url: "http://127.0.0.1:4000/hook", secret: newWhSecret, secret_configured: true },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v1/webhooks/deliveries")) {
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "boom" } }), { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };
  const whRes = await fetch(`${dashUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: new URLSearchParams({ _csrf: csrfToken, webhook_url: "http://127.0.0.1:4000/hook", action: "save" }),
    redirect: "manual",
  });
  assert.equal(whRes.status, 200);
  const whHtml = await whRes.text();
  assert.ok(whHtml.includes(newWhSecret), "new webhook secret must still be shown");
  assert.ok(whHtml.includes("delivery history could not be loaded"));

  // 5. Signup still displays newly issued keys even when automatic login fails.
  const signupSecret = `fp_sec_test_${"7".repeat(64)}`;
  const signupPublic = `fp_pub_test_${"6".repeat(64)}`;
  handler = (url, init) => {
    if (url.endsWith("/v1/merchants") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          merchant: sampleSession.merchant,
          keys: { public_key: signupPublic, secret_key: signupSecret },
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "login failed" } }), { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };
  const signupFallback = await fetch(`${dashUrl}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ business_name: "Resilient Co", email: "resilient@example.com", password: "a-long-password-123" }),
    redirect: "manual",
  });
  assert.equal(signupFallback.status, 201);
  const signupFallbackHtml = await signupFallback.text();
  assert.ok(signupFallbackHtml.includes(signupSecret));
  assert.ok(signupFallbackHtml.includes(signupPublic));

  // 6. Dashboard enforces per-client login rate limiting (10/min -> 429) and forwards trusted proxy headers.
  let upstreamLoginCalls = 0;
  let seenProxySecret = "";
  let seenClientIp = "";
  handler = (_url, init) => {
    upstreamLoginCalls += 1;
    const hdrs = init?.headers as Record<string, string> | undefined;
    seenProxySecret = hdrs?.["X-FlutterPay-Proxy-Secret"] ?? "";
    seenClientIp = hdrs?.["X-FlutterPay-Client-IP"] ?? "";
    return new Response(JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } }), {
      status: 401,
    });
  };
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${dashUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "resilient@example.com", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  }
  assert.equal(upstreamLoginCalls, 10);
  assert.equal(seenProxySecret, "shared-proxy-secret");
  assert.ok(seenClientIp.length > 0);

  const limitedLogin = await fetch(`${dashUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "resilient@example.com", password: "wrong" }),
  });
  assert.equal(limitedLogin.status, 429);
  assert.equal(upstreamLoginCalls, 10, "11th attempt must be blocked by dashboard rate limiter before calling API");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { postJson, testDatabase, testServer } from "./helpers.js";

const password = "a-long-dashboard-password";

function extractCookieValue(response: Response, name: string): string | null {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const first = cookie.split(";")[0] ?? "";
    const idx = first.indexOf("=");
    if (idx > 0 && first.slice(0, idx).trim() === name) {
      return first.slice(idx + 1).trim();
    }
  }
  return null;
}

test("merchant sessions, cookie/CSRF auth, and immediate API key rotation", async t => {
  const db = await testDatabase(t);

  await t.test("login creates hashed session cookie, enforces CSRF on writes, expires after 24h, and revokes on logout", async t => {
    let currentTime = new Date("2026-11-22T10:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime });

    const signupRes = await postJson(url, {
      business_name: "Ada's Shop",
      email: "ada@example.com",
      password,
    });
    assert.equal(signupRes.status, 201);
    const created = await signupRes.json();

    // Unknown email and wrong password return the same generic 401.
    for (const creds of [
      { email: "missing@example.com", password },
      { email: "ada@example.com", password: "wrong-password-123" },
    ]) {
      const badLogin = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      assert.equal(badLogin.status, 401);
      assert.deepEqual(await badLogin.json(), {
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
      });
    }

    // Valid login issues HttpOnly SameSite=Lax cookie and stores only SHA-256 hash.
    const loginRes = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " ADA@Example.com ", password }),
    });
    assert.equal(loginRes.status, 201);
    assert.equal(loginRes.headers.get("cache-control"), "no-store");
    const rawCookieHeader = loginRes.headers.getSetCookie().find(c => c.startsWith("fp_session=")) ?? "";
    assert.match(rawCookieHeader, /HttpOnly/i);
    assert.match(rawCookieHeader, /SameSite=Lax/i);
    assert.match(rawCookieHeader, /Path=\//i);

    const token = extractCookieValue(loginRes, "fp_session");
    assert.ok(token && /^[a-f0-9]{64}$/.test(token));
    const loginBody = await loginRes.json();
    assert.equal(loginBody.merchant.id, created.merchant.id);
    assert.match(loginBody.session.csrf_token, /^[a-f0-9]{64}$/);

    const dbSession = await db.merchantSession.findUniqueOrThrow({ where: { id: loginBody.session.id } });
    assert.equal(dbSession.tokenHash, createHash("sha256").update(token).digest("hex"));
    assert.ok(!JSON.stringify(dbSession).includes(token));

    const cookieHeader = `fp_session=${token}`;

    // Session authenticates GET /v1/sessions/me and GET /v1/merchants/me.
    const meSession = await fetch(`${url}/v1/sessions/me`, { headers: { Cookie: cookieHeader } });
    assert.equal(meSession.status, 200);
    assert.equal((await meSession.json()).merchant.email, "ada@example.com");

    const meMerchant = await fetch(`${url}/v1/merchants/me`, { headers: { Cookie: cookieHeader } });
    assert.equal(meMerchant.status, 200);
    assert.deepEqual(await meMerchant.json(), { merchant: created.merchant });

    // An explicit invalid Authorization header must NOT fall back to the valid session cookie.
    const invalidBearerWithCookie = await fetch(`${url}/v1/merchants/me`, {
      headers: {
        Authorization: "Bearer fp_sec_test_" + "0".repeat(64),
        Cookie: cookieHeader,
      },
    });
    assert.equal(invalidBearerWithCookie.status, 401);

    // State-changing cookie requests require matching X-CSRF-Token.
    const missingCsrf = await fetch(`${url}/v1/merchants/me/webhook`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ webhook_url: "http://127.0.0.1:4000/hook" }),
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).error.code, "INVALID_CSRF");

    const withCsrf = await fetch(`${url}/v1/merchants/me/webhook`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-CSRF-Token": loginBody.session.csrf_token,
      },
      body: JSON.stringify({ webhook_url: "http://127.0.0.1:4000/hook" }),
    });
    assert.equal(withCsrf.status, 200);

    // Logout without CSRF fails with 403; with CSRF revokes the session immediately.
    const badLogout = await fetch(`${url}/v1/sessions/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-CSRF-Token": "wrong" },
    });
    assert.equal(badLogout.status, 403);

    const logout = await fetch(`${url}/v1/sessions/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-CSRF-Token": loginBody.session.csrf_token },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.getSetCookie().join(";"), /Max-Age=0/);

    const afterLogout = await fetch(`${url}/v1/sessions/me`, { headers: { Cookie: cookieHeader } });
    assert.equal(afterLogout.status, 401);

    // A second session expires after 24 hours.
    const login2 = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password }),
    });
    assert.equal(login2.status, 201);
    const token2 = extractCookieValue(login2, "fp_session")!;
    currentTime = new Date("2026-11-23T10:00:01.000Z");
    const expiredCheck = await fetch(`${url}/v1/sessions/me`, {
      headers: { Cookie: `fp_session=${token2}` },
    });
    assert.equal(expiredCheck.status, 401);
  });

  await t.test("rotating a leaked secret key revokes the old key immediately and activates the replacement", async t => {
    const url = await testServer(t, db);
    const signupA = await postJson(url, { business_name: "Key Rotate Co", email: "rotate@example.com", password });
    assert.equal(signupA.status, 201);
    const merchantA = await signupA.json();
    const oldSecret: string = merchantA.keys.secret_key;

    const signupB = await postJson(url, { business_name: "Other Co", email: "other@example.com", password });
    assert.equal(signupB.status, 201);
    const merchantB = await signupB.json();

    // Old secret key works before rotation.
    const beforeMe = await fetch(`${url}/v1/merchants/me`, {
      headers: { Authorization: `Bearer ${oldSecret}` },
    });
    assert.equal(beforeMe.status, 200);

    // Log in to Merchant A session.
    const loginRes = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rotate@example.com", password }),
    });
    assert.equal(loginRes.status, 201);
    const token = extractCookieValue(loginRes, "fp_session")!;
    const { session } = await loginRes.json();
    const cookieHeader = `fp_session=${token}`;

    // Rotate secret key via session + CSRF.
    const rotateRes = await fetch(`${url}/v1/merchants/me/keys/rotate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-CSRF-Token": session.csrf_token,
      },
      body: JSON.stringify({ kind: "secret" }),
    });
    assert.equal(rotateRes.status, 201);
    assert.equal(rotateRes.headers.get("cache-control"), "no-store");
    const rotated = await rotateRes.json();
    assert.equal(rotated.key.kind, "secret");
    assert.equal(rotated.revoked_count, 1);
    assert.match(rotated.key.value, /^fp_sec_test_[a-f0-9]{64}$/);
    assert.notEqual(rotated.key.value, oldSecret);

    // Old secret key stops working straight away on all endpoints.
    const oldMe = await fetch(`${url}/v1/merchants/me`, {
      headers: { Authorization: `Bearer ${oldSecret}` },
    });
    assert.equal(oldMe.status, 401);

    const oldPayment = await fetch(`${url}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oldSecret}`,
      },
      body: JSON.stringify({
        tx_ref: "after-rotate-old",
        amount_kobo: 1000,
        currency: "NGN",
        customer_email: "buyer@example.com",
        redirect_url: "http://127.0.0.1:4000/cb",
      }),
    });
    assert.equal(oldPayment.status, 401);

    // New secret key works immediately.
    const newPayment = await fetch(`${url}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rotated.key.value}`,
      },
      body: JSON.stringify({
        tx_ref: "after-rotate-new",
        amount_kobo: 1000,
        currency: "NGN",
        customer_email: "buyer@example.com",
        redirect_url: "http://127.0.0.1:4000/cb",
      }),
    });
    assert.equal(newPayment.status, 201);

    // Merchant B's secret key is unaffected.
    const merchantBMe = await fetch(`${url}/v1/merchants/me`, {
      headers: { Authorization: `Bearer ${merchantB.keys.secret_key}` },
    });
    assert.equal(merchantBMe.status, 200);

    // GET /v1/merchants/me/keys returns metadata only (no key hashes or plaintext values).
    const keysRes = await fetch(`${url}/v1/merchants/me/keys`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(keysRes.status, 200);
    const keysText = await keysRes.text();
    assert.ok(!keysText.includes(oldSecret));
    assert.ok(!keysText.includes(rotated.key.value));
    const keysData = JSON.parse(keysText);
    assert.equal(keysData.keys.length, 3);
    assert.equal(keysData.keys.filter((k: { kind: string; active: boolean }) => k.kind === "secret" && k.active).length, 1);
    assert.equal(keysData.keys.filter((k: { kind: string; active: boolean }) => k.kind === "secret" && !k.active).length, 1);
  });

  await t.test("login endpoint is rate-limited to 10 requests per minute", async t => {
    const url = await testServer(t, db);
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
      });
      assert.equal(res.status, 401);
    }
    const limited = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  });

  await t.test("trustedProxySecret isolates per-client login rate limits and ignores untrusted client IP headers", async t => {
    const proxySecret = "test-shared-proxy-secret";
    const url = await testServer(t, db, { trustedProxySecret: proxySecret });

    // Exhaust client A's rate limit through the trusted dashboard proxy.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlutterPay-Proxy-Secret": proxySecret,
          "X-FlutterPay-Client-IP": "198.51.100.10",
        },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
      });
      assert.equal(res.status, 401);
    }

    const clientALimited = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FlutterPay-Proxy-Secret": proxySecret,
        "X-FlutterPay-Client-IP": "198.51.100.10",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    assert.equal(clientALimited.status, 429);

    // Client B through the trusted proxy has its own bucket and is NOT blocked by Client A.
    const clientBAllowed = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FlutterPay-Proxy-Secret": proxySecret,
        "X-FlutterPay-Client-IP": "198.51.100.20",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    assert.equal(clientBAllowed.status, 401);

    // Untrusted caller spoofing different X-FlutterPay-Client-IP headers without the secret still hits the shared peer IP bucket.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlutterPay-Proxy-Secret": "wrong-secret",
          "X-FlutterPay-Client-IP": `203.0.113.${i + 1}`,
        },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
      });
      assert.equal(res.status, 401);
    }
    const spoofBlocked = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FlutterPay-Proxy-Secret": "wrong-secret",
        "X-FlutterPay-Client-IP": "203.0.113.99",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    assert.equal(spoofBlocked.status, 429);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_CARDS, TEST_OTP } from "../src/fake-bank.js";
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

async function createTestPayment(url: string, secretKey: string, txRef: string, redirectUrl = "http://127.0.0.1:4000/callback?from=shop") {
  const response = await fetch(`${url}/v1/payments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount_kobo: 500_000,
      currency: "NGN",
      customer_email: "buyer@example.com",
      redirect_url: redirectUrl,
    }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{
    transaction: { id: string; tx_ref: string; status: string };
    link: string;
  }>;
}

function submitForm(endpoint: string, fields: Record<string, string>) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

function submitJson(endpoint: string, body: unknown) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

test("hosted checkout page and fake bank", async t => {
  const db = await testDatabase(t);

  await t.test("renders escaped HTML checkout page with security headers and 404 for unknown IDs", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "xss@example.com", 'Ada <script>alert("xss")</script> Shop');
    const created = await createTestPayment(url, account.keys.secret_key, "html-1");

    const res = await fetch(`${url}/pay/${created.transaction.id}`, { headers: { Accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'none'"));
    const html = await res.text();
    assert.ok(html.includes("₦5,000.00"));
    assert.ok(html.includes("Ada &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; Shop"));
    assert.ok(!html.includes('<script>alert("xss")</script>'));

    const missingHtml = await fetch(`${url}/pay/does-not-exist`, { headers: { Accept: "text/html" } });
    assert.equal(missingHtml.status, 404);
    const missingJson = await fetch(`${url}/pay/does-not-exist`, { headers: { Accept: "application/json" } });
    assert.equal(missingJson.status, 404);
    assert.equal((await missingJson.json()).error.code, "NOT_FOUND");
  });

  await t.test("approve test card marks payment successful, redirects safely and never stores full PAN or CVV", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "approve@example.com");
    const created = await createTestPayment(url, account.keys.secret_key, "approve-1");

    const res = await submitForm(`${url}/pay/${created.transaction.id}/charge`, {
      card_number: "4242 4242 4242 4242",
      expiry: "12/30",
      cvv: "789",
    });
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "http://127.0.0.1:4000/callback");
    assert.equal(location.searchParams.get("from"), "shop");
    assert.equal(location.searchParams.get("status"), "successful");
    assert.equal(location.searchParams.get("tx_ref"), "approve-1");
    assert.equal(location.searchParams.get("transaction_id"), created.transaction.id);

    const stored = await db.transaction.findUniqueOrThrow({ where: { id: created.transaction.id } });
    assert.equal(stored.status, "SUCCESSFUL");
    assert.equal(stored.cardLast4, "4242");
    assert.equal(stored.failureReason, null);
    const serializedRow = JSON.stringify(stored);
    assert.ok(!serializedRow.includes(TEST_CARDS.APPROVE));
    assert.ok(!serializedRow.includes("789"));

    // Terminal state cannot be charged again.
    const replay = await submitJson(`${url}/pay/${created.transaction.id}/charge`, {
      card_number: TEST_CARDS.DECLINE_BLOCKED,
      expiry: "12/30",
      cvv: "123",
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, "INVALID_STATE");
    const unchanged = await db.transaction.findUniqueOrThrow({ where: { id: created.transaction.id } });
    assert.equal(unchanged.status, "SUCCESSFUL");
  });

  await t.test("decline test cards and unknown test cards mark payment failed with clear reasons", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "decline@example.com");

    const cases = [
      ["decline-blocked", TEST_CARDS.DECLINE_BLOCKED, "0002", "Card blocked"],
      ["decline-funds", TEST_CARDS.DECLINE_INSUFFICIENT_FUNDS, "9995", "Insufficient funds"],
      ["decline-other", "4111111111111111", "1111", "Unsupported test card"],
    ] as const;

    for (const [txRef, cardNumber, last4, reason] of cases) {
      const created = await createTestPayment(url, account.keys.secret_key, txRef);
      const res = await submitJson(`${url}/pay/${created.transaction.id}/charge`, {
        card_number: cardNumber,
        expiry: "12/30",
        cvv: "123",
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.transaction.status, "failed");
      assert.equal(payload.transaction.card_last4, last4);
      assert.equal(payload.transaction.failure_reason, reason);
      const redirect = new URL(payload.redirect_url);
      assert.equal(redirect.searchParams.get("status"), "failed");
      assert.equal(redirect.searchParams.get("tx_ref"), txRef);
    }
  });

  await t.test("OTP test card supports retry and succeeds with 123456, or fails after 3 wrong OTPs", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "otp@example.com");

    // Path 1: 2 wrong OTPs + 1 malformed OTP (does not count) + correct OTP succeeds
    const otpSuccess = await createTestPayment(url, account.keys.secret_key, "otp-success");
    const chargeRes = await submitJson(`${url}/pay/${otpSuccess.transaction.id}/charge`, {
      card_number: TEST_CARDS.OTP,
      expiry: "12/30",
      cvv: "123",
    });
    assert.equal(chargeRes.status, 200);
    const chargeJson = await chargeRes.json();
    assert.equal(chargeJson.transaction.status, "awaiting_otp");
    assert.equal(chargeJson.next_action, "otp");

    const otpPage = await fetch(`${url}/pay/${otpSuccess.transaction.id}`, { headers: { Accept: "text/html" } });
    assert.equal(otpPage.status, 200);
    assert.ok((await otpPage.text()).includes("Enter 6-digit OTP"));

    const malformed = await submitJson(`${url}/pay/${otpSuccess.transaction.id}/otp`, { otp: "abc" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_INPUT");

    const wrong1 = await submitJson(`${url}/pay/${otpSuccess.transaction.id}/otp`, { otp: "000000" });
    assert.equal(wrong1.status, 400);
    const wrong1Json = await wrong1.json();
    assert.equal(wrong1Json.error.code, "INVALID_OTP");
    assert.equal(wrong1Json.remaining_attempts, 2);

    const wrong2 = await submitJson(`${url}/pay/${otpSuccess.transaction.id}/otp`, { otp: "999999" });
    assert.equal(wrong2.status, 400);
    assert.equal((await wrong2.json()).remaining_attempts, 1);

    const right = await submitJson(`${url}/pay/${otpSuccess.transaction.id}/otp`, { otp: TEST_OTP });
    assert.equal(right.status, 200);
    const rightJson = await right.json();
    assert.equal(rightJson.transaction.status, "successful");
    assert.equal(new URL(rightJson.redirect_url).searchParams.get("status"), "successful");

    // Path 2: 3 wrong OTPs fails the transaction permanently
    const otpFail = await createTestPayment(url, account.keys.secret_key, "otp-fail");
    await submitJson(`${url}/pay/${otpFail.transaction.id}/charge`, {
      card_number: TEST_CARDS.OTP,
      expiry: "12/30",
      cvv: "123",
    });
    assert.equal((await submitJson(`${url}/pay/${otpFail.transaction.id}/otp`, { otp: "111111" })).status, 400);
    assert.equal((await submitJson(`${url}/pay/${otpFail.transaction.id}/otp`, { otp: "222222" })).status, 400);
    const thirdWrong = await submitJson(`${url}/pay/${otpFail.transaction.id}/otp`, { otp: "333333" });
    assert.equal(thirdWrong.status, 200);
    const thirdJson = await thirdWrong.json();
    assert.equal(thirdJson.transaction.status, "failed");
    assert.equal(thirdJson.transaction.failure_reason, "Too many invalid OTP attempts");

    const afterFail = await submitJson(`${url}/pay/${otpFail.transaction.id}/otp`, { otp: TEST_OTP });
    assert.equal(afterFail.status, 409);
    assert.equal((await afterFail.json()).error.code, "INVALID_STATE");
  });

  await t.test("invalid card input leaves payment pending and never echoes card number or CVV", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "card-validation@example.com");
    const created = await createTestPayment(url, account.keys.secret_key, "bad-card-1");

    const invalidForms: Record<string, string>[] = [
      { card_number: "4242", expiry: "12/30", cvv: "123" },
      { card_number: TEST_CARDS.APPROVE, expiry: "10/26", cvv: "123" },
      { card_number: TEST_CARDS.APPROVE, expiry: "13/30", cvv: "123" },
      { card_number: TEST_CARDS.APPROVE, expiry: "12/30", cvv: "12" },
      { card_number: TEST_CARDS.APPROVE, expiry: "12/30", cvv: "987", extra: "bad" },
    ];
    for (const body of invalidForms) {
      const res = await submitForm(`${url}/pay/${created.transaction.id}/charge`, body);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(!html.includes("987"));
    }

    const stored = await db.transaction.findUniqueOrThrow({ where: { id: created.transaction.id } });
    assert.equal(stored.status, "PENDING");
  });

  await t.test("expires unpaid pending and awaiting_otp transactions to abandoned after 30 minutes", async t => {
    let currentTime = new Date("2026-11-21T10:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime });
    const account = await registerMerchant(url, "expiry@example.com");

    const pendingTx = await createTestPayment(url, account.keys.secret_key, "exp-pending");
    const otpTx = await createTestPayment(url, account.keys.secret_key, "exp-otp");
    assert.equal(
      (await submitJson(`${url}/pay/${otpTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.OTP,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );

    // Advance clock by 30 minutes
    currentTime = new Date("2026-11-21T10:30:00.000Z");

    const chargeExpired = await submitJson(`${url}/pay/${pendingTx.transaction.id}/charge`, {
      card_number: TEST_CARDS.APPROVE,
      expiry: "12/30",
      cvv: "123",
    });
    assert.equal(chargeExpired.status, 409);
    const chargeExpiredJson = await chargeExpired.json();
    assert.equal(chargeExpiredJson.transaction.status, "abandoned");
    assert.equal(chargeExpiredJson.transaction.failure_reason, "Payment link expired");

    const otpExpired = await submitJson(`${url}/pay/${otpTx.transaction.id}/otp`, { otp: TEST_OTP });
    assert.equal(otpExpired.status, 409);
    const otpExpiredJson = await otpExpired.json();
    assert.equal(otpExpiredJson.transaction.status, "abandoned");
    assert.equal(otpExpiredJson.transaction.failure_reason, "Payment link expired");
  });

  await t.test("concurrent double-submit on charge transitions the transaction only once", async t => {
    const url = await testServer(t, db, { now: () => new Date("2026-11-21T10:00:00.000Z") });
    const account = await registerMerchant(url, "race@example.com");
    const created = await createTestPayment(url, account.keys.secret_key, "race-1");

    const responses = await Promise.all([
      submitJson(`${url}/pay/${created.transaction.id}/charge`, { card_number: TEST_CARDS.APPROVE, expiry: "12/30", cvv: "123" }),
      submitJson(`${url}/pay/${created.transaction.id}/charge`, { card_number: TEST_CARDS.DECLINE_BLOCKED, expiry: "12/30", cvv: "123" }),
    ]);

    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  });
});

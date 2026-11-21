import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TEST_CARDS, TEST_OTP } from "../src/fake-bank.js";
import { postJson, testDatabase, testServer } from "./helpers.js";

const password = "a long learning password";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function registerMerchant(url: string, email: string, business_name = "Ada's business") {
  const response = await postJson(url, { business_name, email, password });
  assert.equal(response.status, 201);
  return response.json() as Promise<{
    merchant: { id: string; business_name: string; email: string };
    keys: { public_key: string; secret_key: string };
  }>;
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
  return response.json() as Promise<{
    transaction: { id: string; tx_ref: string; status: string };
    link: string;
  }>;
}

function submitJson(endpoint: string, body: unknown) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

function verifyTransaction(url: string, transactionId: string, secretKey?: string) {
  const headers: Record<string, string> = secretKey ? { Authorization: `Bearer ${secretKey}` } : {};
  return fetch(`${url}/v1/transactions/${encodeURIComponent(transactionId)}/verify`, { headers });
}

test("transaction verification endpoint", async t => {
  const db = await testDatabase(t);

  await t.test("verifies pending, successful, OTP-completed and failed transactions for the owning merchant", async t => {
    const fixedNow = new Date("2026-11-21T10:00:00.000Z");
    const url = await testServer(t, db, { now: () => fixedNow });
    const merchant = await registerMerchant(url, "verify-owner@example.com");

    // 1. Pending -> approved directly
    const approved = await createTestPayment(url, merchant.keys.secret_key, "verify-approve", 500_000);
    const pendingRes = await verifyTransaction(url, approved.transaction.id, merchant.keys.secret_key);
    assert.equal(pendingRes.status, 200);
    assert.equal(pendingRes.headers.get("cache-control"), "no-store");
    assert.deepEqual(await pendingRes.json(), {
      transaction: {
        id: approved.transaction.id,
        tx_ref: "verify-approve",
        amount_kobo: 500_000,
        currency: "NGN",
        status: "pending",
        customer_email: "buyer@example.com",
        card_last4: null,
        failure_reason: null,
        redirect_url: "http://127.0.0.1:4000/callback",
        expires_at: "2026-11-21T10:30:00.000Z",
        created_at: "2026-11-21T10:00:00.000Z",
      },
    });

    assert.equal(
      (await submitJson(`${url}/pay/${approved.transaction.id}/charge`, {
        card_number: TEST_CARDS.APPROVE,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );

    const successRes = await verifyTransaction(url, approved.transaction.id, merchant.keys.secret_key);
    assert.equal(successRes.status, 200);
    const successBody = await successRes.json();
    assert.equal(successBody.transaction.status, "successful");
    assert.equal(successBody.transaction.card_last4, "4242");
    assert.equal(successBody.transaction.failure_reason, null);
    assert.equal(successBody.transaction.amount_kobo, 500_000);
    assert.equal(successBody.transaction.currency, "NGN");
    assert.equal(successBody.transaction.tx_ref, "verify-approve");
    assert.equal("merchantId" in successBody.transaction, false);
    assert.equal("otpAttempts" in successBody.transaction, false);

    // 2. OTP flow -> awaiting_otp then successful
    const otpTx = await createTestPayment(url, merchant.keys.secret_key, "verify-otp", 250_000);
    assert.equal(
      (await submitJson(`${url}/pay/${otpTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.OTP,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );
    const awaitingBody = await (await verifyTransaction(url, otpTx.transaction.id, merchant.keys.secret_key)).json();
    assert.equal(awaitingBody.transaction.status, "awaiting_otp");
    assert.equal(awaitingBody.transaction.card_last4, "0001");

    assert.equal(
      (await submitJson(`${url}/pay/${otpTx.transaction.id}/otp`, { otp: TEST_OTP })).status,
      200,
    );
    const otpDoneBody = await (await verifyTransaction(url, otpTx.transaction.id, merchant.keys.secret_key)).json();
    assert.equal(otpDoneBody.transaction.status, "successful");

    // 3. Declined card -> failed with failure_reason
    const declinedTx = await createTestPayment(url, merchant.keys.secret_key, "verify-decline", 150_000);
    assert.equal(
      (await submitJson(`${url}/pay/${declinedTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.DECLINE_INSUFFICIENT_FUNDS,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );
    const failedBody = await (await verifyTransaction(url, declinedTx.transaction.id, merchant.keys.secret_key)).json();
    assert.equal(failedBody.transaction.status, "failed");
    assert.equal(failedBody.transaction.card_last4, "9995");
    assert.equal(failedBody.transaction.failure_reason, "Insufficient funds");
  });

  await t.test("returns 404 when another merchant asks about a payment or when the ID does not exist", async t => {
    let currentTime = new Date("2026-11-21T10:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime });
    const merchantA = await registerMerchant(url, "iso-a@example.com");
    const merchantB = await registerMerchant(url, "iso-b@example.com");

    const paymentA = await createTestPayment(url, merchantA.keys.secret_key, "merchant-a-only");

    // Advance past expiry so we also verify Merchant B cannot mutate Merchant A's transaction state.
    currentTime = new Date("2026-11-21T11:00:00.000Z");

    const crossMerchant = await verifyTransaction(url, paymentA.transaction.id, merchantB.keys.secret_key);
    assert.equal(crossMerchant.status, 404);
    assert.equal(crossMerchant.headers.get("cache-control"), "no-store");
    assert.deepEqual(await crossMerchant.json(), {
      error: { code: "NOT_FOUND", message: "Transaction not found." },
    });

    // Merchant A's row must remain untouched by Merchant B's failed lookup.
    const untouched = await db.transaction.findUniqueOrThrow({ where: { id: paymentA.transaction.id } });
    assert.equal(untouched.status, "PENDING");

    // Unknown ID returns the exact same 404 shape.
    const unknown = await verifyTransaction(url, "does-not-exist", merchantA.keys.secret_key);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      error: { code: "NOT_FOUND", message: "Transaction not found." },
    });
  });

  await t.test("lazily transitions expired pending and awaiting_otp transactions to abandoned on verify", async t => {
    let currentTime = new Date("2026-11-21T10:00:00.000Z");
    const url = await testServer(t, db, { now: () => currentTime });
    const merchant = await registerMerchant(url, "verify-expiry@example.com");

    const pendingTx = await createTestPayment(url, merchant.keys.secret_key, "verify-exp-pending");
    const otpTx = await createTestPayment(url, merchant.keys.secret_key, "verify-exp-otp");
    assert.equal(
      (await submitJson(`${url}/pay/${otpTx.transaction.id}/charge`, {
        card_number: TEST_CARDS.OTP,
        expiry: "12/30",
        cvv: "123",
      })).status,
      200,
    );

    currentTime = new Date("2026-11-21T10:30:00.000Z");

    for (const id of [pendingTx.transaction.id, otpTx.transaction.id]) {
      const res = await verifyTransaction(url, id, merchant.keys.secret_key);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.transaction.status, "abandoned");
      assert.equal(body.transaction.failure_reason, "Payment link expired");

      const stored = await db.transaction.findUniqueOrThrow({ where: { id } });
      assert.equal(stored.status, "ABANDONED");
    }
  });

  await t.test("rejects missing, malformed, public and revoked API keys", async t => {
    const url = await testServer(t, db);
    const merchant = await registerMerchant(url, "verify-auth@example.com");
    const created = await createTestPayment(url, merchant.keys.secret_key, "verify-auth-ref");

    await db.apiKey.update({
      where: { keyHash: digest(merchant.keys.secret_key) },
      data: { revokedAt: new Date() },
    });

    for (const header of [undefined, "Bearer wrong", `Bearer ${merchant.keys.public_key}`, `Bearer ${merchant.keys.secret_key}`]) {
      const res = await fetch(`${url}/v1/transactions/${encodeURIComponent(created.transaction.id)}/verify`, {
        headers: header ? { Authorization: header } : {},
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal((await res.json()).error.code, "UNAUTHORIZED");
    }
  });
});

test("unexpected verify database errors do not expose internals", async t => {
  const db = await testDatabase(t);
  const url = await testServer(t, db);
  const merchant = await registerMerchant(url, "verify-db-err@example.com");
  await db.$executeRawUnsafe('DROP TABLE "Transaction"');

  const res = await verifyTransaction(url, "any-id", merchant.keys.secret_key);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
});

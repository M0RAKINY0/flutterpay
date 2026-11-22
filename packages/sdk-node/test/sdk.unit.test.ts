import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  FlutterPay,
  FlutterPayApiError,
  FlutterPayAuthenticationError,
  FlutterPayConfigError,
  FlutterPayConflictError,
  FlutterPayError,
  FlutterPayNetworkError,
  FlutterPayNotFoundError,
  FlutterPayRateLimitError,
  FlutterPayValidationError,
  FlutterPayWebhookSignatureError,
  verifyWebhookEvent,
  verifyWebhookSignature,
} from "../src/index.js";

function makeSignature(payload: string | Buffer, secret: string, timestampSec: number) {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestampSec}.`, "utf8"), buf]))
    .digest("hex");
  return `t=${timestampSec},v1=${digest}`;
}

function sampleWebhookPayload(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    id: "evt_0123456789abcdef0123456789abcdef",
    event: "charge.completed",
    created_at: "2026-11-22T12:00:00.000Z",
    data: {
      id: "tx_123",
      tx_ref: "order-100",
      amount_kobo: 500_000,
      currency: "NGN",
      status: "successful",
      customer_email: "buyer@example.com",
      card_last4: "4242",
      failure_reason: null,
      redirect_url: "http://127.0.0.1:4000/callback",
      expires_at: "2026-11-22T12:30:00.000Z",
      created_at: "2026-11-22T11:59:00.000Z",
    },
    ...overrides,
  });
}

test("FlutterPay constructor validates secretKey, baseUrl, and timeoutMs", () => {
  assert.throws(() => new FlutterPay({ secretKey: "" }), FlutterPayConfigError);
  assert.throws(() => new FlutterPay({ secretKey: "fp_sec_test_123\r\nX-Injected: 1" }), FlutterPayConfigError);
  assert.throws(() => new FlutterPay({ secretKey: "fp_sec_test_abc def" }), FlutterPayConfigError);

  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", baseUrl: "ftp://example.com" }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", baseUrl: "http://user:pass@127.0.0.1:3000" }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", baseUrl: "http://127.0.0.1:3000?a=1" }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", baseUrl: "http://127.0.0.1:3000#hash" }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", timeoutMs: 0 }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", timeoutMs: 0.5 }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", timeoutMs: 2_147_483_648 }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", timeoutMs: 4_294_967_296 }),
    FlutterPayConfigError,
  );
  assert.throws(
    () => new FlutterPay({ secretKey: "fp_sec_test_123", timeoutMs: Number.NaN }),
    FlutterPayConfigError,
  );

  const client = new FlutterPay({
    secretKey: "fp_sec_test_123",
    baseUrl: "http://127.0.0.1:3000///",
  });
  assert.equal(client.baseUrl, "http://127.0.0.1:3000");
  assert.equal(client.timeoutMs, 10_000);
});

test("per-request timeoutMs overrides are validated with FlutterPayConfigError", async () => {
  let called = false;
  const client = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async () => {
      called = true;
      return new Response("{}");
    },
  });

  await assert.rejects(() => client.transactions.verify("tx_1", { timeoutMs: 0.5 }), FlutterPayConfigError);
  await assert.rejects(() => client.transactions.verify("tx_1", { timeoutMs: 0 }), FlutterPayConfigError);
  await assert.rejects(() => client.transactions.verify("tx_1", { timeoutMs: 4_294_967_296 }), FlutterPayConfigError);
  assert.equal(called, false);
});

test("transactions.verify rejects empty or path-separating transaction IDs before making requests", () => {
  let called = false;
  const client = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async () => {
      called = true;
      return new Response("{}");
    },
  });

  assert.throws(() => client.transactions.verify(""), FlutterPayError);
  assert.throws(() => client.transactions.verify("   "), FlutterPayError);
  assert.throws(() => client.transactions.verify("../merchants/me"), FlutterPayError);
  assert.throws(() => client.transactions.verify("tx_1?foo=bar"), FlutterPayError);
  assert.throws(() => client.transactions.verify("tx_1#frag"), FlutterPayError);
  assert.equal(called, false);
});

test("API error responses map to typed FlutterPayApiError subclasses", async () => {
  const cases = [
    { status: 400, code: "INVALID_INPUT", expectedClass: FlutterPayValidationError },
    { status: 401, code: "UNAUTHORIZED", expectedClass: FlutterPayAuthenticationError },
    { status: 404, code: "NOT_FOUND", expectedClass: FlutterPayNotFoundError },
    { status: 409, code: "DUPLICATE_TX_REF", expectedClass: FlutterPayConflictError },
    { status: 429, code: "RATE_LIMITED", expectedClass: FlutterPayRateLimitError },
    { status: 500, code: "INTERNAL_ERROR", expectedClass: FlutterPayApiError },
  ] as const;

  for (const tc of cases) {
    const client = new FlutterPay({
      secretKey: "fp_sec_test_123",
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: tc.code, message: `Error ${tc.status}` } }), {
          status: tc.status,
          headers: tc.status === 429 ? { "Retry-After": "45" } : undefined,
        }),
    });

    await assert.rejects(
      () => client.transactions.verify("tx_123"),
      (error: unknown) => {
        assert.ok(error instanceof FlutterPayApiError);
        assert.ok(error instanceof tc.expectedClass);
        assert.equal(error.status, tc.status);
        assert.equal(error.code, tc.code);
        assert.equal(error.message, `Error ${tc.status}`);
        if (error instanceof FlutterPayRateLimitError) {
          assert.equal(error.retryAfter, "45");
        }
        return true;
      },
    );
  }
});

test("non-JSON error, non-JSON success, 3xx redirect, network failure, and timeout produce typed errors", async () => {
  const nonJsonErrorClient = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
  });
  await assert.rejects(
    () => nonJsonErrorClient.transactions.verify("tx_1"),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "HTTP_502");
      return true;
    },
  );

  const nonJsonSuccessClient = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async () => new Response("<html>not json</html>", { status: 200 }),
  });
  await assert.rejects(
    () => nonJsonSuccessClient.transactions.verify("tx_1"),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayApiError);
      assert.equal(error.code, "INVALID_RESPONSE");
      return true;
    },
  );

  const redirectClient = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response("", { status: 302, headers: { Location: "https://evil.example" } });
    },
  });
  await assert.rejects(
    () => redirectClient.transactions.verify("tx_1"),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayApiError);
      assert.equal(error.status, 302);
      return true;
    },
  );

  const networkErrorClient = new FlutterPay({
    secretKey: "fp_sec_test_123",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => networkErrorClient.transactions.verify("tx_1"),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayNetworkError);
      assert.equal(error.isTimeout, false);
      return true;
    },
  );

  const timeoutClient = new FlutterPay({
    secretKey: "fp_sec_test_123",
    timeoutMs: 25,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("mock fetch never aborted")), 5_000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    () => timeoutClient.transactions.verify("tx_1"),
    (error: unknown) => {
      assert.ok(error instanceof FlutterPayNetworkError);
      assert.equal(error.isTimeout, true);
      return true;
    },
  );
});

test("verifyWebhookSignature and verifyWebhookEvent validate signatures, timestamps, and payloads", () => {
  const secret = "fp_whsec_test_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const now = new Date("2026-11-22T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000);
  const payload = sampleWebhookPayload();
  const signature = makeSignature(payload, secret, timestamp);

  // Valid string, Buffer, and Uint8Array payloads all pass.
  assert.deepEqual(
    verifyWebhookSignature({ payload, signature, secret, now }),
    { valid: true, timestamp },
  );
  assert.deepEqual(
    verifyWebhookSignature({ payload: Buffer.from(payload, "utf8"), signature, secret, now }),
    { valid: true, timestamp },
  );
  assert.deepEqual(
    verifyWebhookSignature({ payload: new TextEncoder().encode(payload), signature, secret, now }),
    { valid: true, timestamp },
  );

  const event = verifyWebhookEvent({ payload, signature, secret, now });
  assert.equal(event.id, "evt_0123456789abcdef0123456789abcdef");
  assert.equal(event.event, "charge.completed");
  assert.equal(event.data.tx_ref, "order-100");
  assert.equal(event.data.amount_kobo, 500_000);

  // Tampered payload fails.
  const tampered = payload.replace("500000", "900000");
  assert.equal(verifyWebhookSignature({ payload: tampered, signature, secret, now }).valid, false);
  assert.throws(
    () => verifyWebhookEvent({ payload: tampered, signature, secret, now }),
    FlutterPayWebhookSignatureError,
  );

  // Wrong secret fails.
  assert.equal(
    verifyWebhookSignature({ payload, signature, secret: `${secret}x`, now }).valid,
    false,
  );

  // Expired timestamp outside tolerance window fails.
  const staleNow = new Date("2026-11-22T12:10:00.000Z");
  assert.equal(
    verifyWebhookSignature({ payload, signature, secret, now: staleNow, toleranceSeconds: 300 }).valid,
    false,
  );

  // Duplicate or malformed signature header fails.
  assert.equal(
    verifyWebhookSignature({ payload, signature: `${signature},v1=${"0".repeat(64)}`, secret, now }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({ payload, signature: "not-a-valid-header", secret, now }).valid,
    false,
  );
  assert.equal(
    verifyWebhookSignature({ payload, signature, secret, now, toleranceSeconds: -1 }).valid,
    false,
  );

  // Signed but non-JSON or malformed event payload fails in verifyWebhookEvent.
  const badJson = "{not json";
  const badJsonSig = makeSignature(badJson, secret, timestamp);
  assert.throws(
    () => verifyWebhookEvent({ payload: badJson, signature: badJsonSig, secret, now }),
    FlutterPayWebhookSignatureError,
  );

  const wrongEvent = sampleWebhookPayload({ event: "other.event" });
  const wrongEventSig = makeSignature(wrongEvent, secret, timestamp);
  assert.throws(
    () => verifyWebhookEvent({ payload: wrongEvent, signature: wrongEventSig, secret, now }),
    FlutterPayWebhookSignatureError,
  );
});

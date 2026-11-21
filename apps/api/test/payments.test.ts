import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { normalizeBaseUrl } from "../src/payments.js";
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

const samplePayment = {
  tx_ref: "order-1042",
  amount_kobo: 500_000,
  currency: "NGN",
  customer_email: "buyer@example.com",
  redirect_url: "http://127.0.0.1:4000/callback",
};

function createPayment(url: string, secretKey: string, body: unknown, extraHeaders?: Record<string, string>) {
  return fetch(`${url}/v1/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

test("payment creation and transaction history", async t => {
  const db = await testDatabase(t);

  await t.test("creates a pending transaction and builds the checkout link from appBaseUrl", async t => {
    const fixedNow = new Date("2026-11-21T10:00:00.000Z");
    const url = await testServer(t, db, { appBaseUrl: "http://127.0.0.1:3000/", now: () => fixedNow });
    const account = await registerMerchant(url, "merchant1@example.com");

    const response = await createPayment(url, account.keys.secret_key, {
      ...samplePayment,
      tx_ref: " order-1042 ",
      customer_email: " BUYER@Example.com ",
      redirect_url: " https://merchant.example/callback?step=done ",
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(result.link, `http://127.0.0.1:3000/pay/${result.transaction.id}`);
    assert.deepEqual(result.transaction, {
      id: result.transaction.id,
      tx_ref: "order-1042",
      amount_kobo: 500_000,
      currency: "NGN",
      status: "pending",
      customer_email: "buyer@example.com",
      card_last4: null,
      failure_reason: null,
      redirect_url: "https://merchant.example/callback?step=done",
      expires_at: "2026-11-21T10:30:00.000Z",
      created_at: "2026-11-21T10:00:00.000Z",
    });

    const stored = await db.transaction.findUniqueOrThrow({ where: { id: result.transaction.id } });
    assert.equal(stored.merchantId, account.merchant.id);
    assert.equal(stored.status, "PENDING");
    assert.equal(stored.amountKobo, 500_000);
    assert.equal(stored.currency, "NGN");
    assert.equal(stored.cardLast4, null);
  });

  await t.test("enforces unique tx_ref per merchant, including concurrent requests, while allowing reuse across merchants", async t => {
    const url = await testServer(t, db);
    const merchantA = await registerMerchant(url, "a@example.com");
    const merchantB = await registerMerchant(url, "b@example.com");

    const responses = await Promise.all([
      createPayment(url, merchantA.keys.secret_key, { ...samplePayment, tx_ref: "shared-ref" }),
      createPayment(url, merchantA.keys.secret_key, { ...samplePayment, tx_ref: " shared-ref " }),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const conflict = responses.find(r => r.status === 409)!;
    assert.deepEqual(await conflict.json(), {
      error: { code: "DUPLICATE_TX_REF", message: "A transaction with this tx_ref already exists." },
    });

    const repeat = await createPayment(url, merchantA.keys.secret_key, { ...samplePayment, tx_ref: "shared-ref" });
    assert.equal(repeat.status, 409);

    const otherMerchant = await createPayment(url, merchantB.keys.secret_key, { ...samplePayment, tx_ref: "shared-ref" });
    assert.equal(otherMerchant.status, 201);
    const otherResult = await otherMerchant.json();
    assert.equal(otherResult.transaction.tx_ref, "shared-ref");
  });

  await t.test("rejects unauthenticated, public and revoked keys on both payment and transaction routes", async t => {
    const url = await testServer(t, db);
    const account = await registerMerchant(url, "auth-check@example.com");
    await db.apiKey.update({ where: { keyHash: digest(account.keys.secret_key) }, data: { revokedAt: new Date() } });

    for (const authorization of [undefined, "Bearer wrong", `Bearer ${account.keys.public_key}`, `Bearer ${account.keys.secret_key}`]) {
      const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
      const postRes = await fetch(`${url}/v1/payments`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(samplePayment),
      });
      assert.equal(postRes.status, 401);
      assert.equal(postRes.headers.get("www-authenticate"), "Bearer");

      const getRes = await fetch(`${url}/v1/transactions`, { headers });
      assert.equal(getRes.status, 401);
      assert.equal(getRes.headers.get("www-authenticate"), "Bearer");
    }
  });

  await t.test("validates payment inputs and rejects malformed, oversized or non-JSON requests", async t => {
    const url = await testServer(t, db);
    const account = await registerMerchant(url, "validate@example.com");
    const before = await db.transaction.count({ where: { merchantId: account.merchant.id } });

    const invalidBodies = [
      {},
      { ...samplePayment, tx_ref: "   " },
      { ...samplePayment, tx_ref: "x".repeat(101) },
      { ...samplePayment, tx_ref: "order\n1" },
      { ...samplePayment, amount_kobo: 0 },
      { ...samplePayment, amount_kobo: 99 },
      { ...samplePayment, amount_kobo: -500 },
      { ...samplePayment, amount_kobo: 100_000_001 },
      { ...samplePayment, amount_kobo: 500.5 },
      { ...samplePayment, amount_kobo: "5000" },
      { ...samplePayment, currency: "USD" },
      { ...samplePayment, currency: "ngn" },
      { ...samplePayment, customer_email: "not-an-email" },
      { ...samplePayment, redirect_url: "javascript:alert(1)" },
      { ...samplePayment, redirect_url: "data:text/html,hi" },
      { ...samplePayment, redirect_url: "ftp://example.com/cb" },
      { ...samplePayment, redirect_url: "/relative/callback" },
      { ...samplePayment, redirect_url: "https://user:pass@example.com/cb" },
      { ...samplePayment, redirect_url: `https://example.com/${"a".repeat(2040)}` },
      { ...samplePayment, status: "successful" },
      { ...samplePayment, merchant_id: "spoofed" },
      [],
    ];

    for (const body of invalidBodies) {
      const response = await createPayment(url, account.keys.secret_key, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).error.code, "INVALID_INPUT");
    }

    for (const [contentType, body, status] of [
      ["application/json", '{"tx_ref":"broken",', 400],
      ["application/json", JSON.stringify({ ...samplePayment, tx_ref: "x".repeat(9000) }), 413],
      ["text/plain", "plain text", 415],
    ] as const) {
      const response = await fetch(`${url}/v1/payments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${account.keys.secret_key}`, "Content-Type": contentType },
        body,
      });
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error.code, "string");
    }

    assert.equal(await db.transaction.count({ where: { merchantId: account.merchant.id } }), before);
  });

  await t.test("rejects unsafe APP_BASE_URL values", () => {
    assert.equal(normalizeBaseUrl("http://127.0.0.1:3000///"), "http://127.0.0.1:3000");
    assert.throws(() => normalizeBaseUrl("javascript:alert(1)"));
    assert.throws(() => normalizeBaseUrl("https://user:pass@example.com"));
    assert.throws(() => normalizeBaseUrl("https://example.com/?foo=bar"));
    assert.throws(() => normalizeBaseUrl("https://example.com/#frag"));
  });

  await t.test("lists merchant-isolated transaction history with pagination and daily, weekly and monthly filters", async t => {
    const fixedNow = new Date("2026-11-21T15:00:00.000Z"); // Saturday in ISO week 2026-11-16..2026-11-22
    const url = await testServer(t, db, { now: () => fixedNow });
    const merchantA = await registerMerchant(url, "hist-a@example.com");
    const merchantB = await registerMerchant(url, "hist-b@example.com");

    const seed = async (merchantId: string, txRef: string, isoTime: string, amountKobo = 100_000) => {
      const createdAt = new Date(isoTime);
      await db.transaction.create({
        data: {
          merchantId,
          txRef,
          amountKobo,
          currency: "NGN",
          customerEmail: "buyer@example.com",
          redirectUrl: "http://127.0.0.1:4000/callback",
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
        },
      });
    };

    // Seed transactions across October, previous week, current week, today, and tomorrow UTC.
    await seed(merchantA.merchant.id, "oct-last", "2026-10-31T23:59:59.999Z");
    await seed(merchantA.merchant.id, "nov-start", "2026-11-01T00:00:00.000Z");
    await seed(merchantA.merchant.id, "prev-week-end", "2026-11-15T23:59:59.999Z");
    await seed(merchantA.merchant.id, "week-start", "2026-11-16T00:00:00.000Z");
    await seed(merchantA.merchant.id, "yesterday-end", "2026-11-20T23:59:59.999Z");
    await seed(merchantA.merchant.id, "today-1", "2026-11-21T00:00:00.000Z");
    await seed(merchantA.merchant.id, "today-2", "2026-11-21T12:00:00.000Z");
    await seed(merchantA.merchant.id, "today-3", "2026-11-21T23:59:59.999Z");
    await seed(merchantA.merchant.id, "tomorrow-start", "2026-11-22T00:00:00.000Z");
    await seed(merchantA.merchant.id, "next-week-start", "2026-11-23T00:00:00.000Z");
    await seed(merchantA.merchant.id, "dec-start", "2026-12-01T00:00:00.000Z");

    // Merchant B transaction on the same day must never leak into Merchant A's history.
    await seed(merchantB.merchant.id, "merchant-b-only", "2026-11-21T13:00:00.000Z");

    const getHistory = (secretKey: string, query = "") =>
      fetch(`${url}/v1/transactions${query}`, { headers: { Authorization: `Bearer ${secretKey}` } });

    // Default (all) ordered newest first + pagination
    const page1Res = await getHistory(merchantA.keys.secret_key, "?limit=4&page=1");
    assert.equal(page1Res.status, 200);
    assert.equal(page1Res.headers.get("cache-control"), "no-store");
    const page1 = await page1Res.json();
    assert.deepEqual(page1.period, { type: "all", date: null, from: null, to: null });
    assert.deepEqual(page1.pagination, {
      page: 1, limit: 4, total: 11, total_pages: 3, has_next: true, has_previous: false,
    });
    assert.deepEqual(page1.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), [
      "dec-start", "next-week-start", "tomorrow-start", "today-3",
    ]);

    const page3 = await (await getHistory(merchantA.keys.secret_key, "?limit=4&page=3")).json();
    assert.deepEqual(page3.pagination, {
      page: 3, limit: 4, total: 11, total_pages: 3, has_next: false, has_previous: true,
    });
    assert.deepEqual(page3.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), [
      "prev-week-end", "nov-start", "oct-last",
    ]);

    // Daily (defaults to fixedNow UTC date 2026-11-21) with pagination
    const dailyPage1 = await (await getHistory(merchantA.keys.secret_key, "?period=daily&limit=2&page=1")).json();
    assert.deepEqual(dailyPage1.period, {
      type: "daily",
      date: "2026-11-21",
      from: "2026-11-21T00:00:00.000Z",
      to: "2026-11-22T00:00:00.000Z",
    });
    assert.deepEqual(dailyPage1.pagination, {
      page: 1, limit: 2, total: 3, total_pages: 2, has_next: true, has_previous: false,
    });
    assert.deepEqual(dailyPage1.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), ["today-3", "today-2"]);

    const dailyPage2 = await (await getHistory(merchantA.keys.secret_key, "?period=daily&limit=2&page=2")).json();
    assert.deepEqual(dailyPage2.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), ["today-1"]);

    // Daily with explicit past date
    const yesterday = await (await getHistory(merchantA.keys.secret_key, "?period=daily&date=2026-11-20")).json();
    assert.deepEqual(yesterday.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), ["yesterday-end"]);

    // Weekly (ISO week Mon 2026-11-16 through Sun 2026-11-22) checked on both Saturday (default) and Sunday
    for (const query of ["?period=weekly", "?period=weekly&date=2026-11-22"]) {
      const weekly = await (await getHistory(merchantA.keys.secret_key, query)).json();
      assert.equal(weekly.period.type, "weekly");
      assert.equal(weekly.period.from, "2026-11-16T00:00:00.000Z");
      assert.equal(weekly.period.to, "2026-11-23T00:00:00.000Z");
      assert.deepEqual(weekly.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), [
        "tomorrow-start", "today-3", "today-2", "today-1", "yesterday-end", "week-start",
      ]);
    }

    // Monthly (Nov 2026: [2026-11-01, 2026-12-01))
    const monthly = await (await getHistory(merchantA.keys.secret_key, "?period=monthly")).json();
    assert.deepEqual(monthly.period, {
      type: "monthly",
      date: "2026-11-21",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-12-01T00:00:00.000Z",
    });
    assert.equal(monthly.pagination.total, 9);
    assert.ok(!monthly.transactions.some((tx: { tx_ref: string }) => tx.tx_ref === "oct-last" || tx.tx_ref === "dec-start"));

    // Monthly across year boundary (Dec 2026 -> Jan 2027)
    const dec = await (await getHistory(merchantA.keys.secret_key, "?period=monthly&date=2026-12-15")).json();
    assert.equal(dec.period.from, "2026-12-01T00:00:00.000Z");
    assert.equal(dec.period.to, "2027-01-01T00:00:00.000Z");
    assert.deepEqual(dec.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), ["dec-start"]);

    // Merchant B only sees its own transaction
    const merchantBList = await (await getHistory(merchantB.keys.secret_key)).json();
    assert.deepEqual(merchantBList.transactions.map((tx: { tx_ref: string }) => tx.tx_ref), ["merchant-b-only"]);

    // Empty period returns clean pagination metadata
    const empty = await (await getHistory(merchantB.keys.secret_key, "?period=daily&date=2025-01-01&page=2")).json();
    assert.deepEqual(empty.transactions, []);
    assert.deepEqual(empty.pagination, {
      page: 2, limit: 20, total: 0, total_pages: 0, has_next: false, has_previous: false,
    });
  });

  await t.test("rejects invalid transaction history query parameters", async t => {
    const url = await testServer(t, db);
    const account = await registerMerchant(url, "bad-query@example.com");

    for (const query of [
      "?period=yearly",
      "?date=2026-11-21",
      "?period=all&date=2026-11-21",
      "?period=daily&date=2026-02-30",
      "?period=daily&date=21-11-2026",
      "?page=0",
      "?page=-1",
      "?page=abc",
      "?page=10001",
      "?limit=0",
      "?limit=101",
      "?unknown=1",
      "?page=1&page=2",
    ]) {
      const response = await fetch(`${url}/v1/transactions${query}`, {
        headers: { Authorization: `Bearer ${account.keys.secret_key}` },
      });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "INVALID_INPUT");
    }
  });
});

test("unexpected transaction database errors do not expose internals", async t => {
  const db = await testDatabase(t);
  const url = await testServer(t, db);
  const account = await registerMerchant(url, "tx-failure@example.com");
  await db.$executeRawUnsafe('DROP TABLE "Transaction"');

  const postRes = await createPayment(url, account.keys.secret_key, samplePayment);
  assert.equal(postRes.status, 500);
  assert.deepEqual(await postRes.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });

  const getRes = await fetch(`${url}/v1/transactions`, {
    headers: { Authorization: `Bearer ${account.keys.secret_key}` },
  });
  assert.equal(getRes.status, 500);
  assert.deepEqual(await getRes.json(), {
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as argon2 from "argon2";
import { postJson, testDatabase, testServer } from "./helpers.js";

const password = "a long learning password";
const signup = { business_name: "Ada's business", email: "ada@example.com", password };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("merchant signup and API key authentication", async t => {
  const db = await testDatabase(t);

  await t.test("signup stores password and key hashes and returns credentials once", async t => {
    const url = await testServer(t, db);
    const response = await postJson(url, { ...signup, business_name: " Ada's business ", email: " ADA@Example.com " });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.deepEqual(result.merchant, { id: result.merchant.id, business_name: signup.business_name, email: signup.email });
    assert.match(result.keys.public_key, /^fp_pub_test_[a-f0-9]{64}$/);
    assert.match(result.keys.secret_key, /^fp_sec_test_[a-f0-9]{64}$/);

    const merchant = await db.merchant.findUniqueOrThrow({ where: { id: result.merchant.id }, include: { apiKeys: true } });
    assert.match(merchant.passwordHash, /^\$argon2id\$/);
    assert.equal(await argon2.verify(merchant.passwordHash, password), true);
    assert.equal(await argon2.verify(merchant.passwordHash, "wrong password"), false);
    assert.equal(merchant.apiKeys.length, 2);
    for (const [kind, value] of [["PUBLIC", result.keys.public_key], ["SECRET", result.keys.secret_key]] as const) {
      const key = merchant.apiKeys.find(key => key.kind === kind);
      assert.ok(key);
      assert.equal(key.keyHash, digest(value));
      assert.equal(key.prefix, value.slice(0, 20));
    }
    const stored = JSON.stringify(merchant);
    assert.ok(!stored.includes(password));
    assert.ok(!stored.includes(result.keys.secret_key));
    assert.ok(!stored.includes(result.keys.public_key));

    const me = await fetch(`${url}/v1/merchants/me`, { headers: { Authorization: `Bearer ${result.keys.secret_key}` } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.deepEqual(await me.json(), { merchant: result.merchant });
  });

  await t.test("each secret key authenticates only its own merchant", async t => {
    const url = await testServer(t, db);
    const results = [];
    for (const email of ["one@example.com", "two@example.com"]) {
      const response = await postJson(url, { ...signup, email });
      assert.equal(response.status, 201);
      results.push(await response.json());
    }
    assert.notEqual(results[0].keys.secret_key, results[1].keys.secret_key);
    for (const result of results) {
      const response = await fetch(`${url}/v1/merchants/me`, { headers: { Authorization: `bearer ${result.keys.secret_key}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { merchant: result.merchant });
    }
  });

  await t.test("concurrent duplicate emails produce one account and exactly two keys", async t => {
    const url = await testServer(t, db);
    const responses = await Promise.all([
      postJson(url, { ...signup, email: "Duplicate@Example.com" }),
      postJson(url, { ...signup, email: " duplicate@example.com " }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    const merchant = await db.merchant.findUniqueOrThrow({ where: { email: "duplicate@example.com" }, include: { apiKeys: true } });
    assert.equal(merchant.apiKeys.length, 2);
    assert.deepEqual(await responses.find(response => response.status === 409)!.json(), {
      error: { code: "EMAIL_EXISTS", message: "A merchant with this email already exists." },
    });
  });

  await t.test("invalid fields never create merchant records", async t => {
    const url = await testServer(t, db);
    const before = await db.merchant.count();
    const invalid = [
      {}, { ...signup, business_name: " " }, { ...signup, business_name: "x".repeat(121) },
      { ...signup, email: "invalid" }, { ...signup, password: "short" }, { ...signup, password: "x".repeat(129) },
      { ...signup, role: "admin" }, { ...signup, password: null }, { ...signup, email: 123 }, [],
    ];
    for (const body of invalid) {
      const response = await postJson(url, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).error.code, "INVALID_INPUT");
    }
    assert.equal(await db.merchant.count(), before);
  });

  await t.test("password whitespace is preserved", async t => {
    const url = await testServer(t, db);
    const value = "  twelve characters  ";
    const response = await postJson(url, { ...signup, email: "spaces@example.com", password: value });
    assert.equal(response.status, 201);
    const merchant = await db.merchant.findUniqueOrThrow({ where: { email: "spaces@example.com" } });
    assert.equal(await argon2.verify(merchant.passwordHash, value), true);
    assert.equal(await argon2.verify(merchant.passwordHash, value.trim()), false);
  });

  await t.test("bad JSON, oversized bodies and non-JSON requests have safe JSON errors", async t => {
    const url = await testServer(t, db);
    for (const [contentType, body, status] of [
      ["application/json", '{"password":"do-not-echo",', 400],
      ["application/json", JSON.stringify({ password: "x".repeat(9000) }), 413],
      ["text/plain", "do-not-echo", 415],
    ] as const) {
      const response = await fetch(`${url}/v1/merchants`, { method: "POST", headers: { "Content-Type": contentType }, body });
      assert.equal(response.status, status);
      const result = await response.json();
      assert.equal(typeof result.error.code, "string");
      assert.ok(!JSON.stringify(result).includes("do-not-echo"));
    }
  });

  await t.test("signup is limited to ten requests per minute", async t => {
    const url = await testServer(t, db);
    for (let request = 0; request < 10; request++) assert.equal((await postJson(url, {})).status, 400);
    const response = await postJson(url, {});
    assert.equal(response.status, 429);
    assert.ok(response.headers.has("retry-after"));
    assert.equal((await response.json()).error.code, "RATE_LIMITED");
  });

  await t.test("parser failures count toward the signup request limit", async t => {
    for (const [contentType, body, status] of [
      ["application/json", "{", 400],
      ["application/json", JSON.stringify({ password: "x".repeat(9000) }), 413],
      ["application/json; charset=iso-8859-1", "{}", 415],
    ] as const) {
      const url = await testServer(t, db);
      const send = () => fetch(`${url}/v1/merchants`, { method: "POST", headers: { "Content-Type": contentType }, body });
      for (let request = 0; request < 10; request++) assert.equal((await send()).status, status);
      const response = await send();
      assert.equal(response.status, 429, `Parser errors with status ${status} must count toward the limit`);
      assert.equal((await response.json()).error.code, "RATE_LIMITED");
    }
  });

  await t.test("missing, invalid, public and revoked keys all receive the same 401", async t => {
    const url = await testServer(t, db);
    const signupResponse = await postJson(url, { ...signup, email: "revoked@example.com" });
    assert.equal(signupResponse.status, 201);
    const result = await signupResponse.json();
    const queryOnly = await fetch(`${url}/v1/merchants/me?secret_key=${result.keys.secret_key}`);
    assert.equal(queryOnly.status, 401, "a valid key in the query string must not authenticate");
    await db.apiKey.update({ where: { keyHash: digest(result.keys.secret_key) }, data: { revokedAt: new Date() } });
    // A secret-shaped key backed by a PUBLIC record must still fail authentication.
    const forged = `fp_sec_test_${"b".repeat(64)}`;
    await db.apiKey.create({ data: { merchantId: result.merchant.id, kind: "PUBLIC", keyHash: digest(forged), prefix: forged.slice(0, 20) } });
    for (const authorization of [undefined, "Basic abc", "Bearer wrong", `Bearer fp_sec_test_${"a".repeat(64)}`, `Bearer ${result.keys.public_key}`, `Bearer ${result.keys.secret_key}`, `Bearer ${forged}`]) {
      const response = await fetch(`${url}/v1/merchants/me?secret_key=${result.keys.secret_key}`, { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.deepEqual(await response.json(), { error: { code: "UNAUTHORIZED", message: "A valid secret API key is required." } });
    }
  });
});

test("unexpected database errors do not expose internals", async t => {
  const db = await testDatabase(t);
  const url = await testServer(t, db);
  await db.$executeRawUnsafe('DROP TABLE "ApiKey"');
  const response = await postJson(url, { ...signup, email: "failure@example.com" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
  assert.equal(await db.merchant.count(), 0, "nested key creation failure must roll back the merchant");
  const me = await fetch(`${url}/v1/merchants/me`, { headers: { Authorization: `Bearer fp_sec_test_${"a".repeat(64)}` } });
  assert.equal(me.status, 500);
  assert.deepEqual(await me.json(), { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
});

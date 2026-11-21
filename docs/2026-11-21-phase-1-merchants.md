# Phase 1 implementation plan

Date: 2026-11-21

## Purpose and scope

Implement the approved merchant signup and API key design from Phase 1 of `docs/flutterpay-plan.html`. Open one PR targeting main. Payments, checkout, login, dashboards and key management endpoints remain later phases. The user approved this scope before implementation.

## Data and API contract

Keep the existing Merchant fields. Add an ApiKey table with `id`, `merchantId`, `kind`, `keyHash`, `prefix`, `createdAt` and nullable `revokedAt`. Use an enum for public and secret kinds, a unique index on `keyHash`, and a merchant foreign key. Merchant creation and both key inserts must be atomic.

`POST /v1/merchants` accepts JSON with `business_name`, `email` and `password`. Trim the business name and accept 1 to 120 characters. Trim and lowercase email, validate its format and cap it at 254 characters. Passwords must contain 12 to 128 characters and are not trimmed. Reject unknown fields. Limit JSON bodies to 8 KB. Return 201 with `{ merchant: { id, business_name, email }, keys: { public_key, secret_key } }`. Return 400 for invalid input, 409 for a duplicate normalized email, 413 for oversized bodies and 415 for unsupported content types. Responses containing credentials must use `Cache-Control: no-store`.

Use the maintained argon2 package and Argon2id defaults for password hashing. Generate each key with Node crypto randomBytes, using 32 random bytes encoded as hexadecimal. Prefixes are `fp_pub_test_` and `fp_sec_test_`. Store SHA-256 hashes and a display prefix containing only the first eight random hex characters. Never store or log full keys or plaintext passwords.

`GET /v1/merchants/me` accepts an Authorization Bearer secret key. Validate its shape, look up its hash and require SECRET kind with no revocation date. Attach only the merchant's safe details to response locals for downstream routes. Return 200 with `{ merchant: { id, business_name, email } }`. Missing, malformed, public, unknown and revoked keys all return 401 with the same error body and a Bearer challenge. Never accept credentials from query parameters.

Errors use `{ error: { code, message } }`. Unexpected failures return a generic 500 without database details. Rate limit signup to ten requests per minute per IP with express-rate-limit's process-local store. Keep Express's default proxy trust setting. This local learning API runs as one process.

## Files and build order

- [x] Add dependencies argon2, zod and express-rate-limit after checking their documentation and installed types. Existing libraries do not provide password hashing, input schemas or request limiting.
- [x] Add `test/helpers.ts` for isolated migrated SQLite databases and HTTP fixtures. Add `test/merchants.test.ts` with failing signup, storage, validation, concurrency, authentication, revocation and failure-response tests. Keep the existing health tests.
- [x] Extend `prisma/schema.prisma` and generate a separate migration for ApiKey.
- [x] Implement `src/keys.ts` for key generation and SHA-256, `src/auth.ts` for the middleware, and `src/merchants.ts` for signup and merchant details. Register JSON parsing, routes and JSON error handling in `src/app.ts`.
- [x] Verify missing keys, public keys, forged secret-shaped public keys, revoked keys and keys for two different merchants. Verify uniqueness after email normalization, hashed storage, no secret recovery, input bounds and database error redaction.
- [x] Update README.md with migration instructions, PowerShell request examples, response shapes, errors, hashing choices and rate limits. Record verification here.
- [x] Run the full tests, type check, build and audit. Review the final changes and prepare the branch for the Phase 1 PR against main. Phase 2 requires a separate go-ahead.

Delivery: commit and push `phase-1-merchants`, then open its PR against main.

## Review focus

Check that nested Prisma writes create all three records atomically. Verify the unique constraint handles concurrent signups. Ensure the middleware requires a SECRET record as well as a secret-shaped input. Keep response field selections explicit. Error messages must not include submitted passwords, keys or database information. Authentication must work in the compiled server as well as under tsx.

## Verification record

The initial integration tests failed because signup and merchant details returned 404. After implementation, the tests passed against temporary migrated SQLite databases. The final suite reports 13 passing tests, including the existing health tests. Type checking and the TypeScript build passed. npm audit reports zero vulnerabilities.

A separate reviewer found that signup throttling ran after JSON parsing. A regression test reproduced the bypass. Signup throttling now runs first, and malformed JSON, oversized bodies and unsupported charsets all count toward the limit. The regression and full suite pass.

A separate Node process running the compiled server successfully registered a merchant and authenticated its secret key against a freshly migrated temporary database. No test accounts were added to the development database. Linux and Windows CI remain the remote checks for the PR.

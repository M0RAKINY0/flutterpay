# Phase 2 implementation plan

Date: 2026-11-21

## Purpose and scope

Implement Phase 2 from `docs/flutterpay-plan.html` plus merchant transaction history with daily, weekly and monthly period filtering and pagination. Open one PR targeting `main`. Hosted checkout, fake bank card handling, transaction verification, webhooks, the Node SDK and the merchant dashboard remain later phases.

## Data and API contract

Add a `Transaction` table and `TransactionStatus` enum (`PENDING`, `AWAITING_OTP`, `SUCCESSFUL`, `FAILED`, `ABANDONED`) to `apps/api/prisma/schema.prisma`. Columns: `id`, `merchantId` (FK to `Merchant`), `txRef`, `amountKobo`, `currency`, `status` (default `PENDING`), `customerEmail`, nullable `cardLast4`, `redirectUrl`, `expiresAt`, `createdAt` and `updatedAt`. Enforce `@@unique([merchantId, txRef])` and add `@@index([merchantId, createdAt])`.

`POST /v1/payments` requires secret-key Bearer authentication (`requireSecretKey`) and a JSON body up to 8 KB. It accepts `tx_ref` (trimmed, 1 to 100 printable non-control characters), `amount_kobo` (whole integer from `100` to `100000000`), `currency` (`"NGN"`), `customer_email` (trimmed, lowercased valid email up to 254 chars) and `redirect_url` (`http://` or `https://` URL up to 2048 chars without embedded credentials). Unknown fields are rejected. It sets `expiresAt` to 30 minutes after creation, returns HTTP 201 with `{ transaction, link }` where `link` uses `APP_BASE_URL` (default `http://<HOST>:<PORT>`) rather than trusting request `Host` headers, and returns HTTP 409 `DUPLICATE_TX_REF` when the same merchant reuses `tx_ref`.

`GET /v1/transactions` requires secret-key Bearer authentication and scopes all reads strictly to the authenticated merchant. It accepts optional query parameters: `period` (`all`, `daily`, `weekly`, `monthly`, default `all`), `date` (`YYYY-MM-DD` UTC calendar date, valid only with `daily`, `weekly` or `monthly`, defaulting to today UTC), `page` (1 to 10000, default 1) and `limit` (1 to 100, default 20). Unknown or duplicate query parameters return 400 `INVALID_INPUT`. Results are ordered newest first (`createdAt desc, id desc`) and queried in a Prisma transaction alongside the total count. `weekly` covers the ISO week (Monday 00:00 UTC to next Monday 00:00 UTC); `daily` covers the UTC day; `monthly` covers the UTC calendar month. Responses include `{ transactions, period, pagination }`.

All payment and transaction responses set `Cache-Control: no-store`.

## Files and build order

- [x] Extend `apps/api/prisma/schema.prisma` with `TransactionStatus` and `Transaction`, and generate migration `add_transactions`.
- [x] Add `apps/api/src/transactions.ts` for shared transaction serialization and `GET /v1/transactions` (period windows + pagination).
- [x] Add `apps/api/src/payments.ts` for `POST /v1/payments` validation, persistence, duplicate `tx_ref` handling and checkout link generation.
- [x] Register `/v1/payments` and `/v1/transactions` in `apps/api/src/app.ts` and pass `APP_BASE_URL` in `apps/api/src/server.ts` and `apps/api/.env.example`.
- [x] Add integration tests in `apps/api/test/payments.test.ts` covering creation, validation, concurrency/uniqueness across merchants, auth enforcement, period boundaries (`daily`, `weekly`, `monthly`), pagination, merchant isolation and database error redaction.
- [x] Update `README.md` with payment creation and transaction history examples, rules, errors and configuration.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, `npm audit` and smoke-test the compiled server.

## Verification record

Type checking, the TypeScript build and `npm audit` (0 vulnerabilities) all passed. The integration test suite passed all 22 tests across health, merchant signup/authentication, payment creation, duplicate `tx_ref` concurrency, merchant isolation, daily/weekly/monthly period boundaries, pagination and database failure redaction. A compiled `node apps/api/dist/server.js` smoke test verified signup, payment creation, duplicate `tx_ref` rejection (`409`) and `GET /v1/transactions?period=daily` against a freshly migrated temporary SQLite database.

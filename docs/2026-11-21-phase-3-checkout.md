# Phase 3 implementation plan

Date: 2026-11-21

## Purpose and scope

Implement Phase 3 from `docs/flutterpay-plan.html`: the hosted checkout page (`/pay/:id`) and fake bank card simulator. Open one PR targeting `main`. The merchant transaction verify endpoint (`GET /v1/transactions/:id/verify`), webhooks, Node SDK and merchant dashboard remain later phases.

## Data and API contract

Extend `Transaction` in `apps/api/prisma/schema.prisma` with `otpAttempts Int @default(0)` and `failureReason String?`. Never store or log full card numbers or CVV values; store only `cardLast4`.

Expose checkout routes mounted at `/pay`:
- `GET /pay/:id`: Lazily transitions expired (`now >= expiresAt`) `PENDING` or `AWAITING_OTP` transactions to `ABANDONED`, then renders a server-rendered HTML page (card form for `PENDING`, OTP form for `AWAITING_OTP`, or final status for terminal states) or JSON when requested via `Accept: application/json`.
- `POST /pay/:id/charge`: Accepts form-urlencoded or JSON `{ card_number, expiry, cvv }` (max 8 KB). Validates 16-digit card number, future `MM/YY` (or `MM/YYYY`) expiry and 3-digit CVV. Evaluates test cards via `src/fake-bank.ts` and performs an atomic conditional update (`where: { id, status: "PENDING", expiresAt: { gt: now } }`) so concurrent submits cannot double-charge. Redirects browser forms (`303`) to `/pay/:id` for OTP or to `redirect_url` with `status`, `tx_ref` and `transaction_id` appended on completion; returns JSON for JSON callers.
- `POST /pay/:id/otp`: Accepts form-urlencoded or JSON `{ otp }`. Validates 6 digits. `123456` transitions `AWAITING_OTP` to `SUCCESSFUL`; wrong 6-digit OTP atomically increments `otpAttempts` and transitions to `FAILED` (`"Too many invalid OTP attempts"`) on the 3rd wrong attempt.

All `/pay/*` responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a script-free `Content-Security-Policy`. All dynamic HTML values are escaped.

## Files and build order

- [x] Extend `apps/api/prisma/schema.prisma` with `otpAttempts` and `failureReason`, and generate migration `add_checkout_fields`.
- [x] Add `apps/api/src/fake-bank.ts` with card/OTP validation and test card decision rules.
- [x] Update `apps/api/src/transactions.ts` to expose `failure_reason` in serialized transactions and share `expireTransactionIfNeeded`.
- [x] Add `apps/api/src/checkout.ts` and mount `/pay` in `apps/api/src/app.ts`.
- [x] Add `apps/api/test/checkout.test.ts` covering HTML rendering/escaping, all fake bank test cards, OTP retry/3-strike failure, expiry, terminal state locks and concurrent double-charge prevention.
- [x] Update `postman/flutterpay.postman_collection.json` and `README.md`.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, `npm audit` and `postman collection run`.

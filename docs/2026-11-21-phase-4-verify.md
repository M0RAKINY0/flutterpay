# Phase 4 implementation plan

Date: 2026-11-21

## Purpose and scope

Implement Phase 4 from `docs/flutterpay-plan.html`: the server-side transaction verification endpoint (`GET /v1/transactions/:id/verify`). Webhooks, the Node SDK and the merchant dashboard remain later phases.

## Data and API contract

No database schema changes are required; `Transaction` already stores `id`, `merchantId`, `txRef`, `amountKobo`, `currency`, `status`, `customerEmail`, `cardLast4`, `failureReason`, `redirectUrl`, `expiresAt` and `createdAt`.

Expose `GET /v1/transactions/:id/verify` on `transactionRoutes` (`apps/api/src/transactions.ts`):
- Requires secret-key Bearer authentication (`requireSecretKey`). Missing, malformed, unknown, public and revoked keys return `401 UNAUTHORIZED` with `WWW-Authenticate: Bearer`.
- Enforces strict merchant isolation: both the lazy expiry update (`expireTransactionIfNeeded(db, id, now(), merchantId)`) and lookup (`findFirst({ where: { id, merchantId } })`) scope to the authenticated merchant.
- Returns `404 NOT_FOUND` (`{ error: { code: "NOT_FOUND", message: "Transaction not found." } }`) when the transaction does not exist or belongs to another merchant, without leaking existence or mutating another merchant's row.
- Lazily transitions expired (`now >= expiresAt`) `PENDING` or `AWAITING_OTP` transactions owned by the merchant to `ABANDONED` (`failureReason: "Payment link expired"`) before returning.
- Returns `200 OK` with `{ transaction }` serialized via `serializeTransaction`, and `Cache-Control: no-store`.

## Files and build order

- [x] Update `expireTransactionIfNeeded` in `apps/api/src/transactions.ts` to support optional `merchantId` scoping and add `GET /:id/verify`.
- [x] Add `apps/api/test/verify.test.ts` covering pending/successful/OTP/failed verification, cross-merchant `404` isolation, unknown ID `404`, lazy expiry to `abandoned`, auth rejection and database error redaction.
- [x] Verify end-to-end with Postman CLI and remove the unused `postman/` folder and script.
- [x] Update `README.md` with verification usage, `404 NOT_FOUND` error documentation and next steps.
- [x] Run `npm run typecheck`, `npm test` and `npm run build`.

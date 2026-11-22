# Phase 6 implementation plan

Date: 2026-11-22

## Purpose and scope

Implement Phase 6 from `docs/flutterpay-plan.html`: the `@flutterpay/sdk-node` TypeScript Node SDK (`packages/sdk-node`) providing `payments.create()`, `transactions.verify()`, `transactions.list()`, `webhooks.verify()`, `webhooks.verifySignature()`, and `webhooks.listDeliveries()`, with typed error classes, an end-to-end runnable example, and unit + live integration tests. The merchant dashboard remains Phase 7.

## SDK contract

Package: `packages/sdk-node` (`@flutterpay/sdk-node`, ESM, zero runtime dependencies, Node >=22.20).

Client (`packages/sdk-node/src/client.ts`):
- `new FlutterPay({ secretKey, baseUrl?, timeoutMs?, fetch? })` validates configuration upfront (non-empty `secretKey` without whitespace/control characters, `http://` or `https://` `baseUrl` without embedded credentials/query/hash, integer `timeoutMs` between `1` and `2_147_483_647` on both client construction and per-request overrides).
- Sends `Authorization: Bearer <secretKey>`, `Accept: application/json`, and `redirect: "manual"` to avoid leaking credentials across redirects.
- `payments.create(input, options?)`: `POST /v1/payments` returning `{ transaction, link }`.
- `transactions.verify(transactionId, options?)`: rejects empty/path-separating IDs, calls `GET /v1/transactions/:id/verify` returning `{ transaction }`.
- `transactions.list(params?, options?)`: `GET /v1/transactions` with `period`, `date`, `page`, `limit`.
- `webhooks.verify(options)` / `webhooks.verifySignature(options)` / `webhooks.listDeliveries(params?, options?)`.

Typed errors (`packages/sdk-node/src/errors.ts`):
- `FlutterPayError` (base)
- `FlutterPayConfigError`
- `FlutterPayNetworkError` (`isTimeout`)
- `FlutterPayApiError` (`status`, `code`) with subclasses:
  - `FlutterPayValidationError` (400)
  - `FlutterPayAuthenticationError` (401)
  - `FlutterPayNotFoundError` (404)
  - `FlutterPayConflictError` (409)
  - `FlutterPayRateLimitError` (429, `retryAfter`)
- `FlutterPayWebhookSignatureError` (`reason`)

Webhook verification (`packages/sdk-node/src/webhooks.ts`):
- `verifyWebhookSignature` validates `X-FlutterPay-Signature` (`t=<unix>,v1=<hex>`), rejects malformed/duplicate header segments, enforces replay tolerance (default 300s), and uses `crypto.timingSafeEqual` over `${timestamp}.${rawPayload}`.
- `verifyWebhookEvent` (also exposed as `client.webhooks.verify`) verifies the signature, parses UTF-8 JSON, validates the `charge.completed` event shape, and throws `FlutterPayWebhookSignatureError` on failure.

## Verification

- [x] `packages/sdk-node` workspace setup (`package.json`, `tsconfig.json`, `tsconfig.build.json`) and root `package.json` scripts.
- [x] SDK source (`src/errors.ts`, `src/types.ts`, `src/webhooks.ts`, `src/client.ts`, `src/index.ts`).
- [x] Runnable end-to-end example (`examples/payment-flow.ts`).
- [x] Unit tests (`test/sdk.unit.test.ts`) and live integration tests (`test/sdk.integration.test.ts`) against `@flutterpay/api`, hosted checkout, verification, merchant isolation, webhook signature checks, and duplicate delivery handling.
- [x] Update `README.md`, `package-lock.json`, and verify `npm run typecheck`, `npm test`, and `npm run build`.

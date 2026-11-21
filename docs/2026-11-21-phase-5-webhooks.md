# Phase 5 implementation plan

Date: 2026-11-21

## Purpose and scope

Implement Phase 5 from `docs/flutterpay-plan.html`: HMAC-signed `charge.completed` webhooks with retry scheduling (1, 5 and 30 minutes) and per-attempt delivery logs. The Node SDK and merchant dashboard remain Phases 6 and 7.

## Data and API contract

Extend `apps/api/prisma/schema.prisma` (migration `add_webhooks`):
- `Merchant`: add nullable `webhookUrl` and recoverable `webhookSecret` (`fp_whsec_test_<64 hex>`, required to compute outbound HMAC signatures).
- `WebhookDeliveryStatus` enum (`PENDING`, `PROCESSING`, `DELIVERED`, `FAILED`) and `WebhookDelivery` table (`id`, `eventId`, `transactionId`, `event`, `targetUrl`, `payload`, `attempt`, `status`, `claimToken`, `claimExpiresAt`, `responseCode`, `errorMessage`, `nextRetryAt`, `attemptedAt`, `createdAt`) with `@@unique([eventId, attempt])`, `@@index([status, nextRetryAt])`, `@@index([status, claimExpiresAt])` and `@@index([transactionId, createdAt])`.

Transactional outbox, signing & delivery (`apps/api/src/webhooks.ts`):
- Every terminal payment transition in `apps/api/src/checkout.ts` (`SUCCESSFUL` or `FAILED` via direct charge or OTP) updates the `Transaction` and creates attempt #1 of `charge.completed` inside the same `db.$transaction`; HTTP dispatch happens only after commit.
- Every outbound `POST` includes `X-FlutterPay-Event`, `X-FlutterPay-Event-Id`, `X-FlutterPay-Timestamp` and `X-FlutterPay-Signature: t=<unix_sec>,v1=<hmac_sha256_hex>`, where the digest signs `${timestamp}.${rawBody}` with `merchant.webhookSecret`.
- `verifyWebhookSignature` validates format, replay tolerance (default 5 minutes) and constant-time HMAC equality via `crypto.timingSafeEqual`.
- Deliveries are claimed atomically with an expiring lease (`claimToken` + `claimExpiresAt`, 30s default). Result writes verify ownership (`status: "PROCESSING", claimToken`) so a stalled worker cannot clobber a recovered claim. Expired `PROCESSING` leases are reclaimed and redelivered with the same `eventId` for receiver deduplication.
- Non-`2xx` responses (including `3xx` with `redirect: "manual"`), timeouts (5s), network errors and thrown senders mark the attempt `FAILED` and schedule the next attempt after 1 min, 5 min, and 30 min (4 attempts total).
- Pending retries resolve the merchant's current `webhookUrl` and `webhookSecret` together. Disabling webhooks (`webhook_url: null`) cancels pending deliveries in the same transaction.
- Local loopback URLs are intentionally permitted for local development/testing; production deployments exposed to untrusted merchants must enforce outbound IP/DNS SSRF filtering.
- `startWebhookWorker` polls due/expired deliveries in `apps/api/src/server.ts`, logs background failures safely without secrets/payloads, and drains active deliveries before disconnecting Prisma on shutdown.

Merchant endpoints (secret-key authenticated, `Cache-Control: no-store`):
- `GET /v1/merchants/me/webhook`: returns `{ webhook: { url, secret_configured } }` without exposing the secret.
- `PUT /v1/merchants/me/webhook`: transactionally sets `webhook_url` (valid `http(s)` URL without embedded credentials, or `null` to disable and cancel pending retries) and returns `secret` only when newly generated or explicitly rotated (`rotate_secret: true`).
- `GET /v1/webhooks/deliveries`: paginated delivery attempt history (optional `?transaction_id=...`), strictly isolated to the authenticated merchant.

## Files and build order

- [x] Extend `apps/api/prisma/schema.prisma` and create migration `add_webhooks`.
- [x] Add `apps/api/src/webhooks.ts` with HMAC signing/verification, transactional outbox enqueueing, expiring lease claims with ownership checks, retry scheduling, background worker/tracker with shutdown draining and `GET /v1/webhooks/deliveries`.
- [x] Add `GET /v1/merchants/me/webhook` and transactional `PUT /v1/merchants/me/webhook` in `apps/api/src/merchants.ts`.
- [x] Enqueue webhooks atomically inside checkout completion transactions in `apps/api/src/checkout.ts`, mount `/v1/webhooks` in `apps/api/src/app.ts` and drain the worker in `apps/api/src/server.ts`.
- [x] Add `apps/api/test/webhooks.test.ts` covering independent HMAC vector, live HTTP delivery, `1m -> 5m -> 30m` retries, atomic rollback on enqueue failure, expired `PROCESSING` lease recovery, stale-owner protection, timeouts/network errors, config rotation/disable policies and merchant isolation.
- [x] Update `README.md` and run `npm run typecheck`, `npm test` and `npm run build`.

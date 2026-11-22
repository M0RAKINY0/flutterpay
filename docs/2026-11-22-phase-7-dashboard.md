# Phase 7 implementation plan

Date: 2026-11-22

## Purpose and scope

Implement Phase 7 from `docs/flutterpay-plan.html`: merchant sessions, immediate API key rotation, and the server-rendered merchant dashboard (`apps/dashboard`) for logging in, viewing transactions and webhook attempts, configuring webhook URLs, and replacing leaked API keys.

## Data and API contract

Extend `apps/api/prisma/schema.prisma` (migration `add_merchant_sessions`):
- `MerchantSession`: `id`, `merchantId`, `tokenHash` (`@unique`, SHA-256 of 32-byte random cookie token), `csrfToken` (32-byte random hex), `expiresAt` (24h TTL), `revokedAt`, `createdAt`.

Session & key rotation endpoints in `apps/api`:
- `POST /v1/sessions` (rate-limited 10 req/min/IP): validates email/password with Argon2id (with dummy hash verification to avoid timing leaks), stores hashed session token, sets `fp_session` (`HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`, plus `Secure` over HTTPS), returns `{ session: { id, expires_at, csrf_token }, merchant }`.
- `GET /v1/sessions/me`: returns active session info and merchant for a valid `fp_session` cookie.
- `POST /v1/sessions/logout`: requires valid `fp_session` cookie and constant-time verified `X-CSRF-Token`, revokes the session, and clears the cookie.
- `requireMerchantAuth` (`apps/api/src/auth.ts`): supports either `Authorization: Bearer <secret_key>` (strict — never falls back to cookies when an `Authorization` header is present) or a valid `fp_session` cookie (requiring `X-CSRF-Token` on state-changing routes) on dashboard-used endpoints (`GET /v1/merchants/me`, `GET /v1/merchants/me/keys`, `POST /v1/merchants/me/keys/rotate`, `GET/PUT /v1/merchants/me/webhook`, `GET /v1/transactions`, `GET /v1/webhooks/deliveries`).
- `GET /v1/merchants/me/keys`: returns key metadata (`id`, `kind`, `prefix`, `active`, `created_at`, `revoked_at`) without hashes or plaintext secrets.
- `POST /v1/merchants/me/keys/rotate`: atomically revokes all active keys of the requested `kind` (`"secret"` or `"public"`) and creates a fresh key inside `db.$transaction`, returning the new plaintext key once (`Cache-Control: no-store`). Replaced secret keys fail with `401 UNAUTHORIZED` immediately.

## Merchant dashboard (`apps/dashboard`)

Server-rendered Express TypeScript app (`@flutterpay/dashboard`, default `http://127.0.0.1:3001`, backed by `@flutterpay/api` at `API_BASE_URL`):
- Security headers on all responses (`Cache-Control: no-store`, strict CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`), HTML escaping via `escapeHtml()`, same-origin `Origin` checks on `POST`, per-client login/signup rate limiting at the dashboard edge (plus optional `DASHBOARD_PROXY_SECRET` trusted client-IP forwarding to `@flutterpay/api`), and per-session `_csrf` tokens forwarded as `X-CSRF-Token` to the API.
- Failure resilience: session cookies are cleared only on `401` (never on transient `5xx` errors), logout fails honestly (`502`) when revocation fails, and one-time issued secrets (signup keys, rotated API keys, webhook signing secrets) are always rendered even if supplementary history fetches fail.
- Routes: `/login`, `/signup`, `/logout`, `/` & `/transactions` (period filters & pagination), `/webhooks` (set/rotate/disable webhook URL + delivery attempts log with optional `transaction_id` filter), `/keys` & `/keys/rotate` (list active/revoked keys + replace leaked secret/public keys).

## Verification

- [x] Prisma `MerchantSession` schema + migration `add_merchant_sessions`.
- [x] Session routes (`apps/api/src/sessions.ts`), dual auth (`apps/api/src/auth.ts`), key listing & atomic rotation (`apps/api/src/merchants.ts`).
- [x] Server-rendered dashboard workspace (`apps/dashboard`).
- [x] Integration tests (`apps/api/test/sessions.test.ts` and `apps/dashboard/test/dashboard.test.ts`) verifying login, cookies, CSRF, transactions, webhooks, logout, and immediate rejection of replaced secret keys.
- [x] Update `package.json`, `package-lock.json`, `README.md`, and verify `npm run typecheck`, `npm test`, and `npm run build`.

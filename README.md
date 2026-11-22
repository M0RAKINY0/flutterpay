# FlutterPay

FlutterPay is a payment gateway simulator for learning backend development. The finished project will let a merchant create a payment, send a customer to checkout, verify the result and receive a signed webhook through a Node SDK. All payments will be simulated.

Phases 0 to 6 are implemented. The API runs locally, queries SQLite through Prisma, registers merchants, authenticates secret API keys, creates pending payments, serves the hosted checkout page with a fake bank card simulator, lists paginated merchant transaction history, verifies transactions server-side with merchant isolation, delivers HMAC-signed `charge.completed` webhooks with retries and attempt logs, and ships the `@flutterpay/sdk-node` TypeScript Node SDK. The merchant dashboard is the next phase.

## Run it

Install Node.js 22.20 or a newer Node 22 release. npm comes with Node. You do not need Docker or a separate database server.

Open a terminal in this repository and run:

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run dev
```

Open <http://127.0.0.1:3000/health>. You should see:

```json
{ "ok": true }
```

The health route queries the Merchant table. If the database is unavailable or its migration has not run, it returns HTTP 503 and `{ "ok": false }`.

Press Ctrl+C in the terminal to stop the server.

## What those commands do

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the versions recorded in package-lock.json. |
| `npm run db:generate` | Generate the TypeScript database client from the Prisma schema. |
| `npm run db:deploy` | Apply committed migrations to your local SQLite file. Safe to repeat. |
| `npm run dev` | Start the API and restart it when you save code. |
| `npm run db:studio` | Open Prisma's database viewer. |
| `npm run db:migrate -- --name describe_change` | Create and apply a migration after you change the schema. |
| `npm test` | Test health, merchant signup, API key authentication, payment creation, transaction history, hosted checkout, transaction verification and webhooks against temporary SQLite databases. |
| `npm run typecheck` | Check TypeScript without building. |
| `npm run build` | Generate the database client and compile the API into apps/api/dist. |
| `npm start` | Run the compiled API after building and applying migrations. |

A migration is a saved SQL change to the database structure. The initial migration creates the Merchant table, Phase 1 adds ApiKey records linked to merchants, Phase 2 adds Transaction records, Phase 3 adds checkout fields, and Phase 5 adds merchant webhook settings and WebhookDelivery logs. Run `npm run db:deploy` after pulling new migrations.

## Register a merchant

With the server running, open another PowerShell terminal:

```powershell
$body = @{
  business_name = "Ada's business"
  email = "ada@example.com"
  password = "a-long-learning-password"
} | ConvertTo-Json

$account = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/merchants -ContentType application/json -Body $body
$account.keys
```

The endpoint returns HTTP 201 with this shape. The key values below are placeholders:

```json
{
  "merchant": {
    "id": "generated-merchant-id",
    "business_name": "Ada's business",
    "email": "ada@example.com"
  },
  "keys": {
    "public_key": "fp_pub_test_<64 random hex characters>",
    "secret_key": "fp_sec_test_<64 random hex characters>"
  }
}
```

Save the secret key from this response. FlutterPay cannot retrieve it later. A repeat signup with the same email returns 409. Keep secret keys on the merchant's server. Public keys do not authenticate backend API calls.

Signup accepts exactly these fields:

| Field | Rules |
| --- | --- |
| `business_name` | 1 to 120 characters after trimming surrounding whitespace. |
| `email` | Valid email, at most 254 characters after trimming. Stored lowercase. |
| `password` | 12 to 128 characters. Whitespace is preserved. |

JSON bodies must not exceed 8 KB. Signup allows ten requests per minute per IP, including invalid submissions. The limiter stores counters in this API process and resets on restart. Express does not trust forwarded IP headers. The current application runs locally as one process.

## Authenticate a request

Use the secret key returned by signup:

```powershell
$headers = @{ Authorization = "Bearer $($account.keys.secret_key)" }
Invoke-RestMethod -Uri http://127.0.0.1:3000/v1/merchants/me -Headers $headers
```

`GET /v1/merchants/me` returns only the authenticated merchant's ID, business name and email. It reads keys only from the Authorization header. Missing, malformed, unknown, public and revoked keys all return the same 401 response. Key revocation is checked on every request. The endpoint for revoking or replacing keys belongs to the dashboard phase.

Merchant responses use `Cache-Control: no-store`. The database stores [Argon2id password hashes](https://github.com/ranisalt/node-argon2), SHA-256 API key hashes and display prefixes. It never stores plaintext passwords or complete API keys. The signup operation saves the merchant and both keys atomically.

Input validation uses [Zod](https://zod.dev/api). Signup throttling uses [express-rate-limit](https://express-rate-limit.mintlify.app/overview). Node's crypto module generates 32 random bytes for each key and computes its SHA-256 hash.

## Create a payment

Using the `$headers` from above, create a pending payment (amount is in whole kobo, so ₦5,000 is `500000`):

```powershell
$paymentBody = @{
  tx_ref = "order-1042"
  amount_kobo = 500000
  currency = "NGN"
  customer_email = "buyer@example.com"
  redirect_url = "http://127.0.0.1:4000/callback"
} | ConvertTo-Json

$payment = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/payments -Headers $headers -ContentType application/json -Body $paymentBody
$payment
```

`POST /v1/payments` returns HTTP 201 with `{ transaction, link }`. Reusing the same `tx_ref` for the same merchant returns `409 DUPLICATE_TX_REF`. Two different merchants may use the same `tx_ref`. Payment links expire 30 minutes after creation (enforced when hosted checkout is added in Phase 3).

Payment creation accepts exactly these fields:

| Field | Rules |
| --- | --- |
| `tx_ref` | 1 to 100 printable characters after trimming. Unique per merchant. |
| `amount_kobo` | Whole integer from `100` (₦1) to `100000000` (₦1,000,000). |
| `currency` | Must be `"NGN"`. |
| `customer_email` | Valid email, at most 254 characters after trimming. Stored lowercase. |
| `redirect_url` | Valid `http://` or `https://` URL without embedded credentials, at most 2048 characters. |

## List transaction history

Fetch paginated transactions belonging to the authenticated merchant, optionally filtered by UTC calendar period (`daily`, `weekly` Monday–Sunday, or `monthly`):

```powershell
# Latest page across all transactions
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/transactions?page=1&limit=20" -Headers $headers

# Today's transactions (UTC)
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/transactions?period=daily" -Headers $headers

# Specific week or month (UTC)
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/transactions?period=weekly&date=2026-11-21" -Headers $headers
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/transactions?period=monthly&date=2026-11-01&page=1&limit=10" -Headers $headers
```

| Query parameter | Rules |
| --- | --- |
| `period` | Optional: `all` (default), `daily`, `weekly` (ISO Mon–Sun UTC) or `monthly` (UTC calendar month). |
| `date` | Optional `YYYY-MM-DD` UTC anchor date. Only allowed with `daily`, `weekly` or `monthly` (defaults to today UTC). |
| `page` | Optional positive integer, `1` to `10000` (default `1`). |
| `limit` | Optional positive integer, `1` to `100` (default `20`). |

The response returns `{ transactions, period, pagination }`, ordered newest first, and never exposes another merchant's transactions.

## Hosted checkout & fake bank

Open the `link` returned by `POST /v1/payments` (e.g. `http://127.0.0.1:3000/pay/<id>`) in a browser, or submit JSON directly to `POST /pay/:id/charge` and `POST /pay/:id/otp`. Any future `MM/YY` expiry date and any 3-digit CVV work. Full card numbers and CVVs are never stored—only `card_last4`.

| Test card | Fake bank behaviour |
| --- | --- |
| `4242 4242 4242 4242` | Approves immediately (`successful`). |
| `5060 9900 0000 0001` | Requires OTP (`awaiting_otp`). `123456` approves; 3 wrong OTPs fail the payment. |
| `4000 0000 0000 0002` | Declines (`failed`, `"Card blocked"`). |
| `4000 0000 0000 9995` | Declines (`failed`, `"Insufficient funds"`). |

Unpaid links expire to `abandoned` after 30 minutes. Once a transaction reaches `successful`, `failed` or `abandoned`, it cannot be charged again. On completion, browser forms redirect (`303`) to `redirect_url` with `status`, `tx_ref` and `transaction_id` query parameters.

## Verify a transaction

Never trust the `status` query parameter on your callback redirect—a customer can edit browser URLs. Always confirm the result from your server using your secret API key:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/transactions/$($payment.transaction.id)/verify" -Headers $headers
```

`GET /v1/transactions/:id/verify` returns HTTP 200 with `{ transaction }` (including `status`, `amount_kobo`, `currency`, `tx_ref`, `card_last4` and `failure_reason`), lazily transitioning unpaid expired links to `abandoned`. A merchant can only verify its own transactions; requesting another merchant's transaction ID or an unknown ID returns `404 NOT_FOUND`.

## Webhooks

Configure a webhook URL for your merchant using your secret API key:

```powershell
$webhookBody = @{ webhook_url = "http://127.0.0.1:4000/webhook" } | ConvertTo-Json
$webhook = Invoke-RestMethod -Method Put -Uri http://127.0.0.1:3000/v1/merchants/me/webhook -Headers $headers -ContentType application/json -Body $webhookBody
$webhook.webhook
```

This generates a signing secret (`fp_whsec_test_<64 hex chars>`) and returns it once. Updating `webhook_url` later preserves the existing secret (returning `secret: null`) unless you pass `"rotate_secret": true`. Passing `"webhook_url": null` disables webhooks and cancels pending retries. `GET /v1/merchants/me/webhook` reports `{ url, secret_configured }` without exposing the secret.

Pending retries always use the merchant's current `webhook_url` and `webhook_secret` together so changing endpoints or rotating secrets never sends a delivery to an old URL signed with a new secret. Because FlutterPay must compute outbound HMAC signatures, `webhookSecret` is stored recoverable in SQLite (unlike API keys, which are one-way SHA-256 hashed). Outbound webhook delivery intentionally permits loopback/`localhost` URLs for local testing; before exposing this API to untrusted merchants in production, enforce outbound IP/DNS SSRF filtering at connection time.

When a payment completes (`successful` or `failed`), FlutterPay sends a `POST` request with `event: "charge.completed"` and these headers:
- `X-FlutterPay-Event`: `charge.completed`
- `X-FlutterPay-Event-Id`: stable event ID across retries for idempotent processing
- `X-FlutterPay-Timestamp`: Unix timestamp in seconds
- `X-FlutterPay-Signature`: `t=<timestamp>,v1=<hex_hmac_sha256>` computed over `${timestamp}.${rawBody}` using your webhook secret

If your endpoint returns a non-`2xx` response or times out, FlutterPay logs the failed attempt and schedules retries after **1 minute**, **5 minutes**, and **30 minutes** (4 attempts total). Inspect delivery attempts with:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/v1/webhooks/deliveries?transaction_id=$($payment.transaction.id)" -Headers $headers
```

## Node SDK (`packages/sdk-node`)

Install/use `@flutterpay/sdk-node` from this workspace to call FlutterPay from Node.js with typed errors and webhook signature verification:

```ts
import {
  FlutterPay,
  FlutterPayConflictError,
  FlutterPayWebhookSignatureError,
  WEBHOOK_SIGNATURE_HEADER,
} from "@flutterpay/sdk-node";

const flutterpay = new FlutterPay({
  secretKey: process.env.FLUTTERPAY_SECRET_KEY!,
  baseUrl: "http://127.0.0.1:3000",
});

// 1. Create a payment
const { transaction, link } = await flutterpay.payments.create({
  tx_ref: "order-1042",
  amount_kobo: 500_000,
  currency: "NGN",
  customer_email: "buyer@example.com",
  redirect_url: "http://127.0.0.1:4000/callback",
});

// 2. Verify a transaction server-side
const verified = await flutterpay.transactions.verify(transaction.id);

// 3. Verify incoming webhooks (and deduplicate by event.id)
const event = flutterpay.webhooks.verify({
  payload: rawRequestBody,
  signature: requestHeaders[WEBHOOK_SIGNATURE_HEADER],
  secret: process.env.FLUTTERPAY_WEBHOOK_SECRET!,
});
```

With the API running (`npm run dev`), run the end-to-end SDK example in another terminal:

```sh
npm run example --workspace=@flutterpay/sdk-node
```

The SDK exports typed errors (`FlutterPayConfigError`, `FlutterPayValidationError`, `FlutterPayAuthenticationError`, `FlutterPayNotFoundError`, `FlutterPayConflictError`, `FlutterPayRateLimitError`, `FlutterPayApiError`, `FlutterPayNetworkError`, and `FlutterPayWebhookSignatureError`).

## API errors

Errors contain a stable code and a readable message:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "A valid secret API key is required."
  }
}
```

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Invalid fields or malformed JSON. |
| 401 | `UNAUTHORIZED` | Missing or unusable secret key. |
| 404 | `NOT_FOUND` | Payment or transaction does not exist (or belongs to another merchant). |
| 409 | `EMAIL_EXISTS` | The normalized email already belongs to a merchant. |
| 409 | `DUPLICATE_TX_REF` | This merchant already created a transaction with the same `tx_ref`. |
| 413 | `BODY_TOO_LARGE` | JSON body exceeds 8 KB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported content type, charset or encoding. |
| 429 | `RATE_LIMITED` | Signup limit reached. Wait for the Retry-After interval. |
| 500 | `INTERNAL_ERROR` | Unexpected failure. Database details and submitted credentials are omitted. |

## Configuration

The defaults work without an environment file. To change them, copy `apps/api/.env.example` to `apps/api/.env`. On PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite database file. |
| `HOST` | `127.0.0.1` | Bind to this computer for local development. |
| `PORT` | `3000` | HTTP port. |
| `APP_BASE_URL` | `http://<HOST>:<PORT>` | Base URL used when generating checkout links. |

Run commands from the repository root using the npm scripts above. npm runs the API scripts inside `apps/api`, so Prisma CLI and the application resolve the database path to the same file, `apps/api/prisma/dev.db`. Both load `apps/api/.env`. The file contains local settings and stays out of Git, as does the database.

## Project layout

```text
apps/api/
  prisma/                 Database schema and migration history
  prisma.config.ts        Prisma CLI configuration
  src/app.ts              Express routes
  src/merchants.ts        Signup and merchant details endpoints
  src/payments.ts         Payment creation endpoint and checkout link builder
  src/transactions.ts     Transaction serialization, paginated history and verify endpoint
  src/webhooks.ts         HMAC webhook signing, retry queue worker and delivery log endpoint
  src/checkout.ts         Hosted checkout pages, charge/OTP handlers and redirects
  src/fake-bank.ts        Test card and OTP simulation rules
  src/auth.ts             Secret key authentication middleware
  src/keys.ts             Random key generation and hashing
  src/db.ts               Prisma client and SQLite connection
  src/server.ts           HTTP listener and shutdown
  test/health.test.ts      HTTP and database integration tests
  test/merchants.test.ts   Signup, storage, authentication and failure tests
  test/payments.test.ts    Payment creation, uniqueness, history periods and pagination tests
  test/checkout.test.ts    Checkout UI, fake bank, OTP retries, expiry and concurrency tests
  test/verify.test.ts      Server-side verification, tenant isolation and expiry tests
  test/webhooks.test.ts    HMAC signing, live delivery, retry backoff and isolation tests
packages/sdk-node/
  src/client.ts           FlutterPay client (payments, transactions, webhooks)
  src/webhooks.ts         Standalone HMAC signature & event verification
  src/errors.ts           Typed error classes
  src/types.ts            API & webhook TypeScript contracts
  src/index.ts            Public package exports
  examples/payment-flow.ts Runnable end-to-end SDK + webhook receiver example
  test/sdk.unit.test.ts   Config, error mapping and webhook verification unit tests
  test/sdk.integration.test.ts Live integration tests against the API
docs/
  flutterpay-plan.html     Visual roadmap for all phases
  2026-11-21-project-setup.md
  2026-11-21-phase-1-merchants.md
  2026-11-21-phase-2-payments.md
  2026-11-21-phase-3-checkout.md
  2026-11-21-phase-4-verify.md
  2026-11-21-phase-5-webhooks.md
  2026-11-22-phase-6-sdk-node.md
```

The root package.json uses npm workspaces. It runs `typecheck`, `test`, and `build` across `@flutterpay/api` and `@flutterpay/sdk-node`. We will add `apps/dashboard` in Phase 7. A demo shop is outside the project scope.

Prisma uses its [documented SQLite adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite). The generated client and compiled JavaScript stay out of Git. Commit changes to the schema and its migration together. The lockfile records dependency versions for local installs and CI.

The root package.json overrides Prisma config's Effect dependency to 3.22.5. Prisma 7.10.1 pins an older version affected by [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw). The override keeps the patched release within Effect 3.

GitHub Actions installs dependencies, applies migrations, checks types, runs the tests and builds the API on Linux and Windows.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/) enforced locally with Husky + Commitlint (`.husky/commit-msg`, `commitlint.config.mjs`) and in CI (`.github/workflows/commitlint.yml`):

```text
<type>(optional-scope): <short description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`, `revert`.

Examples:

- `feat(api): add webhook signing secret generation`
- `fix(checkout): reject expired card submissions`
- `docs: update local setup instructions`

Running `npm install` or `npm ci` installs the Git hooks automatically via the `prepare` script.

## Next step

Phase 7 adds the merchant dashboard (`apps/dashboard`) for logging in, viewing transactions and webhook attempts, configuring webhook URLs, and replacing leaked API keys. See the [visual build plan](docs/flutterpay-plan.html) and the [Phase 6 implementation plan](docs/2026-11-22-phase-6-sdk-node.md).

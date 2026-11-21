# FlutterPay

FlutterPay is a payment gateway simulator for learning backend development. The finished project will let a merchant create a payment, send a customer to checkout, verify the result and receive a signed webhook through a Node SDK. All payments will be simulated.

Phases 0 and 1 are implemented. The API runs locally, queries SQLite through Prisma, registers merchants and authenticates secret API keys. Payment creation, checkout, webhooks and the SDK are the next phases.

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
| `npm test` | Test health, merchant signup and API key authentication against temporary SQLite databases. |
| `npm run typecheck` | Check TypeScript without building. |
| `npm run build` | Generate the database client and compile the API into apps/api/dist. |
| `npm start` | Run the compiled API after building and applying migrations. |

A migration is a saved SQL change to the database structure. The initial migration creates the Merchant table. The Phase 1 migration adds ApiKey records linked to merchants. Run `npm run db:deploy` after pulling new migrations.

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
| 409 | `EMAIL_EXISTS` | The normalized email already belongs to a merchant. |
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

Run commands from the repository root using the npm scripts above. npm runs the API scripts inside `apps/api`, so Prisma CLI and the application resolve the database path to the same file, `apps/api/prisma/dev.db`. Both load `apps/api/.env`. The file contains local settings and stays out of Git, as does the database.

## Project layout

```text
apps/api/
  prisma/                 Database schema and migration history
  prisma.config.ts        Prisma CLI configuration
  src/app.ts              Express routes
  src/merchants.ts        Signup and merchant details endpoints
  src/auth.ts             Secret key authentication middleware
  src/keys.ts             Random key generation and hashing
  src/db.ts               Prisma client and SQLite connection
  src/server.ts           HTTP listener and shutdown
  test/health.test.ts      HTTP and database integration tests
  test/merchants.test.ts   Signup, storage, authentication and failure tests
docs/
  flutterpay-plan.html     Visual roadmap for all phases
  2026-11-21-project-setup.md
  2026-11-21-phase-1-merchants.md
```

The root package.json uses npm workspaces. It forwards commands to the API package. We will add `packages/sdk-node` and `apps/dashboard` when those phases begin. SDK examples and integration tests will exercise the payment flow directly. A demo shop is outside the project scope.

Prisma uses its [documented SQLite adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite). The generated client and compiled JavaScript stay out of Git. Commit changes to the schema and its migration together. The lockfile records dependency versions for local installs and CI.

The root package.json overrides Prisma config's Effect dependency to 3.22.5. Prisma 7.10.1 pins an older version affected by [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw). The override keeps the patched release within Effect 3.

GitHub Actions installs dependencies, applies migrations, checks types, runs the tests and builds the API on Linux and Windows.

## Next step

Phase 2 adds payment creation. It requires a separate go-ahead. See the [visual build plan](docs/flutterpay-plan.html) and the [Phase 1 implementation plan](docs/2026-11-21-phase-1-merchants.md).

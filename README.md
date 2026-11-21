# FlutterPay

FlutterPay is a payment gateway simulator for learning backend development. The finished project will let a merchant create a payment, send a customer to checkout, verify the result and receive a signed webhook through a Node SDK. All payments will be simulated.

Phase 0 is implemented. The API runs locally, queries SQLite through Prisma and exposes `GET /health`. Merchant registration, payment processing, checkout, webhooks and the SDK are the next phases.

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
| `npm test` | Test HTTP health responses with separate temporary SQLite databases. |
| `npm run typecheck` | Check TypeScript without building. |
| `npm run build` | Generate the database client and compile the API into apps/api/dist. |
| `npm start` | Run the compiled API after building and applying migrations. |

A migration is a saved SQL change to the database structure. The initial migration creates the Merchant table, which is empty. Phase 1 will add registration and API keys.

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
  src/db.ts               Prisma client and SQLite connection
  src/server.ts           HTTP listener and shutdown
  test/health.test.ts      HTTP and database integration tests
docs/
  flutterpay-plan.html     Visual roadmap for all phases
  2026-11-21-project-setup.md
```

The root package.json uses npm workspaces. It forwards commands to the API package. We will add `packages/sdk-node` and `apps/dashboard` when those phases begin. SDK examples and integration tests will exercise the payment flow directly. A demo shop is outside the project scope.

Prisma uses its [documented SQLite adapter](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite). The generated client and compiled JavaScript stay out of Git. Commit changes to the schema and its migration together. The lockfile records dependency versions for local installs and CI.

The root package.json overrides Prisma config's Effect dependency to 3.22.5. Prisma 7.10.1 pins an older version affected by [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw). The override keeps the patched release within Effect 3.

GitHub Actions installs dependencies, applies migrations, checks types, runs the tests and builds the API on Linux and Windows.

## Next step

Phase 1 adds merchant registration, API keys and authentication. See the [visual build plan](docs/flutterpay-plan.html) and the [setup plan](docs/2026-11-21-project-setup.md).

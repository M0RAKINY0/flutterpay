# FlutterPay project setup plan

Date: 2026-11-21

## Purpose

Implement Phase 0 of [the build plan](flutterpay-plan.html). FlutterPay is a learning project that simulates payments. This task creates a private GitHub repository and a working local API with a SQLite database. Payment routes and the SDK belong to later phases.

## Decisions

Use npm workspaces with the API in `apps/api`. Keep TypeScript, Express and Prisma with SQLite from the existing design. Use the stable Prisma 7 release and its documented SQLite adapter. Add other applications and the SDK when their phases begin, rather than creating empty packages.

`GET /health` returns HTTP 200 with `{ "ok": true }` after querying the migrated database. Return HTTP 503 with `{ "ok": false }` if the database query fails. Start the development server on `127.0.0.1:3000` by default.

Create only the Merchant table in the initial migration. Its fields are `id`, `businessName`, unique `email`, `passwordHash`, `createdAt` and `updatedAt`. No merchant records or credentials ship with the repository. Later phases add their own migrations.

## Implementation

- [x] Initialize Git and npm workspaces. Add strict TypeScript configuration, environment examples and ignore rules.
- [x] Add Prisma configuration, a Merchant schema and a committed initial migration. Generate the client locally.
- [x] Write an HTTP integration test for health against a migrated temporary SQLite database and one against an unmigrated database. Observe failure before adding the route.
- [x] Implement the Express app, database client and server entry point. Close the HTTP server and database on termination.
- [x] Document installation, migrations, development, database inspection, tests and build commands in README.md. Add GitHub Actions for the same checks.
- [x] Verify tests, type checking, build and an HTTP request to the compiled server. Check ignored files before the first commit.
- [x] Commit, create private `M0RAKINY0/flutterpay` and push the initial branch. Verify the remote repository.

## Checks to review

Keep local environment files, databases and generated code out of Git. Use one DATABASE_URL for Prisma CLI and the application. Verify commands from the repository root and keep CI independent of a local .env file. Health failures must not expose database error details.

## Progress

The user authorized repository creation and setup after reviewing the visual plan. This folder contains only that plan and has no existing Git repository. GitHub CLI is authenticated as M0RAKINY0. Private visibility is the setup default.

## Verification record

Both health tests failed with HTTP 404 before the route existed. Both passed after implementation. A fresh `npm ci`, `npm run db:deploy`, `npm run typecheck`, `npm test` and `npm run build` passed on Windows with Node 22.20.0. A separate process running the compiled server returned HTTP 200 and `{ "ok": true }` from `/health`.

The initial audit found an advisory in Prisma config's pinned Effect dependency. The root package overrides it to patched Effect 3.22.5. After reinstalling from the lockfile, npm reported zero vulnerabilities. README.md explains the override.

A separate read-only reviewer found no actionable setup issues. Linux checks are configured in GitHub Actions and have not been run locally. Generated code, local configuration, database files, build output and node_modules match the Git ignore rules.

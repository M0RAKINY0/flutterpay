import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";

const require = createRequire(import.meta.url);

for (const migrated of [true, false]) {
  test(migrated ? "health confirms the migrated SQLite database is queryable" : "health returns 503 when database tables are missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flutterpay-test-"));
    const url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
    const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    try {
      if (migrated) {
        execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
          env: { ...process.env, DATABASE_URL: url },
          stdio: "pipe",
        });
      }
      const server = createApp(db).listen(0, "127.0.0.1");
      try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const response = await fetch(`http://127.0.0.1:${address.port}/health`);
        assert.equal(response.status, migrated ? 200 : 503);
        assert.deepEqual(await response.json(), { ok: migrated });
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

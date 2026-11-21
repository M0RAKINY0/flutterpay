import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createApp, type AppOptions } from "../src/app.js";

const require = createRequire(import.meta.url);

export async function testDatabase(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "flutterpay-test-"));
  const url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  t.after(async () => {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return db;
}

export async function testServer(t: TestContext, db: PrismaClient, options?: AppOptions) {
  const server = createApp(db, options).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

export function postJson(url: string, body: unknown) {
  return fetch(`${url}/v1/merchants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

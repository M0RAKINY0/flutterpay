import "dotenv/config";
import { createApp } from "./app.js";
import { db } from "./db.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const server = createApp(db).listen(port, host, () => {
  console.log(`FlutterPay API listening at http://${host}:${port}`);
});

server.on("error", async (error) => {
  console.error("Could not start FlutterPay:", error.message);
  await db.$disconnect();
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(async (error) => {
    try {
      await db.$disconnect();
      process.exitCode = error ? 1 : 0;
    } finally {
      clearTimeout(timeout);
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

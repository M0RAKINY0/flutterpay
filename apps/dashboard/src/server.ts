import "dotenv/config";
import { createDashboardApp } from "./app.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const apiBaseUrl = process.env.API_BASE_URL?.trim() || "http://127.0.0.1:3000";
const proxySecret = process.env.DASHBOARD_PROXY_SECRET?.trim() || undefined;

const server = createDashboardApp({ apiBaseUrl, proxySecret }).listen(port, host, () => {
  console.log(`FlutterPay Dashboard listening at http://${host}:${port} (API: ${apiBaseUrl})`);
});

server.on("error", error => {
  console.error("Could not start FlutterPay Dashboard:", error.message);
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(error => {
    clearTimeout(timeout);
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

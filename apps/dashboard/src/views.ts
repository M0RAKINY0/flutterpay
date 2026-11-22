import type {
  ApiKeySummary,
  ApiMerchant,
  ApiPagination,
  ApiTransaction,
  ApiWebhookConfig,
  ApiWebhookDelivery,
} from "./api-client.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatNaira(amountKobo: number): string {
  const sign = amountKobo < 0 ? "-" : "";
  const abs = Math.abs(amountKobo);
  const naira = Math.floor(abs / 100);
  const kobo = String(abs % 100).padStart(2, "0");
  return `${sign}₦${String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${kobo}`;
}

function formatUtcTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function statusBadge(status: string): string {
  const lower = status.toLowerCase();
  let tone = "neutral";
  if (lower === "successful" || lower === "delivered" || lower === "active") {
    tone = "ok";
  } else if (lower === "pending" || lower === "awaiting_otp" || lower === "processing") {
    tone = "warn";
  } else if (lower === "failed" || lower === "abandoned" || lower === "revoked") {
    tone = "err";
  }
  return `<span class="badge badge-${tone}">${escapeHtml(lower.replaceAll("_", " "))}</span>`;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f8f7;
  --card: #ffffff;
  --fg: #142019;
  --muted: #56655d;
  --line: #d9e2dc;
  --accent: #0b7a4b;
  --accent-fg: #ffffff;
  --accent-soft: #e2f3ea;
  --warn-bg: #fbf0dc;
  --warn-fg: #8c5200;
  --err-bg: #fdecec;
  --err-fg: #9f1c1c;
  --ok-bg: #e2f3ea;
  --ok-fg: #0b5d39;
  --code-bg: #eef3f0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1512;
    --card: #161e1a;
    --fg: #e3ebe6;
    --muted: #98a89f;
    --line: #2a3530;
    --accent: #3fc98a;
    --accent-fg: #0b1a12;
    --accent-soft: #17352a;
    --warn-bg: #3a2c14;
    --warn-fg: #f0b45a;
    --err-bg: #3b1717;
    --err-fg: #f8b4b4;
    --ok-bg: #17352a;
    --ok-fg: #7ce2b1;
    --code-bg: #1c2621;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}
.auth-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.auth-card {
  width: 100%;
  max-width: 440px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 28px;
}
.eyebrow {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
  font-weight: 700;
  margin: 0 0 6px;
}
h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; }
p.muted { margin: 0; color: var(--muted); font-size: 14px; }
label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 4px; }
input[type="text"], input[type="email"], input[type="password"], input[type="url"] {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--fg);
  font: inherit;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 14px;
}
.checkbox-row input { width: auto; }
button, .btn {
  display: inline-block;
  padding: 9px 15px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
button:hover, .btn:hover { opacity: 0.92; text-decoration: none; }
.btn-full { width: 100%; margin-top: 18px; text-align: center; }
.btn-secondary {
  background: transparent;
  color: var(--fg);
  border-color: var(--line);
}
.btn-danger {
  background: var(--err-bg);
  color: var(--err-fg);
  border-color: transparent;
}
.topbar {
  background: var(--card);
  border-bottom: 1px solid var(--line);
}
.topbar-inner {
  max-width: 1060px;
  margin: 0 auto;
  padding: 14px 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.brand { font-weight: 700; font-size: 17px; color: var(--fg); }
.brand span { color: var(--accent); }
.nav { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.nav a {
  padding: 6px 12px;
  border-radius: 8px;
  color: var(--muted);
  font-weight: 600;
  font-size: 14px;
}
.nav a.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.user-bar { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--muted); }
.user-bar form { margin: 0; }
.container {
  max-width: 1060px;
  margin: 0 auto;
  padding: 28px 20px 64px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 20px;
}
.stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.stat-value { margin-top: 6px; font-size: 18px; font-weight: 700; word-break: break-word; }
.alert {
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 14px;
  border: 1px solid transparent;
}
.alert.err { background: var(--err-bg); color: var(--err-fg); }
.alert.ok { background: var(--ok-bg); color: var(--ok-fg); }
.alert.warn { background: var(--warn-bg); color: var(--warn-fg); }
.secret-box {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--card);
  border: 1px dashed var(--line);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
  color: var(--fg);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  font-size: 13px;
  color: var(--muted);
}
.pill.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
  font-weight: 600;
}
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
  white-space: nowrap;
}
.badge-ok { background: var(--ok-bg); color: var(--ok-fg); }
.badge-warn { background: var(--warn-bg); color: var(--warn-fg); }
.badge-err { background: var(--err-bg); color: var(--err-fg); }
.badge-neutral { background: var(--code-bg); color: var(--muted); }
.pager {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--muted);
}
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.auth-footer { margin-top: 18px; font-size: 14px; color: var(--muted); text-align: center; }
`;

function renderDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · FlutterPay Dashboard</title>
  <style>${STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderLoginPage(options?: {
  error?: string;
  email?: string;
  loggedOut?: boolean;
  newAccountKeys?: { public_key: string; secret_key: string };
}): string {
  const banner = options?.error
    ? `<div class="alert err" role="alert">${escapeHtml(options.error)}</div>`
    : options?.loggedOut
      ? `<div class="alert ok" role="status">You have been logged out.</div>`
      : "";
  const keysBanner = options?.newAccountKeys
    ? `<div class="alert warn" role="status">
        <strong>Save your API keys now.</strong> FlutterPay cannot show the secret key again.
        <div class="secret-box"><strong>Secret key:</strong> ${escapeHtml(options.newAccountKeys.secret_key)}</div>
        <div class="secret-box"><strong>Public key:</strong> ${escapeHtml(options.newAccountKeys.public_key)}</div>
      </div>`
    : "";

  return renderDocument(
    "Log in",
    `<div class="auth-shell">
      <main class="auth-card">
        <p class="eyebrow">FlutterPay Merchant Dashboard</p>
        <h1>Log in to your account</h1>
        <p class="muted">Inspect transactions, webhook attempts, and API keys.</p>
        ${banner}${keysBanner}
        <form method="post" action="/login">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${escapeHtml(options?.email ?? "")}" required autocomplete="email">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
          <button type="submit" class="btn-full">Log in</button>
        </form>
        <p class="auth-footer">Need a merchant account? <a href="/signup">Create one</a></p>
      </main>
    </div>`,
  );
}

export function renderSignupPage(options?: {
  error?: string;
  businessName?: string;
  email?: string;
}): string {
  const banner = options?.error
    ? `<div class="alert err" role="alert">${escapeHtml(options.error)}</div>`
    : "";

  return renderDocument(
    "Create account",
    `<div class="auth-shell">
      <main class="auth-card">
        <p class="eyebrow">FlutterPay Merchant Dashboard</p>
        <h1>Create merchant account</h1>
        <p class="muted">Generate test API keys and open your merchant dashboard.</p>
        ${banner}
        <form method="post" action="/signup">
          <label for="business_name">Business name</label>
          <input id="business_name" name="business_name" type="text" maxlength="120" value="${escapeHtml(options?.businessName ?? "")}" required>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" maxlength="254" value="${escapeHtml(options?.email ?? "")}" required autocomplete="email">
          <label for="password">Password (12 to 128 characters)</label>
          <input id="password" name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password">
          <button type="submit" class="btn-full">Create merchant account</button>
        </form>
        <p class="auth-footer">Already registered? <a href="/login">Log in</a></p>
      </main>
    </div>`,
  );
}

function renderDashboardShell(options: {
  title: string;
  activeTab: "transactions" | "webhooks" | "keys";
  merchant: ApiMerchant;
  csrfToken: string;
  content: string;
}): string {
  const { title, activeTab, merchant, csrfToken, content } = options;
  return renderDocument(
    title,
    `<header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/">Flutter<span>Pay</span></a>
        <nav class="nav" aria-label="Dashboard navigation">
          <a href="/transactions" class="${activeTab === "transactions" ? "active" : ""}">Transactions</a>
          <a href="/webhooks" class="${activeTab === "webhooks" ? "active" : ""}">Webhooks</a>
          <a href="/keys" class="${activeTab === "keys" ? "active" : ""}">API Keys</a>
        </nav>
        <div class="user-bar">
          <span><strong>${escapeHtml(merchant.business_name)}</strong> (${escapeHtml(merchant.email)})</span>
          <form method="post" action="/logout">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit" class="btn-secondary">Log out</button>
          </form>
        </div>
      </div>
    </header>
    <main class="container">${content}</main>`,
  );
}

export function renderTransactionsPage(options: {
  merchant: ApiMerchant;
  csrfToken: string;
  transactions: ApiTransaction[];
  period: string;
  pagination: ApiPagination;
  activeSecretPrefix: string | null;
  webhookUrl: string | null;
  newAccountKeys?: { public_key: string; secret_key: string };
  warning?: string;
}): string {
  const { merchant, csrfToken, transactions, period, pagination, activeSecretPrefix, webhookUrl, newAccountKeys, warning } =
    options;

  const warningBanner = warning ? `<div class="alert err" role="alert">${escapeHtml(warning)}</div>` : "";
  const onboardingBanner = newAccountKeys
    ? `<section class="alert warn" role="status">
        <strong>Save your API keys now.</strong> FlutterPay cannot show the secret key again.
        <div class="secret-box"><strong>Secret key:</strong> ${escapeHtml(newAccountKeys.secret_key)}</div>
        <div class="secret-box"><strong>Public key:</strong> ${escapeHtml(newAccountKeys.public_key)}</div>
      </section>`
    : "";

  const periods = ["all", "daily", "weekly", "monthly"] as const;
  const periodLinks = periods
    .map(
      item =>
        `<a class="pill ${period === item ? "active" : ""}" href="/transactions?period=${item}">${item[0]!.toUpperCase() + item.slice(1)}</a>`,
    )
    .join("");

  const rowsHtml =
    transactions.length === 0
      ? `<tr><td colspan="7"><p class="muted">No transactions found for this period.</p></td></tr>`
      : transactions
          .map(tx => {
            const cardDisplay = tx.card_last4 ? `•••• ${escapeHtml(tx.card_last4)}` : "—";
            const reason = tx.failure_reason ? `<div class="muted">${escapeHtml(tx.failure_reason)}</div>` : "";
            return `<tr>
              <td><code>${escapeHtml(tx.tx_ref)}</code><div class="muted"><code>${escapeHtml(tx.id)}</code></div></td>
              <td><strong>${escapeHtml(formatNaira(tx.amount_kobo))}</strong></td>
              <td>${statusBadge(tx.status)}${reason}</td>
              <td>${escapeHtml(tx.customer_email)}</td>
              <td>${cardDisplay}</td>
              <td>${escapeHtml(formatUtcTimestamp(tx.created_at))}</td>
              <td><a href="/webhooks?transaction_id=${encodeURIComponent(tx.id)}">Deliveries</a></td>
            </tr>`;
          })
          .join("");

  const prevLink = pagination.has_previous
    ? `<a class="btn btn-secondary" href="/transactions?period=${encodeURIComponent(period)}&page=${pagination.page - 1}">Previous</a>`
    : "";
  const nextLink = pagination.has_next
    ? `<a class="btn btn-secondary" href="/transactions?period=${encodeURIComponent(period)}&page=${pagination.page + 1}">Next</a>`
    : "";

  const content = `${onboardingBanner}${warningBanner}
    <section class="cards">
      <div class="card">
        <div class="stat-label">Transactions (${escapeHtml(period)})</div>
        <div class="stat-value">${pagination.total}</div>
      </div>
      <div class="card">
        <div class="stat-label">Active Secret Key</div>
        <div class="stat-value">${activeSecretPrefix ? `<code>${escapeHtml(activeSecretPrefix)}…</code>` : "None"}</div>
      </div>
      <div class="card">
        <div class="stat-label">Webhook Endpoint</div>
        <div class="stat-value">${webhookUrl ? `<code>${escapeHtml(webhookUrl)}</code>` : "Not configured"}</div>
      </div>
    </section>

    <section class="card">
      <div class="toolbar">
        <div>
          <h2>Transactions</h2>
          <p class="muted">Newest first, scoped strictly to your merchant account.</p>
        </div>
        <div class="pills">${periodLinks}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Customer</th>
              <th>Card</th>
              <th>Created</th>
              <th>Webhooks</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="pager">
        <span>Page ${pagination.page} of ${Math.max(pagination.total_pages, 1)} (${pagination.total} total)</span>
        <div class="pills">${prevLink}${nextLink}</div>
      </div>
    </section>`;

  return renderDashboardShell({
    title: "Transactions",
    activeTab: "transactions",
    merchant,
    csrfToken,
    content,
  });
}

export function renderWebhooksPage(options: {
  merchant: ApiMerchant;
  csrfToken: string;
  webhook: ApiWebhookConfig;
  deliveries: ApiWebhookDelivery[];
  pagination: ApiPagination;
  transactionIdFilter?: string;
  error?: string;
  warning?: string;
  saved?: boolean;
  newWebhookSecret?: string;
  submittedUrl?: string;
}): string {
  const {
    merchant,
    csrfToken,
    webhook,
    deliveries,
    pagination,
    transactionIdFilter,
    error,
    warning,
    saved,
    newWebhookSecret,
    submittedUrl,
  } = options;

  const errorBanner = error ? `<div class="alert err" role="alert">${escapeHtml(error)}</div>` : "";
  const warningBanner = warning ? `<div class="alert err" role="alert">${escapeHtml(warning)}</div>` : "";
  const secretBanner = newWebhookSecret
    ? `<div class="alert warn" role="status">
        <strong>Save your webhook signing secret now.</strong> It will not be shown again.
        <div class="secret-box">${escapeHtml(newWebhookSecret)}</div>
      </div>`
    : saved
      ? `<div class="alert ok" role="status">Webhook configuration saved.</div>`
      : "";

  const filterBanner = transactionIdFilter
    ? `<p class="muted">Filtering deliveries for transaction <code>${escapeHtml(transactionIdFilter)}</code> · <a href="/webhooks">Clear filter</a></p>`
    : `<p class="muted">Recent signed delivery attempts and retry schedule (1 min, 5 min, 30 min).</p>`;

  const rowsHtml =
    deliveries.length === 0
      ? `<tr><td colspan="7"><p class="muted">No webhook delivery attempts logged yet.</p></td></tr>`
      : deliveries
          .map(d => {
            const responseDetail =
              d.response_code !== null
                ? `HTTP ${d.response_code}`
                : d.error_message
                  ? escapeHtml(d.error_message)
                  : "—";
            return `<tr>
              <td><code>${escapeHtml(d.event)}</code><div class="muted"><code>${escapeHtml(d.event_id)}</code></div></td>
              <td><code>${escapeHtml(d.transaction_id)}</code></td>
              <td>#${d.attempt}</td>
              <td>${statusBadge(d.status)}</td>
              <td>${responseDetail}${d.error_message && d.response_code !== null ? `<div class="muted">${escapeHtml(d.error_message)}</div>` : ""}</td>
              <td><code>${escapeHtml(d.target_url)}</code></td>
              <td>${escapeHtml(formatUtcTimestamp(d.attempted_at))}${d.next_retry_at ? `<div class="muted">Next retry: ${escapeHtml(formatUtcTimestamp(d.next_retry_at))}</div>` : ""}</td>
            </tr>`;
          })
          .join("");

  const txQuery = transactionIdFilter ? `&transaction_id=${encodeURIComponent(transactionIdFilter)}` : "";
  const prevLink = pagination.has_previous
    ? `<a class="btn btn-secondary" href="/webhooks?page=${pagination.page - 1}${txQuery}">Previous</a>`
    : "";
  const nextLink = pagination.has_next
    ? `<a class="btn btn-secondary" href="/webhooks?page=${pagination.page + 1}${txQuery}">Next</a>`
    : "";

  const urlValue = submittedUrl !== undefined ? submittedUrl : (webhook.url ?? "");

  const content = `${errorBanner}${secretBanner}${warningBanner}
    <section class="card">
      <h2>Webhook configuration</h2>
      <p class="muted">FlutterPay signs every <code>charge.completed</code> request with HMAC-SHA256 in <code>X-FlutterPay-Signature</code>.</p>
      <form method="post" action="/webhooks">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <label for="webhook_url">Webhook URL</label>
        <input id="webhook_url" name="webhook_url" type="url" placeholder="http://127.0.0.1:4000/webhook" value="${escapeHtml(urlValue)}">
        <label class="checkbox-row">
          <input type="checkbox" name="rotate_secret" value="1">
          <span>Rotate signing secret on save</span>
        </label>
        <div class="actions">
          <button type="submit" name="action" value="save">Save webhook settings</button>
          ${webhook.url ? `<button type="submit" name="action" value="disable" class="btn-danger">Disable webhooks</button>` : ""}
        </div>
      </form>
      <p class="muted" style="margin-top: 12px;">Signing secret: <strong>${webhook.secret_configured ? "Configured" : "Not configured"}</strong></p>
    </section>

    <section class="card">
      <div class="toolbar">
        <div>
          <h2>Webhook delivery attempts</h2>
          ${filterBanner}
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Transaction</th>
              <th>Attempt</th>
              <th>Status</th>
              <th>Response</th>
              <th>Target URL</th>
              <th>Attempted</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="pager">
        <span>Page ${pagination.page} of ${Math.max(pagination.total_pages, 1)} (${pagination.total} total)</span>
        <div class="pills">${prevLink}${nextLink}</div>
      </div>
    </section>`;

  return renderDashboardShell({
    title: "Webhooks",
    activeTab: "webhooks",
    merchant,
    csrfToken,
    content,
  });
}

export function renderKeysPage(options: {
  merchant: ApiMerchant;
  csrfToken: string;
  keys: ApiKeySummary[];
  error?: string;
  warning?: string;
  rotatedKey?: { kind: "public" | "secret"; value: string; revokedCount: number };
}): string {
  const { merchant, csrfToken, keys, error, warning, rotatedKey } = options;

  const errorBanner = error ? `<div class="alert err" role="alert">${escapeHtml(error)}</div>` : "";
  const warningBanner = warning ? `<div class="alert err" role="alert">${escapeHtml(warning)}</div>` : "";
  const rotatedBanner = rotatedKey
    ? `<section class="alert warn" role="status">
        <strong>New ${escapeHtml(rotatedKey.kind)} key generated.</strong>
        ${rotatedKey.revokedCount > 0 ? `Revoked ${rotatedKey.revokedCount} previous ${escapeHtml(rotatedKey.kind)} key(s) immediately.` : ""}
        Save this key now — it will not be shown again.
        <div class="secret-box">${escapeHtml(rotatedKey.value)}</div>
      </section>`
    : "";

  const rowsHtml =
    keys.length === 0
      ? `<tr><td colspan="5"><p class="muted">No API keys found.</p></td></tr>`
      : keys
          .map(
            key => `<tr>
              <td><strong>${escapeHtml(key.kind)}</strong></td>
              <td><code>${escapeHtml(key.prefix)}…</code></td>
              <td>${statusBadge(key.active ? "active" : "revoked")}</td>
              <td>${escapeHtml(formatUtcTimestamp(key.created_at))}</td>
              <td>${escapeHtml(formatUtcTimestamp(key.revoked_at))}</td>
            </tr>`,
          )
          .join("");

  const content = `${errorBanner}${rotatedBanner}${warningBanner}
    <section class="card">
      <h2>Replace a leaked API key</h2>
      <p class="muted">Rotating a key immediately revokes the current active key of that type and issues a brand-new key.</p>
      <div class="actions">
        <form method="post" action="/keys/rotate">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="kind" value="secret">
          <button type="submit" class="btn-danger">Replace secret key</button>
        </form>
        <form method="post" action="/keys/rotate">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="kind" value="public">
          <button type="submit" class="btn-secondary">Replace public key</button>
        </form>
      </div>
    </section>

    <section class="card">
      <h2>API key history</h2>
      <p class="muted">Only prefixes are stored for display. Full secret keys are never recoverable after creation.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Prefix</th>
              <th>Status</th>
              <th>Created</th>
              <th>Revoked</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </section>`;

  return renderDashboardShell({
    title: "API Keys",
    activeTab: "keys",
    merchant,
    csrfToken,
    content,
  });
}

export function renderErrorPage(title: string, message: string): string {
  return renderDocument(
    title,
    `<div class="auth-shell">
      <main class="auth-card">
        <p class="eyebrow">FlutterPay Dashboard</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="alert err" role="alert">${escapeHtml(message)}</div>
        <a class="btn btn-secondary btn-full" href="/">Return to dashboard</a>
      </main>
    </div>`,
  );
}

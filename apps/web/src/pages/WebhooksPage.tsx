import { useState, type FormEvent } from "react";
import { Pills } from "../components/Pills";
import { StatusBadge } from "../components/StatusBadge";
import { deliveries, mockWebhookSecret, transactions, webhookConfig } from "../data/mock";
import { formatUtcClock, formatUtcShort } from "../lib/format";
import type { DeliveryStatus } from "../types";

type DeliveryFilter = "all" | DeliveryStatus;

const FILTERS: { value: DeliveryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
];

const RETRY_STEPS = [
  "as soon as the payment finishes",
  "1 minute later",
  "5 minutes after that",
  "30 minutes after that, then marked failed",
];

const MAX_ATTEMPTS = RETRY_STEPS.length;

type Notice = { kind: "saved" } | { kind: "disabled" } | { kind: "secret"; value: string } | null;

export function WebhooksPage({ transactionId }: { transactionId: string | null }) {
  const [savedUrl, setSavedUrl] = useState(webhookConfig.url);
  const [url, setUrl] = useState(webhookConfig.url ?? "");
  const [rotate, setRotate] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [filter, setFilter] = useState<DeliveryFilter>("all");

  const refById = new Map(transactions.map(tx => [tx.id, tx.tx_ref]));
  const rows = deliveries.filter(
    d => (filter === "all" || d.status === filter) && (!transactionId || d.transaction_id === transactionId),
  );

  function save(event: FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    setSavedUrl(trimmed === "" ? null : trimmed);
    setNotice(rotate && trimmed !== "" ? { kind: "secret", value: mockWebhookSecret() } : { kind: "saved" });
    setRotate(false);
  }

  function disable() {
    setSavedUrl(null);
    setUrl("");
    setNotice({ kind: "disabled" });
  }

  return (
    <>
      <header>
        <div className="page-head">
          <h1>Webhooks</h1>
        </div>
        <p className="lede">
          FlutterPay sends a signed <code>charge.completed</code> request to your server when a payment finishes.
        </p>
      </header>

      {notice?.kind === "secret" && (
        <div className="alert alert-warn" role="status">
          <strong>Copy your new signing secret now.</strong> FlutterPay won't show it again. Requests signed with the
          old secret stop verifying right away.
          <code className="secret">{notice.value}</code>
        </div>
      )}
      {notice?.kind === "saved" && (
        <div className="alert alert-ok" role="status">
          Webhook settings saved.
        </div>
      )}
      {notice?.kind === "disabled" && (
        <div className="alert alert-ok" role="status">
          Webhooks are off. FlutterPay won't send events until you add a URL again.
        </div>
      )}

      <section className="row">
        <form className="card stack" style={{ flex: "3 1 480px", minWidth: 0, gap: 14 }} onSubmit={save}>
          <div className="chart-head" style={{ alignItems: "center" }}>
            <h2>Endpoint</h2>
            {savedUrl ? (
              <span className="badge badge-ok">
                <span className="dot" aria-hidden="true" />
                Receiving events
              </span>
            ) : (
              <span className="badge badge-neutral">Off</span>
            )}
          </div>
          <div className="field">
            <label htmlFor="wh-url">Webhook URL</label>
            <input
              id="wh-url"
              className="input mono"
              type="url"
              placeholder="https://example.com/webhooks/flutterpay"
              value={url}
              onChange={event => setUrl(event.target.value)}
            />
          </div>
          <div className="pills" style={{ fontSize: 14, color: "var(--fg-soft)" }}>
            <span>Signing secret:</span>
            <code className="code-box" style={{ display: "inline", padding: "2px 8px" }}>
              {webhookConfig.secret_configured ? "whsec_test_••••••••" : "Not set"}
            </code>
          </div>
          <label className="check">
            <input type="checkbox" checked={rotate} onChange={event => setRotate(event.target.checked)} />
            Rotate the signing secret when I save
          </label>
          <div className="pills" style={{ gap: 10 }}>
            <button type="submit" className="btn btn-primary">
              Save settings
            </button>
            {savedUrl && (
              <button type="button" className="btn btn-danger-soft" onClick={disable}>
                Turn off webhooks
              </button>
            )}
          </div>
        </form>

        <div className="card stack" style={{ flex: "2 1 320px", minWidth: 0 }}>
          <div>
            <h2>How retries work</h2>
            <p className="card-sub" style={{ lineHeight: 1.5 }}>
              Any response other than 2xx counts as a failure. FlutterPay tries {MAX_ATTEMPTS} times, then stops.
            </p>
          </div>
          <ol className="steps">
            {RETRY_STEPS.map((text, i) => (
              <li key={text} className="step">
                <span className="step-rail">
                  <span className="step-num">{i + 1}</span>
                  {i < RETRY_STEPS.length - 1 && <span className="step-line" aria-hidden="true" />}
                </span>
                <span className="step-text">
                  <strong>Attempt {i + 1}</strong>
                  <span className="muted">, {text}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="card-sub" style={{ margin: 0, lineHeight: 1.5 }}>
            Verify each request with the HMAC-SHA256 signature in the <code>X-FlutterPay-Signature</code> header.
          </p>
        </div>
      </section>

      <section className="card-flush">
        <div className="card-head">
          <div>
            <h2>Delivery log</h2>
            <p className="card-sub">
              {transactionId ? (
                <>
                  Attempts for <code>{refById.get(transactionId) ?? transactionId}</code> ·{" "}
                  <a href="#/webhooks">Show all</a>
                </>
              ) : (
                "Every attempt, newest first"
              )}
            </p>
          </div>
          <Pills label="Status" options={FILTERS} value={filter} onChange={setFilter} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Transaction</th>
                <th scope="col">Attempt</th>
                <th scope="col">Status</th>
                <th scope="col">Response</th>
                <th scope="col">Attempted, UTC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(d => (
                <tr key={d.id}>
                  <td>
                    <code style={{ fontWeight: 500 }}>{d.event}</code>
                    <div className="sub">{d.event_id}</div>
                  </td>
                  <td>
                    <a href={`#/webhooks?tx=${encodeURIComponent(d.transaction_id)}`}>
                      <code>{refById.get(d.transaction_id) ?? d.transaction_id}</code>
                    </a>
                    <div className="sub">{d.transaction_id}</div>
                  </td>
                  <td className="nowrap">
                    {d.attempt} of {MAX_ATTEMPTS}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    {d.response_code !== null ? `HTTP ${d.response_code}` : (d.error_message ?? "No response")}
                  </td>
                  <td className="nowrap muted">
                    {formatUtcShort(d.attempted_at)}
                    {d.next_retry_at && <div className="retry">Next try {formatUtcClock(d.next_retry_at)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty">
              <p className="strong">No delivery attempts match</p>
              <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
                FlutterPay logs an attempt each time it calls your webhook URL.
              </p>
            </div>
          )}
        </div>
        <div className="footer-bar">
          Showing {rows.length} of {deliveries.length} attempts
        </div>
      </section>
    </>
  );
}

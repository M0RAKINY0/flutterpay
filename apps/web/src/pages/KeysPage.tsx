import { useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { apiKeys, mockRotateKey } from "../data/mock";
import { formatUtcLong } from "../lib/format";
import type { ApiKey } from "../types";

const INFO: Record<ApiKey["kind"], { title: string; hint: string }> = {
  secret: {
    title: "Secret key",
    hint: "Use it on your server to create and verify charges. Never put it in a browser or mobile app.",
  },
  public: {
    title: "Public key",
    hint: "Safe to use in your checkout page. It can only start a payment.",
  },
};

export function KeysPage() {
  const [keys, setKeys] = useState(apiKeys);
  const [confirming, setConfirming] = useState<ApiKey["kind"] | null>(null);
  const [revealed, setRevealed] = useState<{ kind: ApiKey["kind"]; value: string } | null>(null);

  function rotate(kind: ApiKey["kind"]) {
    const { key, value } = mockRotateKey(kind);
    setKeys(current => [
      key,
      ...current.map(k => (k.kind === kind && k.active ? { ...k, active: false, revoked_at: key.created_at } : k)),
    ]);
    setRevealed({ kind, value });
    setConfirming(null);
  }

  const active = (["secret", "public"] as const).map(kind => ({
    kind,
    key: keys.find(k => k.kind === kind && k.active),
  }));

  return (
    <>
      <header>
        <div className="page-head">
          <h1>API keys</h1>
        </div>
        <p className="lede">FlutterPay stores only the first 20 characters of each key. You see a full key once, when it's created.</p>
      </header>

      {revealed && (
        <div className="alert alert-warn" role="status">
          <strong>Copy your new {revealed.kind} key now.</strong> FlutterPay won't show it again. The old{" "}
          {revealed.kind} key has stopped working.
          <code className="secret">{revealed.value}</code>
        </div>
      )}

      <section className="key-grid">
        {active.map(({ kind, key }) => (
          <div key={kind} className="card stack" style={{ gap: 14 }}>
            <div className="chart-head" style={{ alignItems: "center" }}>
              <h2>{INFO[kind].title}</h2>
              <StatusBadge status={key ? "active" : "revoked"} dot={Boolean(key)} />
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              {INFO[kind].hint}
            </p>
            <code className="code-box" style={{ fontSize: 14 }}>
              {key ? `${key.prefix}…` : "No active key"}
            </code>
            {key && <div className="muted" style={{ fontSize: 13 }}>Created {formatUtcLong(key.created_at)}</div>}
            {confirming === kind ? (
              <div className="confirm">
                <p>
                  Replacing revokes <code>{key?.prefix}…</code> immediately. Anything still using it gets 401 errors until
                  you deploy the new key.
                </p>
                <div className="pills" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-danger" onClick={() => rotate(kind)}>
                    Replace now
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-danger-soft"
                style={{ alignSelf: "flex-start" }}
                onClick={() => setConfirming(kind)}
              >
                Replace {kind} key
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="card-flush">
        <div className="card-head">
          <div>
            <h2>Key history</h2>
            <p className="card-sub">Revoked keys stay listed so you can match old requests to a key.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Prefix</th>
                <th scope="col">Status</th>
                <th scope="col">Created, UTC</th>
                <th scope="col">Revoked, UTC</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(key => (
                <tr key={key.id}>
                  <td className="strong">{key.kind === "secret" ? "Secret" : "Public"}</td>
                  <td>
                    <code>{key.prefix}…</code>
                  </td>
                  <td>
                    <StatusBadge status={key.active ? "active" : "revoked"} />
                  </td>
                  <td className="nowrap muted">{formatUtcLong(key.created_at)}</td>
                  <td className="nowrap muted">{formatUtcLong(key.revoked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

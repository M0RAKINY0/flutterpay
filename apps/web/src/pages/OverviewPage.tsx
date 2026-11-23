import { useState } from "react";
import { Icon } from "../components/Icon";
import { StatusBadge } from "../components/StatusBadge";
import {
  dailyVolume,
  deliveries,
  deliveryStats,
  MOCK_NOW,
  statusCounts,
  topFailureReason,
  transactions,
  webhookConfig,
} from "../data/mock";
import { dayOf, formatCompactNaira, formatNaira, formatUtcClock, formatUtcShort, weekdayOf } from "../lib/format";

const CHART_HEIGHT = 200;
const CHART_MAX_KOBO = 240_000 * 100;
const TICKS = [0, 80_000, 160_000, 240_000].map(n => n * 100);

const STATUS_ROWS = [
  { label: "Successful", count: statusCounts.successful, color: "#0B7A4B" },
  { label: "Failed", count: statusCounts.failed, color: "#D64545" },
  { label: "Pending or awaiting OTP", count: statusCounts.pending, color: "#E3A23B" },
  { label: "Abandoned", count: statusCounts.abandoned, color: "#B9C4BE" },
];

function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function VolumeChart() {
  const [selected, setSelected] = useState(dailyVolume.length - 1);
  const day = dailyVolume[selected] ?? dailyVolume[0]!;

  return (
    <div className="card grow-2">
      <div className="chart-head">
        <div>
          <h2>Successful volume per day</h2>
          <p className="card-sub">10 to 23 November, naira</p>
        </div>
        <div className="readout" aria-live="polite">
          <div className="muted" style={{ fontSize: 12 }}>
            {weekdayOf(day.date)} {dayOf(day.date)} Nov
          </div>
          <div className="readout-value">{formatNaira(day.amount_kobo)}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {day.count} payments
          </div>
        </div>
      </div>
      <div className="chart">
        <div className="y-axis" aria-hidden="true">
          {TICKS.map(tick => (
            <span key={tick} style={{ bottom: (tick / CHART_MAX_KOBO) * CHART_HEIGHT }}>
              {formatCompactNaira(tick)}
            </span>
          ))}
        </div>
        <div className="plot-col">
          <div className="plot">
            {TICKS.map(tick => (
              <div
                key={tick}
                aria-hidden="true"
                className={tick === 0 ? "grid-line base" : "grid-line"}
                style={{ bottom: (tick / CHART_MAX_KOBO) * CHART_HEIGHT }}
              />
            ))}
            <div className="bars">
              {dailyVolume.map((d, i) => (
                <button
                  key={d.date}
                  type="button"
                  className="bar-hit"
                  aria-label={`${weekdayOf(d.date)} ${dayOf(d.date)} November, ${formatNaira(d.amount_kobo)}, ${d.count} payments`}
                  onMouseEnter={() => setSelected(i)}
                  onFocus={() => setSelected(i)}
                >
                  <span
                    className={i === selected ? "bar on" : "bar"}
                    style={{ height: Math.round((d.amount_kobo / CHART_MAX_KOBO) * CHART_HEIGHT) }}
                  />
                </button>
              ))}
            </div>
          </div>
          <div className="x-axis" aria-hidden="true">
            {dailyVolume.map((d, i) => (
              <span key={d.date} className={i === selected ? "on" : undefined}>
                {dayOf(d.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const volume = dailyVolume.reduce((sum, d) => sum + d.amount_kobo, 0);
  const successful = dailyVolume.reduce((sum, d) => sum + d.count, 0);
  const total = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
  const recent = transactions.slice(0, 6);
  const lastDelivered = deliveries.find(d => d.status === "delivered");
  const pendingRetry = deliveries.find(d => d.next_retry_at);
  const retryRef = transactions.find(t => t.id === pendingRetry?.transaction_id)?.tx_ref;
  const today = MOCK_NOW.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>Overview</h1>
          <p className="lede">Payments and webhook health for the last 14 days. All times in UTC.</p>
        </div>
        <a className="btn btn-primary" href="#/transactions">
          View all transactions
          <Icon name="arrow" size={16} />
        </a>
      </header>

      <section className="kpis" aria-label="Key numbers">
        <div className="card">
          <div className="kpi-label">Successful volume</div>
          <div className="kpi-value">{formatNaira(volume)}</div>
          <div className="kpi-note">{successful} payments in 14 days</div>
        </div>
        <div className="card">
          <div className="kpi-label">Success rate</div>
          <div className="kpi-value">{percent(statusCounts.successful, total)}</div>
          <div className="kpi-note">
            {statusCounts.successful} of {total} transactions
          </div>
        </div>
        <div className="card">
          <div className="kpi-label">Average payment</div>
          <div className="kpi-value">{formatNaira(Math.round(volume / successful))}</div>
          <div className="kpi-note">Successful payments only</div>
        </div>
        <div className="card">
          <div className="kpi-label">Webhooks delivered</div>
          <div className="kpi-value">{percent(deliveryStats.delivered, deliveryStats.attempts)}</div>
          <div className="kpi-note">
            {deliveryStats.failed} failed of {deliveryStats.attempts} attempts
          </div>
        </div>
      </section>

      <section className="row">
        <VolumeChart />
        <div className="card grow-1 stack">
          <div>
            <h2>Transactions by status</h2>
            <p className="card-sub">{total} transactions in 14 days</p>
          </div>
          <div className="stacked" aria-hidden="true">
            {STATUS_ROWS.map(row => (
              <span key={row.label} style={{ width: percent(row.count, total), background: row.color }} />
            ))}
          </div>
          <div>
            {STATUS_ROWS.map(row => (
              <div key={row.label} className="legend-row">
                <span className="swatch" aria-hidden="true" style={{ background: row.color }} />
                <span style={{ flex: 1 }}>{row.label}</span>
                <span className="strong">{row.count}</span>
                <span className="muted" style={{ width: 52, textAlign: "right" }}>
                  {percent(row.count, total)}
                </span>
              </div>
            ))}
          </div>
          <div className="alert alert-err" style={{ marginTop: "auto", fontSize: 13 }}>
            <strong>Top failure reason:</strong> {topFailureReason.reason}, {topFailureReason.count} of{" "}
            {statusCounts.failed} failed payments.
          </div>
        </div>
      </section>

      <section className="row">
        <div className="card-flush grow-2">
          <div className="card-head" style={{ borderBottom: "none", paddingBottom: 8 }}>
            <h2>Recent transactions</h2>
            <a href="#/transactions" className="strong" style={{ fontSize: 14 }}>
              See all
            </a>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(tx => (
                  <tr key={tx.id}>
                    <td>
                      <code>{tx.tx_ref}</code>
                    </td>
                    <td>{tx.customer_email}</td>
                    <td className="num strong">{formatNaira(tx.amount_kobo)}</td>
                    <td>
                      <StatusBadge status={tx.status} />
                    </td>
                    <td className="muted nowrap">{formatUtcShort(tx.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card grow-1 stack">
          <div className="chart-head" style={{ alignItems: "center" }}>
            <h2>Webhook endpoint</h2>
            <StatusBadge status={webhookConfig.url ? "active" : "off"} dot />
          </div>
          <code className="code-box">{webhookConfig.url ?? "Not configured"}</code>
          <dl className="facts">
            <dt>Delivered, 14 days</dt>
            <dd>{deliveryStats.delivered}</dd>
            <dt>Failed after retries</dt>
            <dd>{deliveryStats.failed}</dd>
            <dt>Last delivery</dt>
            <dd>
              {lastDelivered
                ? `${formatUtcClock(lastDelivered.attempted_at).slice(0, 5)}, HTTP ${lastDelivered.response_code}`
                : "None yet"}
            </dd>
          </dl>
          {pendingRetry?.next_retry_at && (
            <div className="alert alert-warn" style={{ fontSize: 13 }}>
              <code>{retryRef ?? pendingRetry.transaction_id}</code> failed {pendingRetry.attempt} times. Attempt{" "}
              {pendingRetry.attempt + 1} runs at {formatUtcClock(pendingRetry.next_retry_at).slice(0, 5)}.
            </div>
          )}
          <a href="#/webhooks" className="strong" style={{ marginTop: "auto", fontSize: 14 }}>
            Open delivery log
          </a>
        </div>
      </section>
    </>
  );
}

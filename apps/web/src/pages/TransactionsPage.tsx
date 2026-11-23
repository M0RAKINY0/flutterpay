import { useState } from "react";
import { Pills } from "../components/Pills";
import { StatusBadge } from "../components/StatusBadge";
import { merchant, MOCK_NOW, transactions } from "../data/mock";
import { filterTransactions, formatNaira, formatUtcShort, type StatusFilter } from "../lib/format";
import type { Period } from "../types";

const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "daily", label: "Today" },
  { value: "weekly", label: "Last 7 days" },
  { value: "monthly", label: "This month" },
];

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "successful", label: "Successful" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "abandoned", label: "Abandoned" },
];

export function TransactionsPage() {
  const [period, setPeriod] = useState<Period>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const rows = filterTransactions(transactions, { period, status, query, now: MOCK_NOW });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="lede">Newest first. Only payments made to {merchant.business_name} appear here.</p>
        </div>
        <div className="field" style={{ flex: "0 1 320px", minWidth: 240 }}>
          <label htmlFor="tx-search" className="muted" style={{ fontSize: 12 }}>
            Search by reference or email
          </label>
          <input
            id="tx-search"
            className="input"
            type="search"
            placeholder="order_10482 or name@email.com"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
      </header>

      <section className="card-flush">
        <div className="card-head">
          <Pills label="Period" options={PERIODS} value={period} onChange={setPeriod} />
          <Pills label="Status" options={STATUSES} value={status} onChange={setStatus} />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">Customer</th>
                <th scope="col">Card</th>
                <th scope="col">Created, UTC</th>
                <th scope="col">
                  <span className="sr-only">Webhooks</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(tx => (
                <tr key={tx.id}>
                  <td>
                    <code style={{ fontWeight: 500 }}>{tx.tx_ref}</code>
                    <div className="sub">{tx.id}</div>
                  </td>
                  <td className="num strong">{formatNaira(tx.amount_kobo)}</td>
                  <td>
                    <StatusBadge status={tx.status} />
                    {tx.failure_reason && <div className="reason">{tx.failure_reason}</div>}
                  </td>
                  <td>{tx.customer_email}</td>
                  <td className="nowrap">{tx.card_last4 ? `•••• ${tx.card_last4}` : "Not entered"}</td>
                  <td className="nowrap muted">{formatUtcShort(tx.created_at)}</td>
                  <td className="nowrap">
                    <a href={`#/webhooks?tx=${encodeURIComponent(tx.id)}`} className="strong" style={{ fontSize: 13 }}>
                      Deliveries
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty">
              <p className="strong">No transactions match these filters</p>
              <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
                Try a longer period, a different status or a shorter search.
              </p>
            </div>
          )}
        </div>

        <div className="footer-bar">
          <span>
            Showing {rows.length} of {transactions.length} transactions
          </span>
          <div className="pills">
            <button type="button" className="btn btn-secondary" disabled>
              Previous
            </button>
            <button type="button" className="btn btn-secondary" disabled>
              Next
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

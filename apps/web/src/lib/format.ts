import type { Period, Transaction, TransactionStatus } from "../types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatNaira(amountKobo: number): string {
  const sign = amountKobo < 0 ? "-" : "";
  const abs = Math.abs(amountKobo);
  const naira = Math.floor(abs / 100).toLocaleString("en-US");
  const kobo = String(abs % 100).padStart(2, "0");
  return `${sign}₦${naira}.${kobo}`;
}

export function formatCompactNaira(amountKobo: number): string {
  const naira = amountKobo / 100;
  if (naira >= 1000) return `₦${Math.round(naira / 1000)}k`;
  return `₦${naira}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "23 Nov 14:32", in UTC. */
export function formatUtcShort(iso: string | null): string {
  if (!iso) return "Not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "14:32:09", in UTC. */
export function formatUtcClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "23 Nov 2026, 14:41", in UTC. */
export function formatUtcLong(iso: string | null): string {
  if (!iso) return "Not revoked";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(iso).getUTCDay()] ?? "";
}

export function dayOf(iso: string): number {
  return new Date(iso).getUTCDate();
}

export function statusLabel(status: string): string {
  if (status === "awaiting_otp") return "Awaiting OTP";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export type Tone = "ok" | "warn" | "err" | "neutral";

export function statusTone(status: string): Tone {
  if (status === "successful" || status === "delivered" || status === "active") return "ok";
  if (status === "pending" || status === "awaiting_otp") return "warn";
  if (status === "failed" || status === "revoked") return "err";
  return "neutral";
}

export type StatusFilter = "all" | "successful" | "pending" | "failed" | "abandoned";

/**
 * Applies the dashboard's period, status and search filters.
 * "daily" is the current UTC day, "weekly" the last 7 days, "monthly" the current UTC month.
 * The "pending" filter also matches transactions waiting for an OTP.
 */
export function filterTransactions(
  transactions: Transaction[],
  options: { period: Period; status: StatusFilter; query: string; now: Date },
): Transaction[] {
  const { period, status, now } = options;
  const query = options.query.trim().toLowerCase();
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const periodStart: Record<Period, number> = {
    all: Number.NEGATIVE_INFINITY,
    daily: startOfToday,
    weekly: startOfToday - 6 * 24 * 60 * 60 * 1000,
    monthly: startOfMonth,
  };

  const statusMatches = (txStatus: TransactionStatus) =>
    status === "all" || txStatus === status || (status === "pending" && txStatus === "awaiting_otp");

  return transactions.filter(tx => {
    if (Date.parse(tx.created_at) < periodStart[period]) return false;
    if (!statusMatches(tx.status)) return false;
    if (query && !tx.tx_ref.toLowerCase().includes(query) && !tx.customer_email.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });
}

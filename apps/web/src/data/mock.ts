import type { ApiKey, DailyVolume, Merchant, Transaction, WebhookConfig, WebhookDelivery } from "../types";

// Mock data for the dashboard until it is wired to the API.
// "Now" is pinned so the period filters give stable results.
export const MOCK_NOW = new Date("2026-11-23T14:41:00Z");

export const merchant: Merchant = {
  id: "mer_01",
  business_name: "Adaeze Fabrics",
  email: "payments@adaezefabrics.ng",
};

const WEBHOOK_URL = "https://api.adaezefabrics.ng/hooks/flutterpay";

export const webhookConfig: WebhookConfig = {
  url: WEBHOOK_URL,
  secret_configured: true,
};

function tx(
  ref: string,
  id: string,
  naira: number,
  status: Transaction["status"],
  email: string,
  card: string | null,
  createdAt: string,
  failureReason: string | null = null,
): Transaction {
  return {
    id,
    tx_ref: ref,
    amount_kobo: naira * 100,
    currency: "NGN",
    status,
    customer_email: email,
    card_last4: card,
    failure_reason: failureReason,
    created_at: createdAt,
  };
}

export const transactions: Transaction[] = [
  tx("order_10482", "tx_7f3c9a21e4", 45000, "successful", "chiamaka.obi@gmail.com", "4081", "2026-11-23T14:32:00Z"),
  tx("order_10481", "tx_2b81d0c7f9", 12500, "successful", "tunde.bakare@yahoo.com", "5399", "2026-11-23T14:05:00Z"),
  tx("order_10480", "tx_c4e09a3b12", 8750, "failed", "ifeoma.nwosu@outlook.com", "0002", "2026-11-23T13:48:00Z", "Insufficient funds"),
  tx("order_10479", "tx_91aa5e6d03", 150000, "awaiting_otp", "segun.adeyemi@gmail.com", "1234", "2026-11-23T13:40:00Z"),
  tx("order_10478", "tx_5d27f1b8ac", 3200, "successful", "halima.yusuf@gmail.com", "4081", "2026-11-23T11:22:00Z"),
  tx("order_10477", "tx_e83c42f0d6", 27900, "abandoned", "emeka.eze@gmail.com", null, "2026-11-23T10:57:00Z"),
  tx("order_10476", "tx_06b9ce7a51", 19999, "successful", "funke.alabi@gmail.com", "8812", "2026-11-23T09:31:00Z"),
  tx("order_10475", "tx_a7f4d2903e", 62400, "pending", "kelechi.okafor@gmail.com", "3310", "2026-11-23T09:12:00Z"),
  tx("order_10474", "tx_3e5b18c6f7", 5000, "successful", "bola.ahmed@gmail.com", "4081", "2026-11-23T08:44:00Z"),
  tx("order_10473", "tx_d19e07ab42", 11250, "failed", "ngozi.umeh@gmail.com", "7720", "2026-11-23T08:15:00Z", "Card declined by issuer"),
  tx("order_10472", "tx_8c63fa15d0", 74000, "successful", "david.okon@gmail.com", "5399", "2026-11-22T21:50:00Z"),
  tx("order_10471", "tx_f2a90b7c38", 9600, "successful", "aisha.bello@gmail.com", "1029", "2026-11-22T19:03:00Z"),
  tx("order_10470", "tx_4a1c7e92b5", 33500, "successful", "yemi.alade@gmail.com", "5399", "2026-11-19T16:20:00Z"),
  tx("order_10469", "tx_b7d03f6a18", 7800, "failed", "chidi.nnaji@gmail.com", "0002", "2026-11-12T10:05:00Z", "Insufficient funds"),
  tx("order_10468", "tx_0e95c2d7a3", 120000, "successful", "zainab.musa@gmail.com", "4081", "2026-10-30T12:45:00Z"),
];

// Successful volume per UTC day, 10 to 23 November.
export const dailyVolume: DailyVolume[] = [
  [10, 142300, 12], [11, 168900, 14], [12, 121450, 10], [13, 198200, 16],
  [14, 88900, 8], [15, 64300, 6], [16, 176400, 15], [17, 210750, 17],
  [18, 187600, 15], [19, 224100, 18], [20, 195300, 16], [21, 101450, 9],
  [22, 172800, 14], [23, 228900, 18],
].map(([day, naira, count]) => ({
  date: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`,
  amount_kobo: (naira ?? 0) * 100,
  count: count ?? 0,
}));

// Transaction counts by status over the same 14 days.
export const statusCounts = {
  successful: 188,
  failed: 12,
  pending: 3,
  abandoned: 3,
};

export const topFailureReason = { reason: "Insufficient funds", count: 7 };

export const deliveryStats = {
  attempts: 182,
  delivered: 178,
  failed: 4,
};

function delivery(
  id: string,
  eventId: string,
  txId: string,
  attempt: number,
  status: WebhookDelivery["status"],
  responseCode: number | null,
  errorMessage: string | null,
  attemptedAt: string,
  nextRetryAt: string | null = null,
): WebhookDelivery {
  return {
    id,
    event_id: eventId,
    transaction_id: txId,
    event: "charge.completed",
    target_url: WEBHOOK_URL,
    attempt,
    status,
    response_code: responseCode,
    error_message: errorMessage,
    next_retry_at: nextRetryAt,
    attempted_at: attemptedAt,
  };
}

export const deliveries: WebhookDelivery[] = [
  delivery("whd_09", "evt_8d21f0a3c5", "tx_7f3c9a21e4", 2, "failed", 503, null, "2026-11-23T14:33:09Z", "2026-11-23T14:38:09Z"),
  delivery("whd_08", "evt_8d21f0a3c5", "tx_7f3c9a21e4", 1, "failed", null, "Timed out after 10 s", "2026-11-23T14:32:09Z"),
  delivery("whd_07", "evt_4c7e19b2d0", "tx_2b81d0c7f9", 1, "delivered", 200, null, "2026-11-23T14:05:41Z"),
  delivery("whd_06", "evt_f03a6d81e7", "tx_c4e09a3b12", 1, "delivered", 200, null, "2026-11-23T13:48:44Z"),
  delivery("whd_05", "evt_b5e2c90a14", "tx_5d27f1b8ac", 1, "delivered", 200, null, "2026-11-23T11:22:15Z"),
  delivery("whd_04", "evt_19da7e4f62", "tx_06b9ce7a51", 1, "delivered", 200, null, "2026-11-23T09:31:30Z"),
  delivery("whd_03", "evt_6f0c3b8e29", "tx_3e5b18c6f7", 4, "failed", null, "connect ECONNREFUSED. No more retries.", "2026-11-23T09:20:02Z"),
  delivery("whd_02", "evt_6f0c3b8e29", "tx_3e5b18c6f7", 3, "failed", null, "connect ECONNREFUSED", "2026-11-23T08:50:02Z"),
  delivery("whd_01", "evt_c2a7f5d01b", "tx_d19e07ab42", 1, "delivered", 200, null, "2026-11-23T08:15:27Z"),
];

export const apiKeys: ApiKey[] = [
  { id: "key_04", kind: "secret", prefix: "sk_test_4f9a2c81d3e0", active: true, created_at: "2026-11-02T10:14:00Z", revoked_at: null },
  { id: "key_03", kind: "public", prefix: "pk_test_7b1e03f95a62", active: true, created_at: "2026-11-02T10:14:00Z", revoked_at: null },
  { id: "key_02", kind: "secret", prefix: "sk_test_a03d5e7c19b4", active: false, created_at: "2026-10-28T09:02:00Z", revoked_at: "2026-11-02T10:14:00Z" },
  { id: "key_01", kind: "public", prefix: "pk_test_c8e2f1a07d35", active: false, created_at: "2026-10-28T09:02:00Z", revoked_at: "2026-11-02T10:14:00Z" },
];

/** Builds a fake full key, standing in for POST /v1/merchants/me/keys/rotate. */
export function mockRotateKey(kind: ApiKey["kind"]): { key: ApiKey; value: string } {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const value = `${kind === "secret" ? "sk" : "pk"}_test_${hex}`;
  return {
    value,
    key: {
      id: `key_${hex.slice(0, 6)}`,
      kind,
      prefix: value.slice(0, 20),
      active: true,
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  };
}

export function mockWebhookSecret(): string {
  return `whsec_test_${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
}

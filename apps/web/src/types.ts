// Shapes copied from the API responses in apps/dashboard/src/api-client.ts,
// so the mock data can be swapped for real API calls later.

export interface Merchant {
  id: string;
  business_name: string;
  email: string;
}

export type TransactionStatus = "successful" | "pending" | "awaiting_otp" | "failed" | "abandoned";

export interface Transaction {
  id: string;
  tx_ref: string;
  amount_kobo: number;
  currency: string;
  status: TransactionStatus;
  customer_email: string;
  card_last4: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface WebhookConfig {
  url: string | null;
  secret_configured: boolean;
}

export type DeliveryStatus = "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  event_id: string;
  transaction_id: string;
  event: string;
  target_url: string;
  attempt: number;
  status: DeliveryStatus;
  response_code: number | null;
  error_message: string | null;
  next_retry_at: string | null;
  attempted_at: string;
}

export interface ApiKey {
  id: string;
  kind: "public" | "secret";
  prefix: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

export interface DailyVolume {
  date: string;
  amount_kobo: number;
  count: number;
}

export type Period = "all" | "daily" | "weekly" | "monthly";

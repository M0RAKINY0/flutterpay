export type Currency = "NGN";

export type TransactionStatus =
  | "pending"
  | "awaiting_otp"
  | "successful"
  | "failed"
  | "abandoned";

export type TransactionPeriodType = "all" | "daily" | "weekly" | "monthly";

export type WebhookDeliveryStatus = "pending" | "processing" | "delivered" | "failed";

export interface Transaction {
  id: string;
  tx_ref: string;
  amount_kobo: number;
  currency: Currency;
  status: TransactionStatus;
  customer_email: string;
  card_last4: string | null;
  failure_reason: string | null;
  redirect_url: string;
  expires_at: string;
  created_at: string;
}

export interface CreatePaymentInput {
  tx_ref: string;
  amount_kobo: number;
  currency: Currency;
  customer_email: string;
  redirect_url: string;
}

export interface CreatePaymentResult {
  transaction: Transaction;
  link: string;
}

export interface VerifyTransactionResult {
  transaction: Transaction;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

export interface TransactionPeriod {
  type: TransactionPeriodType;
  date: string | null;
  from: string | null;
  to: string | null;
}

export interface ListTransactionsParams {
  period?: TransactionPeriodType;
  date?: string;
  page?: number;
  limit?: number;
}

export interface ListTransactionsResult {
  transactions: Transaction[];
  period: TransactionPeriod;
  pagination: Pagination;
}

export interface WebhookDelivery {
  id: string;
  event_id: string;
  transaction_id: string;
  event: string;
  target_url: string;
  attempt: number;
  status: WebhookDeliveryStatus;
  response_code: number | null;
  error_message: string | null;
  next_retry_at: string | null;
  attempted_at: string | null;
  created_at: string;
}

export interface ListWebhookDeliveriesParams {
  transaction_id?: string;
  page?: number;
  limit?: number;
}

export interface ListWebhookDeliveriesResult {
  deliveries: WebhookDelivery[];
  pagination: Pagination;
}

export interface ChargeCompletedEvent {
  id: string;
  event: "charge.completed";
  created_at: string;
  data: Transaction;
}

export type WebhookEvent = ChargeCompletedEvent;

export interface VerifyWebhookOptions {
  payload: string | Buffer | Uint8Array;
  signature: string;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}

export type VerifyWebhookSignatureResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: string };

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FlutterPayClientOptions {
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

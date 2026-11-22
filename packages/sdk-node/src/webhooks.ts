import { createHmac, timingSafeEqual } from "node:crypto";
import { FlutterPayWebhookSignatureError } from "./errors.js";
import type {
  ChargeCompletedEvent,
  TransactionStatus,
  VerifyWebhookOptions,
  VerifyWebhookSignatureResult,
} from "./types.js";

export const WEBHOOK_SIGNATURE_HEADER = "x-flutterpay-signature";
export const WEBHOOK_EVENT_HEADER = "x-flutterpay-event";
export const WEBHOOK_EVENT_ID_HEADER = "x-flutterpay-event-id";
export const WEBHOOK_TIMESTAMP_HEADER = "x-flutterpay-timestamp";
export const WEBHOOK_DEFAULT_TOLERANCE_SEC = 300;

const VALID_TRANSACTION_STATUSES = new Set<TransactionStatus>([
  "pending",
  "awaiting_otp",
  "successful",
  "failed",
  "abandoned",
]);

function toPayloadBuffer(payload: string | Buffer | Uint8Array): Buffer {
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8");
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

export function verifyWebhookSignature(options: VerifyWebhookOptions): VerifyWebhookSignatureResult {
  const { payload, signature, secret, now, toleranceSeconds } = options;

  if (typeof secret !== "string" || secret.length === 0 || typeof signature !== "string" || signature.length === 0) {
    return { valid: false, reason: "Missing signature header or secret" };
  }

  let timestampRaw: string | undefined;
  let signatureHex: string | undefined;

  for (const part of signature.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      return { valid: false, reason: "Malformed signature header" };
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      if (timestampRaw !== undefined) {
        return { valid: false, reason: "Duplicate timestamp in signature header" };
      }
      timestampRaw = value;
    } else if (key === "v1") {
      if (signatureHex !== undefined) {
        return { valid: false, reason: "Duplicate v1 signature in header" };
      }
      signatureHex = value;
    }
  }

  if (!timestampRaw || !/^\d+$/.test(timestampRaw) || !signatureHex || !/^[a-f0-9]{64}$/i.test(signatureHex)) {
    return { valid: false, reason: "Malformed signature header" };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp)) {
    return { valid: false, reason: "Invalid signature timestamp" };
  }

  const tolerance = toleranceSeconds ?? WEBHOOK_DEFAULT_TOLERANCE_SEC;
  if (Number.isNaN(tolerance) || tolerance < 0) {
    return { valid: false, reason: "Invalid toleranceSeconds" };
  }

  if (Number.isFinite(tolerance)) {
    const current = now ?? new Date();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
      return { valid: false, reason: "Invalid reference date" };
    }
    const nowSec = Math.floor(current.getTime() / 1000);
    if (Math.abs(nowSec - timestamp) > tolerance) {
      return { valid: false, reason: "Webhook timestamp outside tolerance window" };
    }
  }

  const payloadBuffer = toPayloadBuffer(payload);
  const signedPayload = Buffer.concat([Buffer.from(`${timestampRaw}.`, "utf8"), payloadBuffer]);
  const expected = createHmac("sha256", secret).update(signedPayload).digest();
  const provided = Buffer.from(signatureHex.toLowerCase(), "hex");

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: "Invalid webhook signature" };
  }

  return { valid: true, timestamp };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isChargeCompletedEvent(value: unknown): value is ChargeCompletedEvent {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (value.event !== "charge.completed") return false;
  if (typeof value.created_at !== "string" || value.created_at.length === 0) return false;

  const data = value.data;
  if (!isRecord(data)) return false;
  if (typeof data.id !== "string" || data.id.length === 0) return false;
  if (typeof data.tx_ref !== "string" || data.tx_ref.length === 0) return false;
  if (typeof data.amount_kobo !== "number" || !Number.isSafeInteger(data.amount_kobo)) return false;
  if (data.currency !== "NGN") return false;
  if (typeof data.status !== "string" || !VALID_TRANSACTION_STATUSES.has(data.status as TransactionStatus)) return false;
  if (typeof data.customer_email !== "string") return false;
  if (!isNullableString(data.card_last4)) return false;
  if (!isNullableString(data.failure_reason)) return false;
  if (typeof data.redirect_url !== "string") return false;
  if (typeof data.expires_at !== "string") return false;
  if (typeof data.created_at !== "string") return false;

  return true;
}

export function verifyWebhookEvent(options: VerifyWebhookOptions): ChargeCompletedEvent {
  const check = verifyWebhookSignature(options);
  if (!check.valid) {
    throw new FlutterPayWebhookSignatureError(check.reason);
  }

  const rawText = toPayloadBuffer(options.payload).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new FlutterPayWebhookSignatureError("Invalid webhook JSON payload", { cause: error });
  }

  if (!isChargeCompletedEvent(parsed)) {
    throw new FlutterPayWebhookSignatureError("Malformed webhook event payload");
  }

  return parsed;
}

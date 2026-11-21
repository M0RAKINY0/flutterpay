import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { requireSecretKey, type MerchantLocals } from "./auth.js";
import { serializeTransaction, transactionSelect } from "./transactions.js";

export type WebhookDbClient = PrismaClient | Prisma.TransactionClient;

export const WEBHOOK_EVENT_CHARGE_COMPLETED = "charge.completed";
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_DEFAULT_TOLERANCE_SEC = 300;
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_CLAIM_LEASE_MS = 30_000;

export type WebhookSendResult = {
  ok: boolean;
  statusCode: number | null;
  errorMessage: string | null;
};

export type WebhookSender = (args: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<WebhookSendResult>;

export type WebhookDeliveryOptions = {
  now?: () => Date;
  sender?: WebhookSender;
  timeoutMs?: number;
  claimLeaseMs?: number;
};

export type WebhookTracker = {
  track: (promise: Promise<unknown>, context: string) => void;
  drain: () => Promise<void>;
};

export function createWebhookTracker(): WebhookTracker {
  const active = new Set<Promise<void>>();
  return {
    track(promise, context) {
      const wrapped = promise
        .then(() => undefined)
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Webhook background failure (${context}): ${message}`);
        })
        .finally(() => {
          active.delete(wrapped);
        });
      active.add(wrapped);
    },
    async drain() {
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
    },
  };
}

export function generateWebhookSecret() {
  return `fp_whsec_test_${randomBytes(32).toString("hex")}`;
}

export function signWebhookPayload(payload: string, secret: string, timestampSec: number) {
  const timestamp = String(timestampSec);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return {
    timestamp,
    digest,
    signature: `t=${timestamp},v1=${digest}`,
  };
}

export function verifyWebhookSignature(options: {
  payload: string | Buffer;
  header: string;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): { valid: true; timestamp: number } | { valid: false; reason: string } {
  const { payload, header, secret } = options;
  if (!secret || !header) {
    return { valid: false, reason: "Missing signature header or secret" };
  }

  let timestampRaw: string | undefined;
  let signatureHex: string | undefined;
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) return { valid: false, reason: "Malformed signature header" };
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      if (timestampRaw !== undefined) return { valid: false, reason: "Duplicate timestamp in signature header" };
      timestampRaw = value;
    } else if (key === "v1") {
      if (signatureHex !== undefined) return { valid: false, reason: "Duplicate v1 signature in header" };
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

  const tolerance = options.toleranceSeconds ?? WEBHOOK_DEFAULT_TOLERANCE_SEC;
  if (Number.isFinite(tolerance)) {
    const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSec - timestamp) > tolerance) {
      return { valid: false, reason: "Webhook timestamp outside tolerance window" };
    }
  }

  const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
  const expected = signWebhookPayload(payloadText, secret, timestamp).digest;
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHex.toLowerCase(), "hex");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: "Invalid webhook signature" };
  }

  return { valid: true, timestamp };
}

export async function sendWebhookHttp(args: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<WebhookSendResult> {
  try {
    const response = await fetch(args.url, {
      method: "POST",
      headers: args.headers,
      body: args.body,
      redirect: "manual",
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, statusCode: response.status, errorMessage: null };
    }
    return { ok: false, statusCode: response.status, errorMessage: `HTTP ${response.status}` };
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      statusCode: null,
      errorMessage: isTimeout ? "Request timed out" : "Network delivery error",
    };
  }
}

export async function enqueueChargeCompletedWebhook(db: WebhookDbClient, transactionId: string, now: Date) {
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      ...transactionSelect,
      merchant: { select: { webhookUrl: true, webhookSecret: true } },
    },
  });

  if (!tx || !tx.merchant.webhookUrl || !tx.merchant.webhookSecret) {
    return null;
  }

  const eventId = `evt_${randomBytes(16).toString("hex")}`;
  const payload = JSON.stringify({
    id: eventId,
    event: WEBHOOK_EVENT_CHARGE_COMPLETED,
    created_at: now.toISOString(),
    data: serializeTransaction(tx),
  });

  return db.webhookDelivery.create({
    data: {
      eventId,
      transactionId: tx.id,
      event: WEBHOOK_EVENT_CHARGE_COMPLETED,
      targetUrl: tx.merchant.webhookUrl,
      payload,
      attempt: 1,
      status: "PENDING",
      nextRetryAt: now,
      createdAt: now,
    },
  });
}

export async function deliverWebhookAttempt(
  db: PrismaClient,
  deliveryId: string,
  options?: WebhookDeliveryOptions,
) {
  const nowFn = options?.now ?? (() => new Date());
  const sender = options?.sender ?? sendWebhookHttp;
  const timeoutMs = options?.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const claimLeaseMs = options?.claimLeaseMs ?? WEBHOOK_CLAIM_LEASE_MS;
  const claimTime = nowFn();
  const claimToken = randomBytes(16).toString("hex");
  const claimExpiresAt = new Date(claimTime.getTime() + claimLeaseMs);

  // Atomically claim either a due PENDING row or a PROCESSING row whose lease expired.
  const claimed = await db.webhookDelivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        { status: "PENDING", nextRetryAt: { lte: claimTime } },
        { status: "PROCESSING", claimExpiresAt: { lte: claimTime } },
      ],
    },
    data: {
      status: "PROCESSING",
      claimToken,
      claimExpiresAt,
    },
  });

  if (claimed.count === 0) return false;

  const delivery = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      eventId: true,
      transactionId: true,
      event: true,
      targetUrl: true,
      payload: true,
      attempt: true,
      transaction: {
        select: {
          merchant: { select: { webhookUrl: true, webhookSecret: true } },
        },
      },
    },
  });

  if (!delivery) return false;

  // Resolve current URL + secret together so pending retries never send to an old URL with a new secret.
  const targetUrl = delivery.transaction.merchant.webhookUrl;
  const secret = delivery.transaction.merchant.webhookSecret;
  if (!targetUrl || !secret) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "PROCESSING", claimToken },
      data: {
        status: "FAILED",
        claimToken: null,
        claimExpiresAt: null,
        responseCode: null,
        errorMessage: "Webhooks are no longer configured",
        attemptedAt: nowFn(),
        nextRetryAt: null,
      },
    });
    return true;
  }

  const sendTime = nowFn();
  const timestampSec = Math.floor(sendTime.getTime() / 1000);
  const signed = signWebhookPayload(delivery.payload, secret, timestampSec);

  let result: WebhookSendResult;
  try {
    result = await sender({
      url: targetUrl,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "FlutterPay-Webhook/1.0",
        "X-FlutterPay-Event": delivery.event,
        "X-FlutterPay-Event-Id": delivery.eventId,
        "X-FlutterPay-Timestamp": signed.timestamp,
        "X-FlutterPay-Signature": signed.signature,
      },
      body: delivery.payload,
      timeoutMs,
    });
  } catch {
    result = { ok: false, statusCode: null, errorMessage: "Webhook sender error" };
  }

  const finishedAt = nowFn();

  if (result.ok) {
    await db.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "PROCESSING", claimToken },
      data: {
        targetUrl,
        status: "DELIVERED",
        claimToken: null,
        claimExpiresAt: null,
        responseCode: result.statusCode,
        errorMessage: null,
        attemptedAt: finishedAt,
        nextRetryAt: null,
      },
    });
    return true;
  }

  const retryDelayMs = WEBHOOK_RETRY_DELAYS_MS[delivery.attempt - 1];
  const nextRetryAt = retryDelayMs !== undefined ? new Date(finishedAt.getTime() + retryDelayMs) : null;

  await db.$transaction(async prisma => {
    const finalized = await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "PROCESSING", claimToken },
      data: {
        targetUrl,
        status: "FAILED",
        claimToken: null,
        claimExpiresAt: null,
        responseCode: result.statusCode,
        errorMessage: result.errorMessage,
        attemptedAt: finishedAt,
        nextRetryAt,
      },
    });

    // Only the worker that still owns the claim may schedule the next retry attempt.
    if (finalized.count === 1 && nextRetryAt !== null) {
      await prisma.webhookDelivery.create({
        data: {
          eventId: delivery.eventId,
          transactionId: delivery.transactionId,
          event: delivery.event,
          targetUrl,
          payload: delivery.payload,
          attempt: delivery.attempt + 1,
          status: "PENDING",
          nextRetryAt,
          createdAt: finishedAt,
        },
      });
    }
  });

  return true;
}

export async function processDueWebhooks(
  db: PrismaClient,
  options?: WebhookDeliveryOptions & { batchSize?: number },
) {
  const nowFn = options?.now ?? (() => new Date());
  const batchSize = options?.batchSize ?? 20;
  const currentTime = nowFn();
  const due = await db.webhookDelivery.findMany({
    where: {
      OR: [
        { status: "PENDING", nextRetryAt: { lte: currentTime } },
        { status: "PROCESSING", claimExpiresAt: { lte: currentTime } },
      ],
    },
    select: { id: true },
    orderBy: [{ nextRetryAt: "asc" }, { createdAt: "asc" }],
    take: batchSize,
  });

  let processed = 0;
  for (const row of due) {
    const didProcess = await deliverWebhookAttempt(db, row.id, options);
    if (didProcess) processed += 1;
  }
  return processed;
}

export function startWebhookWorker(
  db: PrismaClient,
  options?: WebhookDeliveryOptions & { intervalMs?: number; tracker?: WebhookTracker },
) {
  const intervalMs = options?.intervalMs ?? 5_000;
  let activeTick: Promise<void> | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped || activeTick) return;
    activeTick = processDueWebhooks(db, options)
      .then(() => undefined)
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Webhook worker poll failed: ${message}`);
      })
      .finally(() => {
        activeTick = null;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (activeTick) await activeTick;
      if (options?.tracker) await options.tracker.drain();
    },
  };
}

const deliverySelect = {
  id: true,
  eventId: true,
  transactionId: true,
  event: true,
  targetUrl: true,
  attempt: true,
  status: true,
  responseCode: true,
  errorMessage: true,
  nextRetryAt: true,
  attemptedAt: true,
  createdAt: true,
} as const;

type SelectedDelivery = Prisma.WebhookDeliveryGetPayload<{ select: typeof deliverySelect }>;

function serializeDelivery(delivery: SelectedDelivery) {
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    transaction_id: delivery.transactionId,
    event: delivery.event,
    target_url: delivery.targetUrl,
    attempt: delivery.attempt,
    status: delivery.status.toLowerCase(),
    response_code: delivery.responseCode,
    error_message: delivery.errorMessage,
    next_retry_at: delivery.nextRetryAt ? delivery.nextRetryAt.toISOString() : null,
    attempted_at: delivery.attemptedAt ? delivery.attemptedAt.toISOString() : null,
    created_at: delivery.createdAt.toISOString(),
  };
}

function parsePositiveInt(max: number) {
  return z.string().regex(/^[1-9]\d*$/).transform(Number).refine(value => Number.isSafeInteger(value) && value <= max);
}

const listDeliveriesQuery = z.strictObject({
  transaction_id: z.string().trim().min(1).max(100).optional(),
  page: parsePositiveInt(10_000).default(1),
  limit: parsePositiveInt(100).default(20),
});

export function webhookRoutes(db: PrismaClient) {
  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/deliveries", requireSecretKey(db), async (req, res: Response<unknown, MerchantLocals>, next) => {
    const parsed = listDeliveriesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Use optional transaction_id, page (1-10000) and limit (1-100).",
        },
      });
      return;
    }

    const { transaction_id, page, limit } = parsed.data;
    const where: Prisma.WebhookDeliveryWhereInput = {
      ...(transaction_id ? { transactionId: transaction_id } : {}),
      transaction: { merchantId: res.locals.merchant.id },
    };

    try {
      const [total, rows] = await db.$transaction([
        db.webhookDelivery.count({ where }),
        db.webhookDelivery.findMany({
          where,
          select: deliverySelect,
          orderBy: [{ createdAt: "desc" }, { attempt: "desc" }, { id: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      res.json({
        deliveries: rows.map(serializeDelivery),
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          has_next: page < totalPages,
          has_previous: page > 1 && totalPages > 0,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

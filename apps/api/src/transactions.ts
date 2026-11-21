import { Router, type Response } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { requireSecretKey, type MerchantLocals } from "./auth.js";

export const transactionSelect = {
  id: true,
  txRef: true,
  amountKobo: true,
  currency: true,
  status: true,
  customerEmail: true,
  cardLast4: true,
  failureReason: true,
  redirectUrl: true,
  expiresAt: true,
  createdAt: true,
} as const;

export type SelectedTransaction = Prisma.TransactionGetPayload<{ select: typeof transactionSelect }>;

export function serializeTransaction(transaction: SelectedTransaction) {
  return {
    id: transaction.id,
    tx_ref: transaction.txRef,
    amount_kobo: transaction.amountKobo,
    currency: transaction.currency,
    status: transaction.status.toLowerCase(),
    customer_email: transaction.customerEmail,
    card_last4: transaction.cardLast4,
    failure_reason: transaction.failureReason,
    redirect_url: transaction.redirectUrl,
    expires_at: transaction.expiresAt.toISOString(),
    created_at: transaction.createdAt.toISOString(),
  };
}

export async function expireTransactionIfNeeded(db: PrismaClient, id: string, now: Date) {
  await db.transaction.updateMany({
    where: {
      id,
      status: { in: ["PENDING", "AWAITING_OTP"] },
      expiresAt: { lte: now },
    },
    data: {
      status: "ABANDONED",
      failureReason: "Payment link expired",
    },
  });
}

type PeriodType = "all" | "daily" | "weekly" | "monthly";

function parseUtcDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9998) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function formatUtcDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePositiveInt(max: number) {
  return z.string().regex(/^[1-9]\d*$/).transform(Number).refine(value => Number.isSafeInteger(value) && value <= max);
}

const listTransactionsQuery = z.strictObject({
  period: z.enum(["all", "daily", "weekly", "monthly"]).default("all"),
  date: z.string().refine(value => parseUtcDate(value) !== null).optional(),
  page: parsePositiveInt(10_000).default(1),
  limit: parsePositiveInt(100).default(20),
}).refine(data => data.period !== "all" || data.date === undefined);

function resolvePeriodWindow(period: PeriodType, dateParam: string | undefined, now: Date) {
  if (period === "all") {
    return { type: period, date: null, from: null, to: null };
  }
  const parts = dateParam
    ? parseUtcDate(dateParam)!
    : { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  const date = formatUtcDate(parts.year, parts.month, parts.day);

  if (period === "daily") {
    return {
      type: period,
      date,
      from: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
      to: new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1)),
    };
  }
  if (period === "weekly") {
    const anchor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    // ISO week starts on Monday (00:00 UTC) and ends before the next Monday.
    const daysSinceMonday = (anchor.getUTCDay() + 6) % 7;
    return {
      type: period,
      date,
      from: new Date(Date.UTC(parts.year, parts.month - 1, parts.day - daysSinceMonday)),
      to: new Date(Date.UTC(parts.year, parts.month - 1, parts.day - daysSinceMonday + 7)),
    };
  }
  return {
    type: period,
    date,
    from: new Date(Date.UTC(parts.year, parts.month - 1, 1)),
    to: new Date(Date.UTC(parts.year, parts.month, 1)),
  };
}

export function transactionRoutes(db: PrismaClient, options?: { now?: () => Date }) {
  const router = Router();
  const now = options?.now ?? (() => new Date());

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", requireSecretKey(db), async (req, res: Response<unknown, MerchantLocals>, next) => {
    const parsed = listTransactionsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Use period (all, daily, weekly, monthly), optional YYYY-MM-DD date with a period, page (1-10000) and limit (1-100).",
        },
      });
      return;
    }

    const { period, date, page, limit } = parsed.data;
    const window = resolvePeriodWindow(period, date, now());
    const where: Prisma.TransactionWhereInput = {
      merchantId: res.locals.merchant.id,
      ...(window.from && window.to ? { createdAt: { gte: window.from, lt: window.to } } : {}),
    };

    try {
      const [total, rows] = await db.$transaction([
        db.transaction.count({ where }),
        db.transaction.findMany({
          where,
          select: transactionSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      res.json({
        transactions: rows.map(serializeTransaction),
        period: {
          type: window.type,
          date: window.date,
          from: window.from ? window.from.toISOString() : null,
          to: window.to ? window.to.toISOString() : null,
        },
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

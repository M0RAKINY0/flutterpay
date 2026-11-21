import { json, Router, type Response } from "express";
import { z } from "zod";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { requireSecretKey, type MerchantLocals } from "./auth.js";
import { serializeTransaction, transactionSelect } from "./transactions.js";

export const MIN_AMOUNT_KOBO = 100;
export const MAX_AMOUNT_KOBO = 100_000_000;
export const PAYMENT_EXPIRY_MS = 30 * 60_000;

export function isSafeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  if (!isSafeHttpUrl(trimmed)) {
    throw new Error("APP_BASE_URL must be an http:// or https:// URL without embedded credentials.");
  }
  const url = new URL(trimmed);
  if (url.search || url.hash) {
    throw new Error("APP_BASE_URL must not include a query string or hash.");
  }
  return trimmed.replace(/\/+$/, "");
}

const createPaymentInput = z.strictObject({
  tx_ref: z.string().trim().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/),
  amount_kobo: z.number().int().min(MIN_AMOUNT_KOBO).max(MAX_AMOUNT_KOBO),
  currency: z.literal("NGN"),
  customer_email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  redirect_url: z.string().trim().min(1).max(2048).refine(isSafeHttpUrl),
});

export function paymentRoutes(db: PrismaClient, options?: { appBaseUrl?: string; now?: () => Date }) {
  const router = Router();
  const baseUrl = normalizeBaseUrl(options?.appBaseUrl ?? "http://127.0.0.1:3000");
  const now = options?.now ?? (() => new Date());

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/", requireSecretKey(db), json({ limit: "8kb" }), async (req, res: Response<unknown, MerchantLocals>, next) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send a JSON request body." } });
      return;
    }
    const parsed = createPaymentInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Provide tx_ref, whole-kobo amount_kobo (100 to 100000000), currency NGN, a valid customer_email and an http(s) redirect_url.",
        },
      });
      return;
    }

    const input = parsed.data;
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + PAYMENT_EXPIRY_MS);

    try {
      const transaction = await db.transaction.create({
        data: {
          merchantId: res.locals.merchant.id,
          txRef: input.tx_ref,
          amountKobo: input.amount_kobo,
          currency: input.currency,
          customerEmail: input.customer_email,
          redirectUrl: input.redirect_url,
          expiresAt,
          createdAt,
        },
        select: transactionSelect,
      });

      res.status(201).json({
        transaction: serializeTransaction(transaction),
        link: `${baseUrl}/pay/${transaction.id}`,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({
          error: { code: "DUPLICATE_TX_REF", message: "A transaction with this tx_ref already exists." },
        });
        return;
      }
      next(error);
    }
  });

  return router;
}

import { hash, argon2id } from "argon2";
import { json, Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { requireSecretKey, type MerchantLocals } from "./auth.js";
import { generateKey } from "./keys.js";

const signupInput = z.strictObject({
  business_name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(12).max(128),
});

export function merchantRoutes(db: PrismaClient) {
  const router = Router();
  const signupLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many signup requests. Please try again later." } },
  });

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/", signupLimit, json({ limit: "8kb" }), async (req, res, next) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send a JSON request body." } });
      return;
    }
    const parsed = signupInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Provide a business name, a valid email and a password of 12 to 128 characters." } });
      return;
    }

    const input = parsed.data;
    const passwordHash = await hash(input.password, { type: argon2id });
    const publicKey = generateKey("PUBLIC");
    const secretKey = generateKey("SECRET");

    try {
      // Nested writes commit the merchant and both keys together, or roll back all of them.
      const merchant = await db.merchant.create({
        data: {
          businessName: input.business_name,
          email: input.email,
          passwordHash,
          apiKeys: { create: [publicKey.record, secretKey.record] },
        },
        select: { id: true, businessName: true, email: true },
      });
      res.status(201).json({
        merchant: { id: merchant.id, business_name: merchant.businessName, email: merchant.email },
        keys: { public_key: publicKey.key, secret_key: secretKey.key },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ error: { code: "EMAIL_EXISTS", message: "A merchant with this email already exists." } });
        return;
      }
      next(error);
    }
  });

  router.get("/me", requireSecretKey(db), (_req, res: Response<unknown, MerchantLocals>) => {
    res.json({ merchant: res.locals.merchant });
  });

  return router;
}

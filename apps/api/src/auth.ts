import type { RequestHandler } from "express";
import type { PrismaClient } from "./generated/prisma/client.js";
import { hashKey } from "./keys.js";

export type MerchantLocals = {
  merchant: { id: string; business_name: string; email: string };
};

export function requireSecretKey(db: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const match = /^Bearer[ \t]+(fp_sec_test_[a-f0-9]{64})$/i.exec(req.get("authorization") ?? "");
    const key = match?.[1];
    const record = key ? await db.apiKey.findUnique({
      where: { keyHash: hashKey(key) },
      select: {
        kind: true,
        revokedAt: true,
        merchant: { select: { id: true, businessName: true, email: true } },
      },
    }) : null;

    if (!record || record.kind !== "SECRET" || record.revokedAt !== null) {
      res.set("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid secret API key is required." } });
      return;
    }

    res.locals.merchant = {
      id: record.merchant.id,
      business_name: record.merchant.businessName,
      email: record.merchant.email,
    } satisfies MerchantLocals["merchant"];
    next();
  };
}

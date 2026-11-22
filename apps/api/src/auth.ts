import type { RequestHandler } from "express";
import type { PrismaClient } from "./generated/prisma/client.js";
import { hashKey } from "./keys.js";
import { constantTimeStringEqual, getSessionCookie, loadActiveSession } from "./sessions.js";

export type MerchantLocals = {
  merchant: { id: string; business_name: string; email: string };
  authKind?: "secret_key" | "session";
};

async function authenticateSecretKey(db: PrismaClient, authorization: string) {
  const match = /^Bearer[ \t]+(fp_sec_test_[a-f0-9]{64})$/i.exec(authorization);
  const key = match?.[1];
  if (!key) return null;

  const record = await db.apiKey.findUnique({
    where: { keyHash: hashKey(key) },
    select: {
      kind: true,
      revokedAt: true,
      merchant: { select: { id: true, businessName: true, email: true } },
    },
  });

  if (!record || record.kind !== "SECRET" || record.revokedAt !== null) {
    return null;
  }

  return {
    id: record.merchant.id,
    business_name: record.merchant.businessName,
    email: record.merchant.email,
  };
}

export function requireSecretKey(db: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    try {
      const merchant = await authenticateSecretKey(db, req.get("authorization") ?? "");
      if (!merchant) {
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid secret API key is required." } });
        return;
      }

      res.locals.merchant = merchant satisfies MerchantLocals["merchant"];
      res.locals.authKind = "secret_key";
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireMerchantAuth(
  db: PrismaClient,
  options?: { now?: () => Date; requireCsrf?: boolean },
): RequestHandler {
  const now = options?.now ?? (() => new Date());
  const requireCsrf = options?.requireCsrf ?? false;

  return async (req, res, next) => {
    try {
      const authorization = req.get("authorization");
      if (authorization !== undefined) {
        const merchant = await authenticateSecretKey(db, authorization);
        if (!merchant) {
          res.set("WWW-Authenticate", "Bearer");
          res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid secret API key is required." } });
          return;
        }
        res.locals.merchant = merchant satisfies MerchantLocals["merchant"];
        res.locals.authKind = "secret_key";
        next();
        return;
      }

      const token = getSessionCookie(req.get("cookie"));
      const session = await loadActiveSession(db, token, now());
      if (!session) {
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid secret API key is required." } });
        return;
      }

      if (requireCsrf) {
        const providedCsrf = req.get("x-csrf-token") ?? "";
        if (!providedCsrf || !constantTimeStringEqual(providedCsrf, session.csrfToken)) {
          res.status(403).json({ error: { code: "INVALID_CSRF", message: "Invalid or missing CSRF token." } });
          return;
        }
      }

      res.locals.merchant = {
        id: session.merchant.id,
        business_name: session.merchant.businessName,
        email: session.merchant.email,
      } satisfies MerchantLocals["merchant"];
      res.locals.authKind = "session";
      next();
    } catch (error) {
      next(error);
    }
  };
}

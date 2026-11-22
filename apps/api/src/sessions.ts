import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { argon2id, hash, verify } from "argon2";
import { json, Router, type Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { PrismaClient } from "./generated/prisma/client.js";

export const SESSION_COOKIE_NAME = "fp_session";
export const SESSION_TTL_MS = 24 * 60 * 60_000;
const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000);

const loginInput = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(128),
});

let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hash("flutterpay-dummy-password-for-timing", { type: argon2id });
  }
  return dummyPasswordHashPromise;
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeStringEqual(a: string, b: string) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !(name in result)) {
      result[name] = value;
    }
  }
  return result;
}

export function getSessionCookie(cookieHeader: string | undefined): string | null {
  const raw = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw)) return null;
  return raw;
}

export function buildSessionCookie(token: string, secure: boolean) {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}${secure ? "; Secure" : ""}`;
}

export function buildClearSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function loadActiveSession(db: PrismaClient, rawToken: string | null, now: Date) {
  if (!rawToken) return null;
  const session = await db.merchantSession.findUnique({
    where: { tokenHash: hashSessionToken(rawToken) },
    select: {
      id: true,
      csrfToken: true,
      expiresAt: true,
      revokedAt: true,
      merchant: {
        select: { id: true, businessName: true, email: true },
      },
    },
  });
  if (!session || session.revokedAt !== null || session.expiresAt <= now) {
    return null;
  }
  return session;
}

export function resolveRateLimitKey(req: Request, trustedProxySecret?: string): string {
  if (trustedProxySecret) {
    const providedSecret = req.get("x-flutterpay-proxy-secret") ?? "";
    const forwardedIp = (req.get("x-flutterpay-client-ip") ?? "").trim();
    if (
      providedSecret.length > 0 &&
      constantTimeStringEqual(providedSecret, trustedProxySecret) &&
      isIP(forwardedIp) !== 0
    ) {
      return `proxy:${ipKeyGenerator(forwardedIp)}`;
    }
  }
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

export function sessionRoutes(
  db: PrismaClient,
  options?: { appBaseUrl?: string; now?: () => Date; trustedProxySecret?: string },
) {
  const router = Router();
  const now = options?.now ?? (() => new Date());
  const secureByConfig = (options?.appBaseUrl ?? "").trim().toLowerCase().startsWith("https://");
  const trustedProxySecret = options?.trustedProxySecret?.trim() || undefined;

  const loginLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: req => resolveRateLimitKey(req, trustedProxySecret),
    message: { error: { code: "RATE_LIMITED", message: "Too many login attempts. Please try again later." } },
  });

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/", loginLimit, json({ limit: "8kb" }), async (req, res, next) => {
    if (!req.is("application/json")) {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send a JSON request body." } });
      return;
    }

    const parsed = loginInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Provide a valid email and password." } });
      return;
    }

    const { email, password } = parsed.data;
    try {
      const merchant = await db.merchant.findUnique({
        where: { email },
        select: { id: true, businessName: true, email: true, passwordHash: true },
      });

      const hashToCheck = merchant ? merchant.passwordHash : await getDummyPasswordHash();
      const passwordOk = await verify(hashToCheck, password).catch(() => false);

      if (!merchant || !passwordOk) {
        res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
        return;
      }

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
      const rawToken = randomBytes(32).toString("hex");
      const csrfToken = randomBytes(32).toString("hex");

      const session = await db.merchantSession.create({
        data: {
          merchantId: merchant.id,
          tokenHash: hashSessionToken(rawToken),
          csrfToken,
          expiresAt,
          createdAt,
        },
        select: { id: true, expiresAt: true, csrfToken: true },
      });

      const secure = secureByConfig || req.secure;
      res.setHeader("Set-Cookie", buildSessionCookie(rawToken, secure));
      res.status(201).json({
        session: {
          id: session.id,
          expires_at: session.expiresAt.toISOString(),
          csrf_token: session.csrfToken,
        },
        merchant: {
          id: merchant.id,
          business_name: merchant.businessName,
          email: merchant.email,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const token = getSessionCookie(req.get("cookie"));
      const session = await loadActiveSession(db, token, now());
      if (!session) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid session is required." } });
        return;
      }

      res.json({
        session: {
          id: session.id,
          expires_at: session.expiresAt.toISOString(),
          csrf_token: session.csrfToken,
        },
        merchant: {
          id: session.merchant.id,
          business_name: session.merchant.businessName,
          email: session.merchant.email,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = getSessionCookie(req.get("cookie"));
      const session = await loadActiveSession(db, token, now());
      if (!session) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid session is required." } });
        return;
      }

      const providedCsrf = req.get("x-csrf-token") ?? "";
      if (!providedCsrf || !constantTimeStringEqual(providedCsrf, session.csrfToken)) {
        res.status(403).json({ error: { code: "INVALID_CSRF", message: "Invalid or missing CSRF token." } });
        return;
      }

      await db.merchantSession.update({
        where: { id: session.id },
        data: { revokedAt: now() },
      });

      const secure = secureByConfig || req.secure;
      res.setHeader("Set-Cookie", buildClearSessionCookie(secure));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

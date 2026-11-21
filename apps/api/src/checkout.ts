import { json, Router, urlencoded, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "./generated/prisma/client.js";
import { chargeCard, MAX_OTP_ATTEMPTS, parseOtpInput, validateCardInput, verifyOtp } from "./fake-bank.js";
import { normalizeBaseUrl } from "./payments.js";
import { expireTransactionIfNeeded, serializeTransaction, transactionSelect, type SelectedTransaction } from "./transactions.js";
import {
  createWebhookTracker,
  deliverWebhookAttempt,
  enqueueChargeCompletedWebhook,
  type WebhookSender,
  type WebhookTracker,
} from "./webhooks.js";

type CheckoutRecord = SelectedTransaction & {
  otpAttempts: number;
  merchant: { businessName: string };
};

const checkoutSelect = {
  ...transactionSelect,
  otpAttempts: true,
  merchant: { select: { businessName: true } },
} as const;

const chargeBodySchema = z.strictObject({
  card_number: z.string(),
  expiry: z.string(),
  cvv: z.string(),
});

const otpBodySchema = z.strictObject({
  otp: z.string(),
});

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatNaira(amountKobo: number) {
  const naira = Math.floor(amountKobo / 100);
  const kobo = String(amountKobo % 100).padStart(2, "0");
  return `₦${String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${kobo}`;
}

export function buildRedirectUrl(redirectUrl: string, tx: { id: string; txRef: string; status: string }) {
  const url = new URL(redirectUrl);
  url.searchParams.set("status", tx.status.toLowerCase());
  url.searchParams.set("tx_ref", tx.txRef);
  url.searchParams.set("transaction_id", tx.id);
  return url.toString();
}

function prefersJson(req: Request) {
  if (req.is("application/json")) return true;
  const accept = req.get("accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function getParamId(req: Request) {
  const raw = req.params.id;
  return typeof raw === "string" ? raw : "";
}

function renderPage(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · FlutterPay</title>
  <style>
    :root { color-scheme: light dark; --bg: #f6f8f7; --card: #ffffff; --fg: #142019; --muted: #56655d; --line: #d9e2dc; --accent: #0b7a4b; --accent-fg: #ffffff; --err-bg: #fdecec; --err-fg: #9f1c1c; --ok-bg: #e2f3ea; --ok-fg: #0b5d39; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0f1512; --card: #161e1a; --fg: #e3ebe6; --muted: #98a89f; --line: #2a3530; --accent: #3fc98a; --accent-fg: #0b1a12; --err-bg: #3b1717; --err-fg: #f8b4b4; --ok-bg: #17352a; --ok-fg: #7ce2b1; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
    main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
    .eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); font-weight: 600; margin: 0 0 6px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    .amount { font-size: 28px; font-weight: 700; margin: 12px 0 4px; }
    .meta { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
    label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button, a.btn { display: inline-block; width: 100%; margin-top: 18px; padding: 11px 16px; border: none; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
    .alert { padding: 10px 12px; border-radius: 8px; font-size: 14px; margin: 12px 0; }
    .alert.err { background: var(--err-bg); color: var(--err-fg); }
    .alert.ok { background: var(--ok-bg); color: var(--ok-fg); }
    details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 12px; font-size: 13px; color: var(--muted); }
    summary { cursor: pointer; font-weight: 600; color: var(--fg); }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    ul { padding-left: 18px; margin: 8px 0 0; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function renderCardForm(tx: CheckoutRecord, errorMessage?: string) {
  const id = encodeURIComponent(tx.id);
  const errorBanner = errorMessage ? `<div class="alert err" role="alert">${escapeHtml(errorMessage)}</div>` : "";
  return renderPage(
    `Pay ${tx.merchant.businessName}`,
    `<p class="eyebrow">FlutterPay Test Checkout</p>
    <h1>${escapeHtml(tx.merchant.businessName)}</h1>
    <div class="amount">${escapeHtml(formatNaira(tx.amountKobo))}</div>
    <p class="meta">${escapeHtml(tx.customerEmail)} · Ref: <code>${escapeHtml(tx.txRef)}</code></p>
    ${errorBanner}
    <form method="post" action="/pay/${id}/charge" autocomplete="off">
      <label for="card_number">Test card number</label>
      <input id="card_number" name="card_number" inputmode="numeric" placeholder="4242 4242 4242 4242" required>
      <div class="row">
        <div>
          <label for="expiry">Expiry (MM/YY)</label>
          <input id="expiry" name="expiry" placeholder="12/30" required>
        </div>
        <div>
          <label for="cvv">CVV</label>
          <input id="cvv" name="cvv" inputmode="numeric" placeholder="123" required>
        </div>
      </div>
      <button type="submit">Pay ${escapeHtml(formatNaira(tx.amountKobo))}</button>
    </form>
    <details>
      <summary>Fake bank test cards (no real money)</summary>
      <ul>
        <li><code>4242 4242 4242 4242</code> — approves straight away</li>
        <li><code>5060 9900 0000 0001</code> — asks for OTP (<code>123456</code>)</li>
        <li><code>4000 0000 0000 0002</code> — declines (card blocked)</li>
        <li><code>4000 0000 0000 9995</code> — declines (insufficient funds)</li>
      </ul>
    </details>`,
  );
}

function renderOtpForm(tx: CheckoutRecord, errorMessage?: string) {
  const id = encodeURIComponent(tx.id);
  const remaining = Math.max(0, MAX_OTP_ATTEMPTS - tx.otpAttempts);
  const errorBanner = errorMessage ? `<div class="alert err" role="alert">${escapeHtml(errorMessage)}</div>` : "";
  return renderPage(
    `Verify OTP · ${tx.merchant.businessName}`,
    `<p class="eyebrow">FlutterPay OTP Verification</p>
    <h1>${escapeHtml(tx.merchant.businessName)}</h1>
    <div class="amount">${escapeHtml(formatNaira(tx.amountKobo))}</div>
    <p class="meta">Card ending in ${escapeHtml(tx.cardLast4 ?? "****")} · ${remaining} attempt${remaining === 1 ? "" : "s"} remaining</p>
    ${errorBanner}
    <form method="post" action="/pay/${id}/otp" autocomplete="off">
      <label for="otp">Enter 6-digit OTP (test OTP: 123456)</label>
      <input id="otp" name="otp" inputmode="numeric" placeholder="123456" required>
      <button type="submit">Confirm payment</button>
    </form>`,
  );
}

function renderFinalStatus(tx: CheckoutRecord) {
  const status = tx.status.toLowerCase();
  const isSuccess = tx.status === "SUCCESSFUL";
  const reason = tx.failureReason ? `<p class="meta">${escapeHtml(tx.failureReason)}</p>` : "";
  const callbackLink = tx.status === "SUCCESSFUL" || tx.status === "FAILED"
    ? `<a class="btn" href="${escapeHtml(buildRedirectUrl(tx.redirectUrl, tx))}">Return to merchant</a>`
    : "";
  return renderPage(
    `Payment ${status}`,
    `<p class="eyebrow">FlutterPay Test Checkout</p>
    <h1>${escapeHtml(tx.merchant.businessName)}</h1>
    <div class="amount">${escapeHtml(formatNaira(tx.amountKobo))}</div>
    <div class="alert ${isSuccess ? "ok" : "err"}">Payment status: <strong>${escapeHtml(status)}</strong></div>
    ${reason}
    <p class="meta">Ref: <code>${escapeHtml(tx.txRef)}</code></p>
    ${callbackLink}`,
  );
}

function renderNotFound() {
  return renderPage(
    "Payment not found",
    `<p class="eyebrow">FlutterPay</p>
    <h1>Payment not found</h1>
    <p class="meta">Check the checkout link and try again.</p>`,
  );
}

function sendTerminalResponse(req: Request, res: Response, tx: SelectedTransaction) {
  const redirect = buildRedirectUrl(tx.redirectUrl, tx);
  if (prefersJson(req)) {
    res.json({ transaction: serializeTransaction(tx), redirect_url: redirect });
    return;
  }
  res.redirect(303, redirect);
}

export function checkoutRoutes(
  db: PrismaClient,
  options?: {
    appBaseUrl?: string;
    now?: () => Date;
    webhookSender?: WebhookSender;
    autoDeliverWebhooks?: boolean;
    webhookTracker?: WebhookTracker;
  },
) {
  const router = Router();
  const baseUrl = normalizeBaseUrl(options?.appBaseUrl ?? "http://127.0.0.1:3000");
  const now = options?.now ?? (() => new Date());
  const autoDeliverWebhooks = options?.autoDeliverWebhooks ?? true;
  const webhookTracker = options?.webhookTracker ?? createWebhookTracker();
  const parsers = [urlencoded({ extended: false, limit: "8kb" }), json({ limit: "8kb" })];

  function dispatchWebhook(deliveryId: string | null) {
    if (deliveryId && autoDeliverWebhooks) {
      webhookTracker.track(
        deliverWebhookAttempt(db, deliveryId, { now, sender: options?.webhookSender }),
        `delivery=${deliveryId}`,
      );
    }
  }

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });

  router.get("/:id", async (req, res, next) => {
    const id = getParamId(req);
    try {
      await expireTransactionIfNeeded(db, id, now());
      const tx = await db.transaction.findUnique({ where: { id }, select: checkoutSelect });
      if (!tx) {
        if (prefersJson(req)) {
          res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found." } });
          return;
        }
        res.status(404).type("html").send(renderNotFound());
        return;
      }

      if (prefersJson(req)) {
        res.json({ merchant_name: tx.merchant.businessName, transaction: serializeTransaction(tx) });
        return;
      }

      if (tx.status === "PENDING") {
        res.type("html").send(renderCardForm(tx));
      } else if (tx.status === "AWAITING_OTP") {
        res.type("html").send(renderOtpForm(tx));
      } else {
        res.type("html").send(renderFinalStatus(tx));
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/charge", ...parsers, async (req, res, next) => {
    if (!req.is("application/x-www-form-urlencoded") && !req.is("application/json")) {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send form or JSON card details." } });
      return;
    }
    const id = getParamId(req);
    const currentTime = now();

    try {
      await expireTransactionIfNeeded(db, id, currentTime);
      const tx = await db.transaction.findUnique({ where: { id }, select: checkoutSelect });
      if (!tx) {
        if (prefersJson(req)) {
          res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found." } });
          return;
        }
        res.status(404).type("html").send(renderNotFound());
        return;
      }

      if (tx.status !== "PENDING") {
        if (prefersJson(req)) {
          res.status(409).json({
            error: { code: "INVALID_STATE", message: "This transaction can no longer be charged." },
            transaction: serializeTransaction(tx),
          });
          return;
        }
        res.redirect(303, `/pay/${encodeURIComponent(id)}`);
        return;
      }

      const parsedBody = chargeBodySchema.safeParse(req.body);
      const card = parsedBody.success
        ? validateCardInput(parsedBody.data, currentTime)
        : { ok: false as const, message: "Provide card_number, expiry (MM/YY) and 3-digit cvv." };

      if (!card.ok) {
        if (prefersJson(req)) {
          res.status(400).json({ error: { code: "INVALID_INPUT", message: card.message } });
          return;
        }
        res.status(400).type("html").send(renderCardForm(tx, card.message));
        return;
      }

      const decision = chargeCard(card.digits);
      const nextData =
        decision.outcome === "APPROVED"
          ? { status: "SUCCESSFUL" as const, cardLast4: card.last4, failureReason: null }
          : decision.outcome === "AWAITING_OTP"
            ? { status: "AWAITING_OTP" as const, cardLast4: card.last4, failureReason: null }
            : { status: "FAILED" as const, cardLast4: card.last4, failureReason: decision.reason };

      // Atomically transition from PENDING and enqueue the initial webhook delivery in one transaction.
      const outcome = await db.$transaction(async prisma => {
        const updated = await prisma.transaction.updateMany({
          where: { id, status: "PENDING", expiresAt: { gt: currentTime } },
          data: nextData,
        });
        if (updated.count === 0) return null;
        const finalTx = await prisma.transaction.findUniqueOrThrow({ where: { id }, select: transactionSelect });
        const delivery = finalTx.status === "SUCCESSFUL" || finalTx.status === "FAILED"
          ? await enqueueChargeCompletedWebhook(prisma, finalTx.id, currentTime)
          : null;
        return { finalTx, deliveryId: delivery?.id ?? null };
      });

      if (!outcome) {
        await expireTransactionIfNeeded(db, id, currentTime);
        const latest = await db.transaction.findUniqueOrThrow({ where: { id }, select: transactionSelect });
        if (prefersJson(req)) {
          res.status(409).json({
            error: { code: "INVALID_STATE", message: "This transaction can no longer be charged." },
            transaction: serializeTransaction(latest),
          });
          return;
        }
        res.redirect(303, `/pay/${encodeURIComponent(id)}`);
        return;
      }

      const { finalTx, deliveryId } = outcome;
      if (finalTx.status === "AWAITING_OTP") {
        if (prefersJson(req)) {
          res.json({
            transaction: serializeTransaction(finalTx),
            next_action: "otp",
            otp_url: `${baseUrl}/pay/${finalTx.id}/otp`,
          });
          return;
        }
        res.redirect(303, `/pay/${encodeURIComponent(id)}`);
        return;
      }

      dispatchWebhook(deliveryId);
      sendTerminalResponse(req, res, finalTx);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/otp", ...parsers, async (req, res, next) => {
    if (!req.is("application/x-www-form-urlencoded") && !req.is("application/json")) {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send form or JSON OTP data." } });
      return;
    }
    const id = getParamId(req);
    const currentTime = now();

    try {
      await expireTransactionIfNeeded(db, id, currentTime);
      const tx = await db.transaction.findUnique({ where: { id }, select: checkoutSelect });
      if (!tx) {
        if (prefersJson(req)) {
          res.status(404).json({ error: { code: "NOT_FOUND", message: "Payment not found." } });
          return;
        }
        res.status(404).type("html").send(renderNotFound());
        return;
      }

      if (tx.status !== "AWAITING_OTP") {
        if (prefersJson(req)) {
          res.status(409).json({
            error: { code: "INVALID_STATE", message: "This transaction is not awaiting OTP verification." },
            transaction: serializeTransaction(tx),
          });
          return;
        }
        res.redirect(303, `/pay/${encodeURIComponent(id)}`);
        return;
      }

      const parsedBody = otpBodySchema.safeParse(req.body);
      const otp = parsedBody.success ? parseOtpInput(parsedBody.data.otp) : null;
      if (!otp) {
        const message = "Enter a 6-digit OTP.";
        if (prefersJson(req)) {
          res.status(400).json({ error: { code: "INVALID_INPUT", message } });
          return;
        }
        res.status(400).type("html").send(renderOtpForm(tx, message));
        return;
      }

      if (verifyOtp(otp)) {
        const outcome = await db.$transaction(async prisma => {
          const updated = await prisma.transaction.updateMany({
            where: { id, status: "AWAITING_OTP", expiresAt: { gt: currentTime } },
            data: { status: "SUCCESSFUL", failureReason: null },
          });
          if (updated.count === 0) return null;
          const finalTx = await prisma.transaction.findUniqueOrThrow({ where: { id }, select: transactionSelect });
          const delivery = await enqueueChargeCompletedWebhook(prisma, finalTx.id, currentTime);
          return { finalTx, deliveryId: delivery?.id ?? null };
        });
        if (!outcome) {
          await expireTransactionIfNeeded(db, id, currentTime);
          const latest = await db.transaction.findUniqueOrThrow({ where: { id }, select: transactionSelect });
          if (prefersJson(req)) {
            res.status(409).json({
              error: { code: "INVALID_STATE", message: "This transaction is not awaiting OTP verification." },
              transaction: serializeTransaction(latest),
            });
            return;
          }
          res.redirect(303, `/pay/${encodeURIComponent(id)}`);
          return;
        }
        dispatchWebhook(outcome.deliveryId);
        sendTerminalResponse(req, res, outcome.finalTx);
        return;
      }

      // Atomically increment attempts, fail on the 3rd invalid OTP and enqueue the failure webhook together.
      const nextOutcome = await db.$transaction(async prisma => {
        const incremented = await prisma.transaction.updateMany({
          where: { id, status: "AWAITING_OTP", expiresAt: { gt: currentTime }, otpAttempts: { lt: MAX_OTP_ATTEMPTS } },
          data: { otpAttempts: { increment: 1 } },
        });
        if (incremented.count === 0) return null;
        const current = await prisma.transaction.findUniqueOrThrow({ where: { id }, select: checkoutSelect });
        if (current.otpAttempts >= MAX_OTP_ATTEMPTS) {
          const failedRecord = await prisma.transaction.update({
            where: { id },
            data: { status: "FAILED", failureReason: "Too many invalid OTP attempts" },
            select: checkoutSelect,
          });
          const delivery = await enqueueChargeCompletedWebhook(prisma, failedRecord.id, currentTime);
          return { record: failedRecord, deliveryId: delivery?.id ?? null };
        }
        return { record: current, deliveryId: null };
      });

      if (!nextOutcome) {
        await expireTransactionIfNeeded(db, id, currentTime);
        const latest = await db.transaction.findUniqueOrThrow({ where: { id }, select: transactionSelect });
        if (prefersJson(req)) {
          res.status(409).json({
            error: { code: "INVALID_STATE", message: "This transaction is not awaiting OTP verification." },
            transaction: serializeTransaction(latest),
          });
          return;
        }
        res.redirect(303, `/pay/${encodeURIComponent(id)}`);
        return;
      }

      const { record: nextRecord, deliveryId } = nextOutcome;
      if (nextRecord.status === "FAILED") {
        dispatchWebhook(deliveryId);
        sendTerminalResponse(req, res, nextRecord);
        return;
      }

      const remaining = MAX_OTP_ATTEMPTS - nextRecord.otpAttempts;
      const message = `Incorrect OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
      if (prefersJson(req)) {
        res.status(400).json({
          error: { code: "INVALID_OTP", message },
          remaining_attempts: remaining,
          transaction: serializeTransaction(nextRecord),
        });
        return;
      }
      res.status(400).type("html").send(renderOtpForm(nextRecord, message));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

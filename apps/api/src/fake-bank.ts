export const MAX_OTP_ATTEMPTS = 3;
export const TEST_OTP = "123456";

export const TEST_CARDS = {
  APPROVE: "4242424242424242",
  OTP: "5060990000000001",
  DECLINE_BLOCKED: "4000000000000002",
  DECLINE_INSUFFICIENT_FUNDS: "4000000000009995",
} as const;

export type CardValidationResult =
  | { ok: true; digits: string; last4: string }
  | { ok: false; message: string };

export type BankDecision =
  | { outcome: "APPROVED" }
  | { outcome: "AWAITING_OTP" }
  | { outcome: "DECLINED"; reason: string };

export function validateCardInput(
  input: { card_number?: unknown; expiry?: unknown; cvv?: unknown },
  now: Date = new Date(),
): CardValidationResult {
  if (typeof input.card_number !== "string" || typeof input.expiry !== "string" || typeof input.cvv !== "string") {
    return { ok: false, message: "Provide card_number, expiry (MM/YY) and 3-digit cvv." };
  }

  const digits = input.card_number.replace(/[\s-]+/g, "");
  if (!/^\d{16}$/.test(digits)) {
    return { ok: false, message: "Card number must be 16 digits." };
  }

  const expiryMatch = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/.exec(input.expiry.trim());
  if (!expiryMatch) {
    return { ok: false, message: "Expiry date must use MM/YY format." };
  }
  const expMonth = Number(expiryMatch[1]);
  const rawYear = expiryMatch[2]!;
  const expYear = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  if (expYear < currentYear || (expYear === currentYear && expMonth < currentMonth)) {
    return { ok: false, message: "Card has expired." };
  }

  const cvv = input.cvv.trim();
  if (!/^\d{3}$/.test(cvv)) {
    return { ok: false, message: "CVV must be 3 digits." };
  }

  return { ok: true, digits, last4: digits.slice(-4) };
}

export function chargeCard(digits: string): BankDecision {
  switch (digits) {
    case TEST_CARDS.APPROVE:
      return { outcome: "APPROVED" };
    case TEST_CARDS.OTP:
      return { outcome: "AWAITING_OTP" };
    case TEST_CARDS.DECLINE_BLOCKED:
      return { outcome: "DECLINED", reason: "Card blocked" };
    case TEST_CARDS.DECLINE_INSUFFICIENT_FUNDS:
      return { outcome: "DECLINED", reason: "Insufficient funds" };
    default:
      return { outcome: "DECLINED", reason: "Unsupported test card" };
  }
}

export function parseOtpInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

export function verifyOtp(otp: string): boolean {
  return otp === TEST_OTP;
}

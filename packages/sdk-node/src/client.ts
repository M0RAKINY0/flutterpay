import {
  FlutterPayApiError,
  FlutterPayAuthenticationError,
  FlutterPayConfigError,
  FlutterPayConflictError,
  FlutterPayError,
  FlutterPayNetworkError,
  FlutterPayNotFoundError,
  FlutterPayRateLimitError,
  FlutterPayValidationError,
} from "./errors.js";
import type {
  ChargeCompletedEvent,
  CreatePaymentInput,
  CreatePaymentResult,
  FlutterPayClientOptions,
  ListTransactionsParams,
  ListTransactionsResult,
  ListWebhookDeliveriesParams,
  ListWebhookDeliveriesResult,
  RequestOptions,
  VerifyTransactionResult,
  VerifyWebhookOptions,
  VerifyWebhookSignatureResult,
} from "./types.js";
import { verifyWebhookEvent, verifyWebhookSignature } from "./webhooks.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SDK_USER_AGENT = "@flutterpay/sdk-node/0.1.0";

function normalizeBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FlutterPayConfigError("baseUrl must be a valid http:// or https:// URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new FlutterPayConfigError("baseUrl must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new FlutterPayConfigError("baseUrl must not include embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new FlutterPayConfigError("baseUrl must not include a query string or hash.");
  }
  return trimmed.replace(/\/+$/, "");
}

function validateSecretKey(secretKey: string): string {
  if (typeof secretKey !== "string" || secretKey.length === 0 || !/^[^\x00-\x1f\x7f\s]+$/.test(secretKey)) {
    throw new FlutterPayConfigError("secretKey must be a non-empty string without whitespace or control characters.");
  }
  return secretKey;
}

function validateTimeoutMs(timeoutMs: number): number {
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new FlutterPayConfigError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function parseApiErrorBody(rawBody: string): { code: string | null; message: string | null } {
  if (!rawBody) return { code: null, message: null };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "object" && err !== null) {
        const code = "code" in err && typeof err.code === "string" ? err.code : null;
        const message = "message" in err && typeof err.message === "string" ? err.message : null;
        return { code, message };
      }
    }
  } catch {
    // Non-JSON response body; fall back to HTTP status details.
  }
  return { code: null, message: null };
}

function createApiError(response: Response, rawBody: string): FlutterPayApiError {
  const parsed = parseApiErrorBody(rawBody);
  const status = response.status;
  const code = parsed.code ?? `HTTP_${status}`;
  const message = parsed.message ?? (response.statusText || `FlutterPay API request failed with HTTP ${status}.`);

  switch (status) {
    case 400:
      return new FlutterPayValidationError({ status, code, message });
    case 401:
      return new FlutterPayAuthenticationError({ status, code, message });
    case 404:
      return new FlutterPayNotFoundError({ status, code, message });
    case 409:
      return new FlutterPayConflictError({ status, code, message });
    case 429:
      return new FlutterPayRateLimitError({
        status,
        code,
        message,
        retryAfter: response.headers.get("retry-after"),
      });
    default:
      return new FlutterPayApiError({ status, code, message });
  }
}

export class FlutterPay {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly payments: {
    create: (input: CreatePaymentInput, options?: RequestOptions) => Promise<CreatePaymentResult>;
  };
  readonly transactions: {
    verify: (transactionId: string, options?: RequestOptions) => Promise<VerifyTransactionResult>;
    list: (params?: ListTransactionsParams, options?: RequestOptions) => Promise<ListTransactionsResult>;
  };
  readonly webhooks: {
    verify: (options: VerifyWebhookOptions) => ChargeCompletedEvent;
    verifySignature: (options: VerifyWebhookOptions) => VerifyWebhookSignatureResult;
    listDeliveries: (
      params?: ListWebhookDeliveriesParams,
      options?: RequestOptions,
    ) => Promise<ListWebhookDeliveriesResult>;
  };

  readonly #secretKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FlutterPayClientOptions) {
    if (!options || typeof options !== "object") {
      throw new FlutterPayConfigError("FlutterPay client options are required.");
    }
    this.#secretKey = validateSecretKey(options.secretKey);
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = validateTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#fetch = options.fetch ?? globalThis.fetch;

    if (typeof this.#fetch !== "function") {
      throw new FlutterPayConfigError("A fetch implementation is required.");
    }

    this.payments = {
      create: (input, reqOptions) => this.#request<CreatePaymentResult>("POST", "/v1/payments", { body: input, ...reqOptions }),
    };

    this.transactions = {
      verify: (transactionId, reqOptions) => {
        if (typeof transactionId !== "string") {
          throw new FlutterPayError("transactionId must be a non-empty string.");
        }
        const trimmed = transactionId.trim();
        if (trimmed.length === 0 || /[/?#\\]/.test(trimmed)) {
          throw new FlutterPayError("transactionId must be a non-empty string without path separators.");
        }
        return this.#request<VerifyTransactionResult>(
          "GET",
          `/v1/transactions/${encodeURIComponent(trimmed)}/verify`,
          reqOptions,
        );
      },
      list: (params, reqOptions) => {
        const search = new URLSearchParams();
        if (params?.period !== undefined) search.set("period", params.period);
        if (params?.date !== undefined) search.set("date", params.date);
        if (params?.page !== undefined) search.set("page", String(params.page));
        if (params?.limit !== undefined) search.set("limit", String(params.limit));
        const qs = search.toString();
        return this.#request<ListTransactionsResult>(
          "GET",
          qs ? `/v1/transactions?${qs}` : "/v1/transactions",
          reqOptions,
        );
      },
    };

    this.webhooks = {
      verify: verifyWebhookEvent,
      verifySignature: verifyWebhookSignature,
      listDeliveries: (params, reqOptions) => {
        const search = new URLSearchParams();
        if (params?.transaction_id !== undefined) search.set("transaction_id", params.transaction_id);
        if (params?.page !== undefined) search.set("page", String(params.page));
        if (params?.limit !== undefined) search.set("limit", String(params.limit));
        const qs = search.toString();
        return this.#request<ListWebhookDeliveriesResult>(
          "GET",
          qs ? `/v1/webhooks/deliveries?${qs}` : "/v1/webhooks/deliveries",
          reqOptions,
        );
      },
    };
  }

  async #request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options?: RequestOptions & { body?: unknown },
  ): Promise<T> {
    const effectiveTimeoutMs =
      options?.timeoutMs !== undefined ? validateTimeoutMs(options.timeoutMs) : this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      Accept: "application/json",
      "User-Agent": SDK_USER_AGENT,
    };

    let body: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      const isTimeout =
        timeoutSignal.aborted ||
        (error instanceof Error && error.name === "TimeoutError");
      throw new FlutterPayNetworkError(
        isTimeout
          ? `FlutterPay API request timed out after ${effectiveTimeoutMs}ms.`
          : "Could not reach the FlutterPay API.",
        { isTimeout, cause: error },
      );
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      const isTimeout =
        timeoutSignal.aborted ||
        (error instanceof Error && error.name === "TimeoutError");
      throw new FlutterPayNetworkError(
        isTimeout
          ? `FlutterPay API response timed out after ${effectiveTimeoutMs}ms.`
          : "Failed to read the FlutterPay API response.",
        { isTimeout, cause: error },
      );
    }

    if (!response.ok) {
      throw createApiError(response, rawBody);
    }

    try {
      return JSON.parse(rawBody) as T;
    } catch (error) {
      throw new FlutterPayApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "FlutterPay API returned a non-JSON response.",
        cause: error,
      });
    }
  }
}

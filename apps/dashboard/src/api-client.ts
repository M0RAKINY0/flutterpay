export const SESSION_COOKIE_NAME = "fp_session";
const API_TIMEOUT_MS = 10_000;

export interface ApiMerchant {
  id: string;
  business_name: string;
  email: string;
}

export interface ApiSessionInfo {
  session: {
    id: string;
    expires_at: string;
    csrf_token: string;
  };
  merchant: ApiMerchant;
}

export interface ApiKeySummary {
  id: string;
  kind: "public" | "secret";
  prefix: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

export interface RotatedKeyResponse {
  key: {
    id: string;
    kind: "public" | "secret";
    prefix: string;
    value: string;
    created_at: string;
  };
  revoked_count: number;
}

export interface ApiTransaction {
  id: string;
  tx_ref: string;
  amount_kobo: number;
  currency: string;
  status: string;
  customer_email: string;
  card_last4: string | null;
  failure_reason: string | null;
  redirect_url: string;
  expires_at: string;
  created_at: string;
}

export interface ApiPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

export interface ApiTransactionsResponse {
  transactions: ApiTransaction[];
  period: {
    type: string;
    date: string | null;
    from: string | null;
    to: string | null;
  };
  pagination: ApiPagination;
}

export interface ApiWebhookConfig {
  url: string | null;
  secret_configured: boolean;
  secret?: string | null;
}

export interface ApiWebhookDelivery {
  id: string;
  event_id: string;
  transaction_id: string;
  event: string;
  target_url: string;
  attempt: number;
  status: string;
  response_code: number | null;
  error_message: string | null;
  next_retry_at: string | null;
  attempted_at: string | null;
  created_at: string;
}

export interface ApiDeliveriesResponse {
  deliveries: ApiWebhookDelivery[];
  pagination: ApiPagination;
}

export interface ApiCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorCode: string | null;
  errorMessage: string | null;
  setCookies: string[];
}

export class UpstreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamUnavailableError";
  }
}

export function normalizeApiBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const parsed = new URL(trimmed);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("API_BASE_URL must be an http:// or https:// URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("API_BASE_URL must not include embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("API_BASE_URL must not include a query string or hash.");
  }
  return trimmed.replace(/\/+$/, "");
}

export function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE_NAME) {
      return /^[a-f0-9]{64}$/i.test(value) ? value : null;
    }
  }
  return null;
}

export function buildClearDashboardCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function filterSessionSetCookies(cookies: string[]): string[] {
  return cookies.filter(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
}

export function createApiClient(
  apiBaseUrl: string,
  options?: { fetch?: typeof globalThis.fetch; proxySecret?: string },
) {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const proxySecret = options?.proxySecret?.trim() || undefined;

  async function request<T>(options: {
    method: "GET" | "POST" | "PUT";
    path: string;
    sessionToken?: string | null;
    csrfToken?: string;
    clientIp?: string;
    body?: unknown;
  }): Promise<ApiCallResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (options.sessionToken) {
      headers.Cookie = `${SESSION_COOKIE_NAME}=${options.sessionToken}`;
    }
    if (options.csrfToken) {
      headers["X-CSRF-Token"] = options.csrfToken;
    }
    if (proxySecret && options.clientIp) {
      headers["X-FlutterPay-Proxy-Secret"] = proxySecret;
      headers["X-FlutterPay-Client-IP"] = options.clientIp;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${options.path}`, {
        method: options.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamUnavailableError("Could not reach the FlutterPay API.", { cause: error });
    }

    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? filterSessionSetCookies(response.headers.getSetCookie())
        : [];

    let rawText = "";
    try {
      rawText = await response.text();
    } catch (error) {
      throw new UpstreamUnavailableError("Failed reading response from the FlutterPay API.", { cause: error });
    }

    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        data: parsed as T | null,
        errorCode: null,
        errorMessage: null,
        setCookies,
      };
    }

    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "object" && err !== null) {
        if ("code" in err && typeof err.code === "string") errorCode = err.code;
        if ("message" in err && typeof err.message === "string") errorMessage = err.message;
      }
    }

    return {
      ok: false,
      status: response.status,
      data: null,
      errorCode,
      errorMessage: errorMessage ?? `Request failed (HTTP ${response.status}).`,
      setCookies,
    };
  }

  return {
    baseUrl,
    signup(input: { business_name: string; email: string; password: string }, clientIp?: string) {
      return request<{ merchant: ApiMerchant; keys: { public_key: string; secret_key: string } }>({
        method: "POST",
        path: "/v1/merchants",
        clientIp,
        body: input,
      });
    },
    login(input: { email: string; password: string }, clientIp?: string) {
      return request<ApiSessionInfo>({
        method: "POST",
        path: "/v1/sessions",
        clientIp,
        body: input,
      });
    },
    getSession(sessionToken: string) {
      return request<ApiSessionInfo>({
        method: "GET",
        path: "/v1/sessions/me",
        sessionToken,
      });
    },
    logout(sessionToken: string, csrfToken: string) {
      return request<{ ok: boolean }>({
        method: "POST",
        path: "/v1/sessions/logout",
        sessionToken,
        csrfToken,
      });
    },
    listTransactions(sessionToken: string, params: { period?: string; date?: string; page?: number; limit?: number }) {
      const search = new URLSearchParams();
      if (params.period) search.set("period", params.period);
      if (params.date) search.set("date", params.date);
      if (params.page) search.set("page", String(params.page));
      if (params.limit) search.set("limit", String(params.limit));
      const qs = search.toString();
      return request<ApiTransactionsResponse>({
        method: "GET",
        path: qs ? `/v1/transactions?${qs}` : "/v1/transactions",
        sessionToken,
      });
    },
    getWebhook(sessionToken: string) {
      return request<{ webhook: ApiWebhookConfig }>({
        method: "GET",
        path: "/v1/merchants/me/webhook",
        sessionToken,
      });
    },
    updateWebhook(
      sessionToken: string,
      csrfToken: string,
      input: { webhook_url: string | null; rotate_secret?: boolean },
    ) {
      return request<{ webhook: ApiWebhookConfig }>({
        method: "PUT",
        path: "/v1/merchants/me/webhook",
        sessionToken,
        csrfToken,
        body: input,
      });
    },
    listDeliveries(sessionToken: string, params: { transaction_id?: string; page?: number; limit?: number }) {
      const search = new URLSearchParams();
      if (params.transaction_id) search.set("transaction_id", params.transaction_id);
      if (params.page) search.set("page", String(params.page));
      if (params.limit) search.set("limit", String(params.limit));
      const qs = search.toString();
      return request<ApiDeliveriesResponse>({
        method: "GET",
        path: qs ? `/v1/webhooks/deliveries?${qs}` : "/v1/webhooks/deliveries",
        sessionToken,
      });
    },
    listKeys(sessionToken: string) {
      return request<{ keys: ApiKeySummary[] }>({
        method: "GET",
        path: "/v1/merchants/me/keys",
        sessionToken,
      });
    },
    rotateKey(sessionToken: string, csrfToken: string, kind: "secret" | "public") {
      return request<RotatedKeyResponse>({
        method: "POST",
        path: "/v1/merchants/me/keys/rotate",
        sessionToken,
        csrfToken,
        body: { kind },
      });
    },
  };
}

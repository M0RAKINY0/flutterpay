import express, { urlencoded, type ErrorRequestHandler, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  buildClearDashboardCookie,
  createApiClient,
  extractSessionToken,
  UpstreamUnavailableError,
  type ApiPagination,
  type ApiSessionInfo,
} from "./api-client.js";
import {
  renderErrorPage,
  renderKeysPage,
  renderLoginPage,
  renderSignupPage,
  renderTransactionsPage,
  renderWebhooksPage,
} from "./views.js";

export type DashboardAppOptions = {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  proxySecret?: string;
};

const VALID_PERIODS = new Set(["all", "daily", "weekly", "monthly"]);

const EMPTY_PAGINATION: ApiPagination = {
  page: 1,
  limit: 20,
  total: 0,
  total_pages: 0,
  has_next: false,
  has_previous: false,
};

function readStringField(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readPositiveIntQuery(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : fallback;
}

function isSameOriginPost(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true;
  const host = req.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function forwardSetCookies(res: Response, cookies: string[]) {
  if (cookies.length > 0) {
    res.setHeader("Set-Cookie", cookies);
  }
}

function redirectToLogin(req: Request, res: Response, clearCookie: boolean) {
  if (clearCookie) {
    res.setHeader("Set-Cookie", buildClearDashboardCookie(req.secure));
  }
  res.redirect(303, "/login");
}

export function createDashboardApp(options?: DashboardAppOptions) {
  const app = express();
  const api = createApiClient(options?.apiBaseUrl ?? "http://127.0.0.1:3000", {
    fetch: options?.fetch,
    proxySecret: options?.proxySecret,
  });

  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const formParser = urlencoded({ extended: false, limit: "8kb" });

  const loginRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res
        .status(429)
        .type("html")
        .send(renderLoginPage({ error: "Too many login attempts. Please wait a minute and try again." }));
    },
  });

  const signupRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res
        .status(429)
        .type("html")
        .send(renderSignupPage({ error: "Too many signup attempts. Please wait a minute and try again." }));
    },
  });

  async function requireSession(
    req: Request,
    res: Response,
  ): Promise<{ token: string; info: ApiSessionInfo } | null> {
    const token = extractSessionToken(req.get("cookie"));
    if (!token) {
      redirectToLogin(req, res, Boolean(req.get("cookie")?.includes("fp_session=")));
      return null;
    }
    const sessionRes = await api.getSession(token);
    if (sessionRes.status === 401) {
      redirectToLogin(req, res, true);
      return null;
    }
    if (!sessionRes.ok || !sessionRes.data) {
      res
        .status(502)
        .type("html")
        .send(renderErrorPage("API Error", "Could not verify your session with the FlutterPay API. Please try again."));
      return null;
    }
    return { token, info: sessionRes.data };
  }

  async function renderTransactionsView(
    req: Request,
    res: Response,
    token: string,
    info: ApiSessionInfo,
    newAccountKeys?: { public_key: string; secret_key: string },
  ) {
    const rawPeriod = typeof req.query.period === "string" ? req.query.period : "all";
    const period = VALID_PERIODS.has(rawPeriod) ? rawPeriod : "all";
    const page = readPositiveIntQuery(req.query.page, 1, 10_000);

    try {
      const [txRes, keysRes, webhookRes] = await Promise.all([
        api.listTransactions(token, { period, page, limit: 20 }),
        api.listKeys(token),
        api.getWebhook(token),
      ]);

      if (!newAccountKeys && (txRes.status === 401 || keysRes.status === 401 || webhookRes.status === 401)) {
        redirectToLogin(req, res, true);
        return;
      }

      if (!txRes.ok || !txRes.data || !keysRes.ok || !keysRes.data || !webhookRes.ok || !webhookRes.data) {
        if (newAccountKeys) {
          res
            .status(201)
            .type("html")
            .send(
              renderTransactionsPage({
                merchant: info.merchant,
                csrfToken: info.session.csrf_token,
                transactions: [],
                period,
                pagination: EMPTY_PAGINATION,
                activeSecretPrefix: newAccountKeys.secret_key.slice(0, 20),
                webhookUrl: null,
                newAccountKeys,
                warning:
                  "Your merchant account was created, but dashboard data could not be loaded right now. Save your API keys above before refreshing.",
              }),
            );
          return;
        }
        res.status(502).type("html").send(renderErrorPage("API Error", "Could not load dashboard data from the API."));
        return;
      }

      const activeSecret = keysRes.data.keys.find(k => k.kind === "secret" && k.active);
      res
        .status(newAccountKeys ? 201 : 200)
        .type("html")
        .send(
          renderTransactionsPage({
            merchant: info.merchant,
            csrfToken: info.session.csrf_token,
            transactions: txRes.data.transactions,
            period,
            pagination: txRes.data.pagination,
            activeSecretPrefix: activeSecret?.prefix ?? null,
            webhookUrl: webhookRes.data.webhook.url,
            newAccountKeys,
          }),
        );
    } catch (error) {
      if (newAccountKeys) {
        res
          .status(201)
          .type("html")
          .send(
            renderTransactionsPage({
              merchant: info.merchant,
              csrfToken: info.session.csrf_token,
              transactions: [],
              period,
              pagination: EMPTY_PAGINATION,
              activeSecretPrefix: newAccountKeys.secret_key.slice(0, 20),
              webhookUrl: null,
              newAccountKeys,
              warning:
                "Your merchant account was created, but dashboard data could not be loaded right now. Save your API keys above before refreshing.",
            }),
          );
        return;
      }
      throw error;
    }
  }

  app.get("/login", async (req, res, next) => {
    try {
      const token = extractSessionToken(req.get("cookie"));
      if (token) {
        const existing = await api.getSession(token);
        if (existing.ok && existing.data) {
          res.redirect(303, "/transactions");
          return;
        }
      }
      res
        .type("html")
        .send(renderLoginPage({ loggedOut: req.query.logged_out === "1" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/login", loginRateLimit, formParser, async (req, res, next) => {
    try {
      if (!isSameOriginPost(req)) {
        res.status(403).type("html").send(renderErrorPage("Forbidden", "Cross-origin form submission rejected."));
        return;
      }

      const email = readStringField(req.body, "email").trim();
      const password = readStringField(req.body, "password");
      if (!email || !password) {
        res.status(400).type("html").send(renderLoginPage({ email, error: "Enter both your email and password." }));
        return;
      }

      const loginRes = await api.login({ email, password }, req.ip);
      if (!loginRes.ok || !loginRes.data) {
        const status = loginRes.status === 429 ? 429 : loginRes.status >= 500 ? 502 : 401;
        res
          .status(status)
          .type("html")
          .send(renderLoginPage({ email, error: loginRes.errorMessage ?? "Invalid email or password." }));
        return;
      }

      forwardSetCookies(res, loginRes.setCookies);
      res.redirect(303, "/transactions");
    } catch (error) {
      next(error);
    }
  });

  app.get("/signup", async (req, res, next) => {
    try {
      const token = extractSessionToken(req.get("cookie"));
      if (token) {
        const existing = await api.getSession(token);
        if (existing.ok && existing.data) {
          res.redirect(303, "/transactions");
          return;
        }
      }
      res.type("html").send(renderSignupPage());
    } catch (error) {
      next(error);
    }
  });

  app.post("/signup", signupRateLimit, formParser, async (req, res, next) => {
    try {
      if (!isSameOriginPost(req)) {
        res.status(403).type("html").send(renderErrorPage("Forbidden", "Cross-origin form submission rejected."));
        return;
      }

      const businessName = readStringField(req.body, "business_name").trim();
      const email = readStringField(req.body, "email").trim();
      const password = readStringField(req.body, "password");

      const signupRes = await api.signup(
        {
          business_name: businessName,
          email,
          password,
        },
        req.ip,
      );

      if (!signupRes.ok || !signupRes.data) {
        res
          .status(signupRes.status >= 400 && signupRes.status < 500 ? signupRes.status : 502)
          .type("html")
          .send(
            renderSignupPage({
              businessName,
              email,
              error: signupRes.errorMessage ?? "Could not create merchant account.",
            }),
          );
        return;
      }

      let loginRes;
      try {
        loginRes = await api.login({ email, password }, req.ip);
      } catch {
        res
          .status(201)
          .type("html")
          .send(
            renderLoginPage({
              email,
              error: "Account created, but automatic login could not reach the API. Save your API keys below and log in.",
              newAccountKeys: signupRes.data.keys,
            }),
          );
        return;
      }

      if (!loginRes.ok || !loginRes.data) {
        res
          .status(201)
          .type("html")
          .send(
            renderLoginPage({
              email,
              error: "Account created, but automatic login failed. Save your API keys below and log in.",
              newAccountKeys: signupRes.data.keys,
            }),
          );
        return;
      }

      forwardSetCookies(res, loginRes.setCookies);
      const token = extractSessionToken(loginRes.setCookies.join("; "));
      if (!token) {
        res
          .status(201)
          .type("html")
          .send(
            renderLoginPage({
              email,
              error: "Account created, but no session cookie was returned. Save your API keys below and log in.",
              newAccountKeys: signupRes.data.keys,
            }),
          );
        return;
      }

      await renderTransactionsView(req, res, token, loginRes.data, signupRes.data.keys);
    } catch (error) {
      next(error);
    }
  });

  app.post("/logout", formParser, async (req, res, next) => {
    try {
      if (!isSameOriginPost(req)) {
        res.status(403).type("html").send(renderErrorPage("Forbidden", "Cross-origin form submission rejected."));
        return;
      }

      const token = extractSessionToken(req.get("cookie"));
      const csrfToken = readStringField(req.body, "_csrf");
      if (!token) {
        redirectToLogin(req, res, false);
        return;
      }

      const logoutRes = await api.logout(token, csrfToken);
      if (logoutRes.status === 403) {
        res.status(403).type("html").send(renderErrorPage("Invalid CSRF token", "Please refresh the page and try logging out again."));
        return;
      }

      if (!logoutRes.ok && logoutRes.status !== 401) {
        res
          .status(502)
          .type("html")
          .send(
            renderErrorPage(
              "Logout failed",
              "Could not revoke your session because the FlutterPay API returned an error. Your session may still be active; please try again.",
            ),
          );
        return;
      }

      if (logoutRes.setCookies.length > 0) {
        forwardSetCookies(res, logoutRes.setCookies);
      } else {
        res.setHeader("Set-Cookie", buildClearDashboardCookie(req.secure));
      }
      res.redirect(303, "/login?logged_out=1");
    } catch (error) {
      next(error);
    }
  });

  app.get("/", async (req, res, next) => {
    try {
      const auth = await requireSession(req, res);
      if (!auth) return;
      await renderTransactionsView(req, res, auth.token, auth.info);
    } catch (error) {
      next(error);
    }
  });

  app.get("/transactions", async (req, res, next) => {
    try {
      const auth = await requireSession(req, res);
      if (!auth) return;
      await renderTransactionsView(req, res, auth.token, auth.info);
    } catch (error) {
      next(error);
    }
  });

  app.get("/webhooks", async (req, res, next) => {
    try {
      const auth = await requireSession(req, res);
      if (!auth) return;

      const page = readPositiveIntQuery(req.query.page, 1, 10_000);
      const rawTxId = typeof req.query.transaction_id === "string" ? req.query.transaction_id.trim() : "";
      const transactionId = rawTxId.length > 0 && rawTxId.length <= 100 ? rawTxId : undefined;

      const [webhookRes, deliveriesRes] = await Promise.all([
        api.getWebhook(auth.token),
        api.listDeliveries(auth.token, { transaction_id: transactionId, page, limit: 20 }),
      ]);

      if (webhookRes.status === 401 || deliveriesRes.status === 401) {
        redirectToLogin(req, res, true);
        return;
      }
      if (!webhookRes.ok || !webhookRes.data || !deliveriesRes.ok || !deliveriesRes.data) {
        res.status(502).type("html").send(renderErrorPage("API Error", "Could not load webhook data from the API."));
        return;
      }

      res.type("html").send(
        renderWebhooksPage({
          merchant: auth.info.merchant,
          csrfToken: auth.info.session.csrf_token,
          webhook: webhookRes.data.webhook,
          deliveries: deliveriesRes.data.deliveries,
          pagination: deliveriesRes.data.pagination,
          transactionIdFilter: transactionId,
          saved: req.query.saved === "1",
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/webhooks", formParser, async (req, res, next) => {
    try {
      if (!isSameOriginPost(req)) {
        res.status(403).type("html").send(renderErrorPage("Forbidden", "Cross-origin form submission rejected."));
        return;
      }

      const auth = await requireSession(req, res);
      if (!auth) return;

      const csrfToken = readStringField(req.body, "_csrf");
      const action = readStringField(req.body, "action");
      const rawUrl = readStringField(req.body, "webhook_url").trim();
      const rotateSecret = readStringField(req.body, "rotate_secret") === "1";

      const payload =
        action === "disable" || rawUrl === ""
          ? { webhook_url: null }
          : { webhook_url: rawUrl, ...(rotateSecret ? { rotate_secret: true } : {}) };

      const updateRes = await api.updateWebhook(auth.token, csrfToken, payload);
      if (updateRes.status === 401) {
        redirectToLogin(req, res, true);
        return;
      }
      if (updateRes.status === 403) {
        res.status(403).type("html").send(renderErrorPage("Invalid CSRF token", "Please refresh the page and submit the form again."));
        return;
      }

      if (!updateRes.ok || !updateRes.data) {
        if (updateRes.status >= 500) {
          res.status(502).type("html").send(renderErrorPage("API Error", "Could not update webhook settings right now."));
          return;
        }
        const [webhookRes, deliveriesRes] = await Promise.all([
          api.getWebhook(auth.token),
          api.listDeliveries(auth.token, { page: 1, limit: 20 }),
        ]);
        if (!webhookRes.ok || !webhookRes.data || !deliveriesRes.ok || !deliveriesRes.data) {
          res.status(502).type("html").send(renderErrorPage("API Error", "Could not reload webhook page."));
          return;
        }
        res.status(400).type("html").send(
          renderWebhooksPage({
            merchant: auth.info.merchant,
            csrfToken: auth.info.session.csrf_token,
            webhook: webhookRes.data.webhook,
            deliveries: deliveriesRes.data.deliveries,
            pagination: deliveriesRes.data.pagination,
            error: updateRes.errorMessage ?? "Invalid webhook URL.",
            submittedUrl: rawUrl,
          }),
        );
        return;
      }

      const issuedSecret = updateRes.data.webhook.secret;
      if (issuedSecret) {
        let deliveries = [] as NonNullable<Awaited<ReturnType<typeof api.listDeliveries>>["data"]>["deliveries"];
        let pagination = EMPTY_PAGINATION;
        let warning: string | undefined;

        try {
          const deliveriesRes = await api.listDeliveries(auth.token, { page: 1, limit: 20 });
          if (deliveriesRes.ok && deliveriesRes.data) {
            deliveries = deliveriesRes.data.deliveries;
            pagination = deliveriesRes.data.pagination;
          } else {
            warning =
              "Webhook settings were saved, but delivery history could not be loaded right now. Save your signing secret above before refreshing.";
          }
        } catch {
          warning =
            "Webhook settings were saved, but delivery history could not be loaded right now. Save your signing secret above before refreshing.";
        }

        res.type("html").send(
          renderWebhooksPage({
            merchant: auth.info.merchant,
            csrfToken: auth.info.session.csrf_token,
            webhook: updateRes.data.webhook,
            deliveries,
            pagination,
            newWebhookSecret: issuedSecret,
            warning,
          }),
        );
        return;
      }

      res.redirect(303, "/webhooks?saved=1");
    } catch (error) {
      next(error);
    }
  });

  app.get("/keys", async (req, res, next) => {
    try {
      const auth = await requireSession(req, res);
      if (!auth) return;

      const keysRes = await api.listKeys(auth.token);
      if (keysRes.status === 401) {
        redirectToLogin(req, res, true);
        return;
      }
      if (!keysRes.ok || !keysRes.data) {
        res.status(502).type("html").send(renderErrorPage("API Error", "Could not load API keys from the API."));
        return;
      }

      res.type("html").send(
        renderKeysPage({
          merchant: auth.info.merchant,
          csrfToken: auth.info.session.csrf_token,
          keys: keysRes.data.keys,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/keys/rotate", formParser, async (req, res, next) => {
    try {
      if (!isSameOriginPost(req)) {
        res.status(403).type("html").send(renderErrorPage("Forbidden", "Cross-origin form submission rejected."));
        return;
      }

      const auth = await requireSession(req, res);
      if (!auth) return;

      const csrfToken = readStringField(req.body, "_csrf");
      const kindRaw = readStringField(req.body, "kind");
      if (kindRaw !== "secret" && kindRaw !== "public") {
        const keysRes = await api.listKeys(auth.token);
        res.status(400).type("html").send(
          renderKeysPage({
            merchant: auth.info.merchant,
            csrfToken: auth.info.session.csrf_token,
            keys: keysRes.data?.keys ?? [],
            error: "Select either a secret or public key to replace.",
          }),
        );
        return;
      }

      const rotateRes = await api.rotateKey(auth.token, csrfToken, kindRaw);
      if (rotateRes.status === 401) {
        redirectToLogin(req, res, true);
        return;
      }
      if (rotateRes.status === 403) {
        res.status(403).type("html").send(renderErrorPage("Invalid CSRF token", "Please refresh the page and try rotating the key again."));
        return;
      }
      if (!rotateRes.ok || !rotateRes.data) {
        if (rotateRes.status >= 500) {
          res.status(502).type("html").send(renderErrorPage("API Error", "Could not rotate API key right now."));
          return;
        }
        const keysRes = await api.listKeys(auth.token);
        res.status(400).type("html").send(
          renderKeysPage({
            merchant: auth.info.merchant,
            csrfToken: auth.info.session.csrf_token,
            keys: keysRes.data?.keys ?? [],
            error: rotateRes.errorMessage ?? "Could not rotate API key.",
          }),
        );
        return;
      }

      let keys = [] as NonNullable<Awaited<ReturnType<typeof api.listKeys>>["data"]>["keys"];
      let warning: string | undefined;
      try {
        const keysRes = await api.listKeys(auth.token);
        if (keysRes.ok && keysRes.data) {
          keys = keysRes.data.keys;
        } else {
          warning =
            "Your replacement key is active and the previous key was revoked, but key history could not be loaded right now. Save your key above before refreshing.";
        }
      } catch {
        warning =
          "Your replacement key is active and the previous key was revoked, but key history could not be loaded right now. Save your key above before refreshing.";
      }

      res.type("html").send(
        renderKeysPage({
          merchant: auth.info.merchant,
          csrfToken: auth.info.session.csrf_token,
          keys,
          warning,
          rotatedKey: {
            kind: rotateRes.data.key.kind,
            value: rotateRes.data.key.value,
            revokedCount: rotateRes.data.revoked_count,
          },
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(renderErrorPage("Page not found", "The requested dashboard page does not exist."));
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.set("Cache-Control", "no-store");
    if (error?.type === "entity.too.large") {
      res.status(413).type("html").send(renderErrorPage("Request too large", "Form submissions must not exceed 8 KB."));
      return;
    }
    if (error instanceof UpstreamUnavailableError) {
      res
        .status(502)
        .type("html")
        .send(renderErrorPage("API unavailable", "Could not reach the FlutterPay API. Make sure it is running."));
      return;
    }
    res
      .status(500)
      .type("html")
      .send(renderErrorPage("Something went wrong", "An unexpected error occurred. Please try again."));
  };
  app.use(errorHandler);

  return app;
}

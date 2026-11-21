import express, { type ErrorRequestHandler } from "express";
import type { PrismaClient } from "./generated/prisma/client.js";
import { merchantRoutes } from "./merchants.js";

export function createApp(db: PrismaClient) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", async (_req, res) => {
    try {
      await db.merchant.count();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use("/v1/merchants", merchantRoutes(db));

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.set("Cache-Control", "no-store");
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: { code: "BODY_TOO_LARGE", message: "Request bodies must not exceed 8 KB." } });
    } else if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_INPUT", message: "Send a valid JSON request body." } });
    } else if (error?.type === "charset.unsupported" || error?.type === "encoding.unsupported") {
      res.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send a UTF-8 JSON request body." } });
    } else {
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    }
  };
  app.use(errorHandler);
  return app;
}

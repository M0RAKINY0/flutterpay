import express from "express";
import type { PrismaClient } from "./generated/prisma/client.js";

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
  return app;
}

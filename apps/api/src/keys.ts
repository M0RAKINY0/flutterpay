import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyKind } from "./generated/prisma/client.js";

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(kind: ApiKeyKind) {
  const key = `fp_${kind === "SECRET" ? "sec" : "pub"}_test_${randomBytes(32).toString("hex")}`;
  return {
    key,
    record: { kind, keyHash: hashKey(key), prefix: key.slice(0, 20) },
  };
}

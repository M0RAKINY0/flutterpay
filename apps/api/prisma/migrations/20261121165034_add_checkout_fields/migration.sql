-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantId" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "customerEmail" TEXT NOT NULL,
    "cardLast4" TEXT,
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "redirectUrl" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amountKobo", "cardLast4", "createdAt", "currency", "customerEmail", "expiresAt", "id", "merchantId", "redirectUrl", "status", "txRef", "updatedAt") SELECT "amountKobo", "cardLast4", "createdAt", "currency", "customerEmail", "expiresAt", "id", "merchantId", "redirectUrl", "status", "txRef", "updatedAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE INDEX "Transaction_merchantId_createdAt_idx" ON "Transaction"("merchantId", "createdAt");
CREATE UNIQUE INDEX "Transaction_merchantId_txRef_key" ON "Transaction"("merchantId", "txRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

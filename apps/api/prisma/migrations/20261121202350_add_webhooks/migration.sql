-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN "webhookSecret" TEXT;
ALTER TABLE "Merchant" ADD COLUMN "webhookUrl" TEXT;

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "responseCode" INTEGER,
    "errorMessage" TEXT,
    "nextRetryAt" DATETIME,
    "attemptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_claimExpiresAt_idx" ON "WebhookDelivery"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_transactionId_createdAt_idx" ON "WebhookDelivery"("transactionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_eventId_attempt_key" ON "WebhookDelivery"("eventId", "attempt");

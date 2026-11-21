-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

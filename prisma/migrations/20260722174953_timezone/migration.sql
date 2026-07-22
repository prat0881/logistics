-- AlterTable: per-Point IANA timezone (Issue 3(d))
ALTER TABLE "Point" ADD COLUMN "timezone" TEXT;

-- Stamp existing rows with the org default zone (Issue 3 migration)
UPDATE "Point" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" IS NULL;

-- CreateTable: key-value app settings (org default timezone, Issue 3(c))
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

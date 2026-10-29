-- Bot send log, claim keys, and the per-recipient daily counter.
--
-- prisma db push (the Vercel build) creates these from schema.prisma.
-- This file is the same shape for a migration run. It does not send messages.
-- Re-running is a no-op. It does not touch existing confirmation rows.
--
-- Bots share ConfirmationRateBucket for the global hourly cap and for each
-- caller's own hourly cap (hourBucket "bot:<caller>:<hour>").

CREATE TABLE IF NOT EXISTS "BotSend" (
  "id" TEXT NOT NULL,
  "caller" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "phone" TEXT,
  "groupId" TEXT,
  "bodyHash" TEXT NOT NULL,
  "mediaUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "reason" TEXT,
  "dryRun" BOOLEAN NOT NULL DEFAULT true,
  "claimKey" TEXT,
  "bodyDedupeKey" TEXT,
  "etDay" TEXT,
  "sendblueMessageId" TEXT,
  "error" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotSend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotSend_claimKey_key" ON "BotSend"("claimKey");
CREATE UNIQUE INDEX IF NOT EXISTS "BotSend_bodyDedupeKey_key" ON "BotSend"("bodyDedupeKey");
CREATE INDEX IF NOT EXISTS "BotSend_caller_createdAt_idx" ON "BotSend"("caller", "createdAt");
CREATE INDEX IF NOT EXISTS "BotSend_recipient_bodyHash_createdAt_idx" ON "BotSend"("recipient", "bodyHash", "createdAt");
CREATE INDEX IF NOT EXISTS "BotSend_recipient_etDay_idx" ON "BotSend"("recipient", "etDay");

CREATE TABLE IF NOT EXISTS "BotRecipientDay" (
  "recipientKey" TEXT NOT NULL,
  "etDay" TEXT NOT NULL,
  "dryRun" BOOLEAN NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "BotRecipientDay_pkey" PRIMARY KEY ("recipientKey", "etDay", "dryRun")
);

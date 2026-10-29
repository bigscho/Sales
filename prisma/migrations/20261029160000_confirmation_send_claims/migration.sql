-- Claim-before-send for confirmation texts.
--
-- prisma db push (the Vercel build) creates the new columns and tables from
-- schema.prisma. This migration is still required: it backfills claim keys
-- onto the historical winner of each duplicate burst so an old send occupies
-- the unique slot, and it creates the indexes if db push has not run yet.
--
-- Safe to run once Colin approves it. It does not send messages.
-- Re-running is a no-op for rows that already have keys.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "ConfirmationSend" ADD COLUMN IF NOT EXISTS "claimKey" TEXT;
ALTER TABLE "ConfirmationSend" ADD COLUMN IF NOT EXISTS "dayOfGroupDayKey" TEXT;
ALTER TABLE "ConfirmationSend" ADD COLUMN IF NOT EXISTS "bodyDedupeKey" TEXT;
ALTER TABLE "ConfirmationSend" ADD COLUMN IF NOT EXISTS "bodyHash" TEXT;
ALTER TABLE "ConfirmationSend" ADD COLUMN IF NOT EXISTS "etDay" TEXT;

UPDATE "ConfirmationSend"
SET
  "etDay" = to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
  "bodyHash" = encode(digest(convert_to("body", 'UTF8'), 'sha256'), 'hex')
WHERE "etDay" IS NULL OR "bodyHash" IS NULL;

-- One open claim per booking (or reconnect sequence) + touchpoint + dry/live lane.
WITH winners AS (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          CASE
            WHEN "reconnectId" IS NOT NULL THEN 'reconnect:' || "reconnectId"
            ELSE 'booking:' || "bookingId"
          END,
          "touchpoint",
          "dryRun"
        ORDER BY
          CASE "status" WHEN 'sent' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
          "createdAt" ASC
      ) AS rn
    FROM "ConfirmationSend"
    WHERE "status" IN ('queued', 'sent', 'failed')
  ) ranked
  WHERE rn = 1
)
UPDATE "ConfirmationSend" AS c
SET "claimKey" =
  CASE
    WHEN c."reconnectId" IS NOT NULL THEN 'reconnect:' || c."reconnectId"
    ELSE 'booking:' || c."bookingId"
  END
  || ':' || c."touchpoint" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
FROM winners AS w
WHERE c.id = w.id
  AND c."claimKey" IS NULL;

-- At most one day-of claim per group per Eastern day per lane.
WITH winners AS (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY "groupId", "etDay", "dryRun"
        ORDER BY
          CASE "status" WHEN 'sent' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
          "createdAt" ASC
      ) AS rn
    FROM "ConfirmationSend"
    WHERE "touchpoint" = 'day_of'
      AND "groupId" IS NOT NULL
      AND "etDay" IS NOT NULL
      AND "status" IN ('queued', 'sent', 'failed')
  ) ranked
  WHERE rn = 1
)
UPDATE "ConfirmationSend" AS c
SET "dayOfGroupDayKey" =
  c."groupId" || ':' || c."etDay" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
FROM winners AS w
WHERE c.id = w.id
  AND c."dayOfGroupDayKey" IS NULL;

-- At most one identical body per group per Eastern day per lane.
WITH winners AS (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY "groupId", "bodyHash", "etDay", "dryRun"
        ORDER BY
          CASE "status" WHEN 'sent' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
          "createdAt" ASC
      ) AS rn
    FROM "ConfirmationSend"
    WHERE "groupId" IS NOT NULL
      AND "bodyHash" IS NOT NULL
      AND "etDay" IS NOT NULL
      AND "status" IN ('queued', 'sent', 'failed')
  ) ranked
  WHERE rn = 1
)
UPDATE "ConfirmationSend" AS c
SET "bodyDedupeKey" =
  c."groupId" || ':' || c."bodyHash" || ':' || c."etDay" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
FROM winners AS w
WHERE c.id = w.id
  AND c."bodyDedupeKey" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ConfirmationSend_claimKey_key" ON "ConfirmationSend"("claimKey");
CREATE UNIQUE INDEX IF NOT EXISTS "ConfirmationSend_dayOfGroupDayKey_key" ON "ConfirmationSend"("dayOfGroupDayKey");
CREATE UNIQUE INDEX IF NOT EXISTS "ConfirmationSend_bodyDedupeKey_key" ON "ConfirmationSend"("bodyDedupeKey");
CREATE INDEX IF NOT EXISTS "ConfirmationSend_groupId_bodyHash_createdAt_idx" ON "ConfirmationSend"("groupId", "bodyHash", "createdAt");
CREATE INDEX IF NOT EXISTS "ConfirmationSend_groupId_touchpoint_etDay_idx" ON "ConfirmationSend"("groupId", "touchpoint", "etDay");

CREATE TABLE IF NOT EXISTS "ConfirmationRateBucket" (
  "hourBucket" TEXT NOT NULL,
  "dryRun" BOOLEAN NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ConfirmationRateBucket_pkey" PRIMARY KEY ("hourBucket", "dryRun")
);

CREATE TABLE IF NOT EXISTS "ConfirmationOptOut" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL DEFAULT '',
  "groupId" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfirmationOptOut_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConfirmationOptOut_phone_groupId_key" ON "ConfirmationOptOut"("phone", "groupId");
CREATE INDEX IF NOT EXISTS "ConfirmationOptOut_phone_idx" ON "ConfirmationOptOut"("phone");
CREATE INDEX IF NOT EXISTS "ConfirmationOptOut_groupId_idx" ON "ConfirmationOptOut"("groupId");

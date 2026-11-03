-- Claim-before-send schema for confirmation texts (PR #18).
--
-- Run this file by hand, in one transaction. It does not send messages.
-- The Vercel build must not run it: `npm run build` is
-- `prisma generate && next build` and does not connect to the database.
--
-- Do not use `prisma migrate deploy` for this repo. Production was built
-- with `prisma db push`, so `_prisma_migrations` is not a baseline, and the
-- older SQL file in prisma/migrations is not idempotent.
--
-- Why production deploy dpl_J56Def7smLqouUGb8mXZDnpocSHK failed on
-- 2026-10-29: the build ran `prisma db push` with no TTY. Prisma exits
-- before any DDL when the diff adds a unique constraint to an existing
-- table, unless `--accept-data-loss` is passed:
--
--   A unique constraint covering the columns `[claimKey]` on the table
--   `ConfirmationSend` will be added. If there are existing duplicate
--   values, this will fail.
--
-- The same warning is raised for `dayOfGroupDayKey` and `bodyDedupeKey`.
-- `next build` never started. Reproduced locally against the pre-#18 schema
-- with duplicate day-of rows: the command exited 1 and added no columns.
--
-- This script is the schema change, and it is non-destructive:
--   * nullable columns and new empty tables only; no drops, no deletes
--   * duplicate historical sends stay in the log
--   * a unique key is written only onto one winner per slot (prefer sent,
--     then queued, then failed; earliest createdAt). The other copies keep
--     NULL keys. Postgres unique indexes allow many NULLs, so the duplicates
--     do not have to be deleted before the indexes are created
--   * a key the application already wrote is left alone — the backfill will
--     not assign that same key to an older row
-- Re-running is a no-op for rows that already have keys.
--
-- pgcrypto supplies sha256, matching Node
-- createHash("sha256").update(body, "utf8").digest("hex").
-- Neon allows CREATE EXTENSION pgcrypto for the database owner. If it
-- fails, this transaction rolls back and no index is created.
--
-- ConfirmationSend.createdAt is timestamp without time zone, stored as UTC
-- by Prisma. The Eastern day below matches etDayString in guards.ts.
--
-- CREATE INDEX takes a brief ShareLock. ConfirmationSend is the send log,
-- not a large table. CONCURRENTLY cannot run inside this transaction.

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
  AND c."claimKey" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ConfirmationSend" AS taken
    WHERE taken."claimKey" =
      CASE
        WHEN c."reconnectId" IS NOT NULL THEN 'reconnect:' || c."reconnectId"
        ELSE 'booking:' || c."bookingId"
      END
      || ':' || c."touchpoint" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
  );

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
  AND c."dayOfGroupDayKey" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ConfirmationSend" AS taken
    WHERE taken."dayOfGroupDayKey" =
      c."groupId" || ':' || c."etDay" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
  );

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
  AND c."bodyDedupeKey" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ConfirmationSend" AS taken
    WHERE taken."bodyDedupeKey" =
      c."groupId" || ':' || c."bodyHash" || ':' || c."etDay" || ':' || CASE WHEN c."dryRun" THEN 'dry' ELSE 'live' END
  );

-- Refuse to lock in a unique index if the backfill itself produced a duplicate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ConfirmationSend"
    WHERE "claimKey" IS NOT NULL
    GROUP BY "claimKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate claimKey after backfill';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ConfirmationSend"
    WHERE "dayOfGroupDayKey" IS NOT NULL
    GROUP BY "dayOfGroupDayKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate dayOfGroupDayKey after backfill';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ConfirmationSend"
    WHERE "bodyDedupeKey" IS NOT NULL
    GROUP BY "bodyDedupeKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate bodyDedupeKey after backfill';
  END IF;
END $$;

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

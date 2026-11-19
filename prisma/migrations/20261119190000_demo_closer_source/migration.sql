-- Closer credit source on Demo.
--
-- Run this file by hand against the Sales database. Do not run it from the
-- Vercel build, and do not use `prisma migrate deploy` or `prisma db push`
-- from CI. Production was built with `prisma db push`; `_prisma_migrations`
-- is not a baseline for this repo.
--
-- The columns are nullable. Existing rows stay as they are (closerSource
-- NULL means "not yet classified"). Nothing is dropped or rewritten.
-- Re-running is a no-op.
--
-- Apply this BEFORE deploying the app change. The new code reads and writes
-- these columns on every demo query.

ALTER TABLE "Demo" ADD COLUMN IF NOT EXISTS "closerSource" TEXT;
ALTER TABLE "Demo" ADD COLUMN IF NOT EXISTS "closerReviewReason" TEXT;

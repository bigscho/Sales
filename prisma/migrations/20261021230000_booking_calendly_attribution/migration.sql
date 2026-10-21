-- Grassfed Demo booking questions ("How did you hear about us?" and
-- "If someone sent you, who?"). Two nullable text columns on Booking.
-- Existing rows stay NULL. Setter, phone, address, and lead-source columns
-- are untouched. Safe to apply more than once.
--
-- Production schema was created with `prisma db push` (the Vercel build
-- runs `prisma db push`). This file is the same additive change for
-- `prisma migrate deploy`. Do not run a reset or a non-additive migrate.

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "howHeard" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "referredBy" TEXT;

-- Flag Calendly bookings whose "Booked by" text matched no active setter/closer.
-- Nullable, no backfill: existing rows stay attributed exactly as they are.
-- The webhook stops creating TeamMember rows from this free text; it records the
-- raw string here and leaves Booking.setterId null until an admin assigns one.

ALTER TABLE "Booking" ADD COLUMN "unmatchedBookedBy" TEXT;

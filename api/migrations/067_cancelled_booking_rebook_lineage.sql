-- Migration 067: durable lineage for owner-created rebookings.
-- A rebooking is always a new booking. The cancelled source remains immutable
-- and no payment, refund, assignment, evidence, or payout identifiers are reused.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS rebooked_from_booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_rebooked_from_booking_id
  ON public.bookings (rebooked_from_booking_id)
  WHERE rebooked_from_booking_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.bookings'::regclass
       AND conname = 'bookings_rebook_source_not_self'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_rebook_source_not_self
      CHECK (rebooked_from_booking_id IS NULL OR rebooked_from_booking_id <> id);
  END IF;
END;
$$;

COMMENT ON COLUMN public.bookings.rebooked_from_booking_id IS
  'Cancelled booking copied by the owner to create this separate booking. Financial and operational state is never inherited.';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (67, 'cancelled_booking_rebook_lineage')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

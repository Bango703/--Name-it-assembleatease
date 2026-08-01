-- AssembleAtEase migration 054
-- Persists normalized booking service locations for complete Market Demand
-- reporting and backfills unresolved damage reports into Operations Cases.
--
-- This migration does not change payment, refund, payout, booking status, or
-- damage-hold truth. Safe to re-run after migration 053.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.bookings') IS NULL
     OR to_regclass('public.operations_cases') IS NULL
     OR to_regclass('public.operations_case_events') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL THEN
    RAISE EXCEPTION 'Apply launch migrations through 053 before migration 054';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_schema_state schema_state
     WHERE schema_state.migration_number = 53
  ) THEN
    RAISE EXCEPTION 'Migration 053 must be recorded before migration 054';
  END IF;
END;
$$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS service_city TEXT,
  ADD COLUMN IF NOT EXISTS service_state TEXT,
  ADD COLUMN IF NOT EXISTS service_zip TEXT;

UPDATE public.bookings booking
   SET service_zip = COALESCE(
         booking.service_zip,
         substring(booking.address FROM '([0-9]{5})(?:-[0-9]{4})?\s*$')
       ),
       service_state = COALESCE(
         booking.service_state,
         CASE
           WHEN booking.address ~* '(?:^|,)\s*(?:TX|Texas)\s*(?:,|[0-9]{5}|$)' THEN 'TX'
           ELSE NULL
         END
       ),
       service_city = COALESCE(
         booking.service_city,
         NULLIF(btrim(substring(
           booking.address FROM '(?i),\s*([^,]+)\s*,\s*(?:TX|Texas)\s*,?\s*[0-9]{5}'
         )), '')
       )
 WHERE booking.address IS NOT NULL
   AND (
     booking.service_city IS NULL
     OR booking.service_state IS NULL
     OR booking.service_zip IS NULL
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bookings'::regclass
       AND conname = 'bookings_service_state_shape'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_service_state_shape
      CHECK (service_state IS NULL OR service_state ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bookings'::regclass
       AND conname = 'bookings_service_zip_shape'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_service_zip_shape
      CHECK (service_zip IS NULL OR service_zip ~ '^[0-9]{5}$');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_bookings_service_market
  ON public.bookings (service_state, service_city, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_service_zip
  ON public.bookings (service_zip, created_at DESC)
  WHERE service_zip IS NOT NULL;

INSERT INTO public.operations_cases (
  case_ref, case_type, source, source_ref, status, severity,
  subject, description, booking_id,
  customer_name, customer_email, customer_phone, easer_id,
  created_by_type, created_by_name, created_at, updated_at
)
SELECT
  'AAE-OP-DMG-' || upper(substr(replace(booking.id::TEXT, '-', ''), 1, 12)),
  'damage',
  'easer_report',
  'damage-booking:' || booking.id::TEXT,
  'open',
  'high',
  'Damage report requires documented review',
  'Possible damage was reported for booking ' || booking.ref || '. Review the saved evidence, document any follow-up, and use the booking damage-review workflow to close the hold.',
  booking.id,
  booking.customer_name,
  booking.customer_email,
  booking.customer_phone,
  booking.assembler_id,
  'system',
  'Damage workflow',
  COALESCE(booking.damage_claim_opened_at, booking.created_at, NOW()),
  COALESCE(booking.damage_claim_opened_at, booking.created_at, NOW())
FROM public.bookings booking
WHERE booking.damage_review_status = 'review_required'
ON CONFLICT DO NOTHING;

INSERT INTO public.operations_case_events (
  case_id, event_type, actor_type, actor_name, to_status,
  note, public_message, metadata, created_at
)
SELECT
  operation_case.id,
  'created',
  'system',
  'Damage workflow',
  operation_case.status,
  'Damage report linked from the authoritative booking hold.',
  NULL,
  jsonb_build_object('bookingId', operation_case.booking_id, 'backfilledByMigration', 54),
  operation_case.created_at
FROM public.operations_cases operation_case
WHERE operation_case.source = 'easer_report'
  AND operation_case.source_ref LIKE 'damage-booking:%'
  AND NOT EXISTS (
    SELECT 1
      FROM public.operations_case_events event
     WHERE event.case_id = operation_case.id
       AND event.event_type = 'created'
  );

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (54, 'booking_demand_and_damage_cases')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

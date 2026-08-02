-- AssembleAtEase migration 056
-- Adds bounded, privacy-safe acquisition attribution to the authoritative
-- booking record and permits the exact financial lock used by the scheduled
-- card-authorization worker. No booking, payment, payout, or dispatch state
-- is changed when this migration is applied.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.bookings') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL THEN
    RAISE EXCEPTION 'Apply launch migrations through 055 before migration 056';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_schema_state WHERE migration_number = 55
  ) THEN
    RAISE EXCEPTION 'Migration 055 must be recorded before migration 056';
  END IF;
END;
$$;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS booking_attribution JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_financial_operation_type_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_financial_operation_type_check
  CHECK (
    financial_operation_type IS NULL OR financial_operation_type IN (
      'completion_owner', 'completion_easer',
      'cancel_owner', 'cancel_customer', 'cancel_guest',
      'payout_manual', 'payout_connect', 'refund_owner',
      'reauth_payment', 'expire_payment', 'authorize_scheduled_payment'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bookings'::regclass
       AND conname = 'bookings_attribution_object'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_attribution_object
      CHECK (jsonb_typeof(booking_attribution) = 'object');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_bookings_attribution_source
  ON public.bookings ((lower(booking_attribution ->> 'source')))
  WHERE booking_attribution <> '{}'::JSONB;

CREATE INDEX IF NOT EXISTS idx_bookings_attribution_campaign
  ON public.bookings ((lower(booking_attribution ->> 'utmCampaign')))
  WHERE booking_attribution ? 'utmCampaign';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (56, 'booking_attribution_and_scheduled_authorization')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

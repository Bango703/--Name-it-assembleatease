-- Migration 065: versioned customer assent and privacy-notice evidence.
-- Apply before deploying the matching booking APIs.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS customer_terms_version TEXT,
  ADD COLUMN IF NOT EXISTS customer_terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_terms_acceptance_method TEXT,
  ADD COLUMN IF NOT EXISTS customer_privacy_notice_version TEXT,
  ADD COLUMN IF NOT EXISTS customer_terms_acceptance_ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS customer_terms_acceptance_user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_customer_terms_version
  ON public.bookings (customer_terms_version)
  WHERE customer_terms_version IS NOT NULL;

COMMENT ON COLUMN public.bookings.customer_terms_acceptance_method IS
  'Evidence channel only: online_checkout_checkbox, secure_tracking_confirmation, or owner_attested_customer_agreement. Never backfill historical assent.';

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (65, 'customer_legal_consent')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

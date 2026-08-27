-- ============================================================
-- Migration 076: SMS consent, opt-out, and delivery truth
--
-- TCPA requires PRIOR EXPRESS CONSENT before an automated text, and a working
-- opt-out. Both are recorded here, not inferred: a phone number on file is NOT
-- consent to text it, and the sender refuses without a recorded timestamp.
--
-- Opt-out is authoritative and permanent until the person opts back in. Telnyx
-- blocks a number that texts STOP at the carrier level, but that is invisible to
-- this platform — without these columns the dashboard would keep reporting
-- "sent" for a number the carrier is silently dropping.
-- ============================================================

-- ── Easers ──────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_opt_out_keyword TEXT;

-- ── Customers (consent lives on the booking; there is no customer account) ───
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_consent_source TEXT,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ;

-- An opt-out must never coexist with a later consent that was not re-given.
-- Re-consent (START) clears the opt-out rather than sitting alongside it.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_sms_consent_coherent_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_sms_consent_coherent_check
  CHECK (
    sms_opted_out_at IS NULL
    OR sms_consent_at IS NULL
    OR sms_opted_out_at >= sms_consent_at
  );

-- Fast lookup of who may be texted.
CREATE INDEX IF NOT EXISTS idx_profiles_sms_reachable
  ON public.profiles (id)
  WHERE sms_consent_at IS NOT NULL AND sms_opted_out_at IS NULL;

-- notification_log already carries channel/status/provider_id and, once
-- migration 068 is applied, the delivery-event columns. SMS reuses all of it —
-- one owner view for both channels rather than a parallel system. Only the
-- lookup index is channel-specific.
CREATE INDEX IF NOT EXISTS idx_notification_log_sms_provider
  ON public.notification_log (provider_id)
  WHERE channel = 'sms' AND provider_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (76, '076_sms_consent_and_delivery')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$$;

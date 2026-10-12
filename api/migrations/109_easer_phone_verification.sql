-- Migration 109: an Easer's new phone number is confirmed with a texted code.
--
-- Owner, 2026-10-12, asked whether texts still go out after an Easer changes
-- their number. They did, at once: update_own_easer_profile (migration 031)
-- overwrote profiles.phone and api/_sms.js texts whatever number is on file, on
-- consent given for the old number. A typo sent job offers to a stranger and the
-- Easer silently stopped getting texts.
--
-- 1. easer_phone_verifications holds one pending change per Easer: the new
--    number, a salted hash of the 6-digit code, its expiry, tries and sends.
--    Server only (service role); RLS on with no policies.
-- 2. guard_profile_self_phone refuses a phone change made with the Easer's own
--    session. Formatting alone ("512-555-0123" to "+15125550123") is not a
--    change. The server writes the number after the code matches
--    (api/assembler/phone-verification.js), and owner edits run as the server,
--    so both pass. The trigger is separate from guard_profile_self_update so
--    migration 031's guard is untouched.
--
-- Apply BEFORE deploying the code: the endpoint reads the new table.

BEGIN;

CREATE TABLE IF NOT EXISTS public.easer_phone_verifications (
  easer_id          uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone             text NOT NULL,
  code_hash         text NOT NULL,
  expires_at        timestamptz NOT NULL,
  attempts          smallint NOT NULL DEFAULT 0,
  send_count        smallint NOT NULL DEFAULT 1,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.easer_phone_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.easer_phone_verifications FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_self_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_old text := right(regexp_replace(COALESCE(OLD.phone, ''), '[^0-9]', '', 'g'), 10);
  v_new text := right(regexp_replace(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g'), 10);
BEGIN
  -- Only a signed-in user's own session is held to the code; the server and the
  -- database console are not.
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'Confirm a new phone number with the code we text to it.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_self_phone ON public.profiles;
CREATE TRIGGER profiles_guard_self_phone
  BEFORE UPDATE OF phone ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_self_phone();

REVOKE ALL ON FUNCTION public.guard_profile_self_phone() FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (109, 'easer_phone_verification')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';

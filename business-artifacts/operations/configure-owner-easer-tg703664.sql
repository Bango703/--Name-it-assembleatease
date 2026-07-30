-- One-time production configuration for the singular owner-Easer account.
-- Apply migration 042 first. This script is idempotent and fails closed if the
-- email is missing, is not an Easer, or a different owner-Easer is configured.

BEGIN;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

DO $owner_easer_configuration$
DECLARE
  v_target_id UUID;
  v_target_count INTEGER;
  v_other_owner_id UUID;
BEGIN
  LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT COUNT(*)
    INTO v_target_count
    FROM public.profiles
   WHERE LOWER(BTRIM(email)) = 'tg703664@gmail.com'
     AND role = 'assembler';

  IF v_target_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one assembler profile for tg703664@gmail.com; found %',
      v_target_count;
  END IF;

  SELECT id
    INTO STRICT v_target_id
    FROM public.profiles
   WHERE LOWER(BTRIM(email)) = 'tg703664@gmail.com'
     AND role = 'assembler';

  SELECT id
    INTO v_other_owner_id
    FROM public.profiles
   WHERE is_owner IS TRUE
     AND id <> v_target_id
   LIMIT 1;

  IF v_other_owner_id IS NOT NULL THEN
    RAISE EXCEPTION
      'A different owner-Easer profile is already configured: %',
      v_other_owner_id;
  END IF;

  UPDATE public.profiles
     SET is_owner = TRUE
   WHERE id = v_target_id
     AND role = 'assembler';
END;
$owner_easer_configuration$;

SELECT
  id,
  email,
  role,
  is_owner,
  status,
  application_status,
  identity_verified,
  contractor_agreement_version,
  is_available
FROM public.profiles
WHERE LOWER(BTRIM(email)) = 'tg703664@gmail.com';

COMMIT;

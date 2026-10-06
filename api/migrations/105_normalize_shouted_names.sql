-- 105: Store names typed in all capitals or all lowercase in ordinary capitalisation.
--
-- WHY. An applicant typed "THOMAS J WILLIAMS-GIBSON"; the owner roster,
-- emails and customer booking pages showed it in capitals next to names
-- written normally. New names are normalised when saved (api/_person-name.js);
-- this corrects names already stored, with the same rule.
--
-- Only names with no casing information change: entirely upper case or
-- entirely lower case. "McDonald" or "DeShawn" are left exactly as typed.
-- initcap() starts a word after any non-alphanumeric character, which is the
-- rule normalizePersonName() follows ("Williams-Gibson", "O'Brien").
--
-- Not touched: contractor agreement signatures (stored separately, exactly as
-- signed), emails, phone numbers, any booking or payment data.

-- guard_profile_self_update (migration 031) only lets the server (service
-- role) change another person's profile. The Supabase SQL editor runs each
-- statement separately, so the service-role claim and the update must run in
-- one statement: a DO block. set_config(..., true) is local to that block's
-- transaction; the guard itself is unchanged. Applied 2026-10-06.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  RAISE NOTICE 'running as: %', auth.role();

  UPDATE public.profiles
  SET full_name = initcap(regexp_replace(btrim(full_name), '\s+', ' ', 'g'))
  WHERE full_name ~ '[A-Za-z]'
    AND (full_name = upper(full_name) OR full_name = lower(full_name))
    AND full_name IS DISTINCT FROM initcap(regexp_replace(btrim(full_name), '\s+', ' ', 'g'));

  INSERT INTO public.platform_schema_state (migration_number, migration_name)
  VALUES (105, 'normalize_shouted_names')
  ON CONFLICT (migration_number) DO NOTHING;
END
$$;

NOTIFY pgrst, 'reload schema';

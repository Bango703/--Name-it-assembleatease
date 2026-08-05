-- AssembleAtEase migration 058
-- Closes public PostgREST access left by the initial migration 057 rollout.
-- Announcement configuration and Easer delivery state are server-only.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.easer_announcements') IS NULL
     OR to_regclass('public.easer_announcement_deliveries') IS NULL
     OR to_regclass('public.platform_schema_state') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 057 before migration 058';
  END IF;
END;
$$;

ALTER TABLE public.easer_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.easer_announcement_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.easer_announcements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.easer_announcement_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.easer_announcements TO service_role;
GRANT ALL ON TABLE public.easer_announcement_deliveries TO service_role;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES
  (57, 'easer_announcements'),
  (58, 'easer_announcements_security')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;
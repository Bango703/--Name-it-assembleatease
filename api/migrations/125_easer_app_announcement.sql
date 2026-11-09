-- Migration 125: ask iPhone Easers to download the Easer app.
--
-- Owner, 2026-11-08: iPhone Easers take job offers in the Easer app; everyone
-- else keeps the website (api/_easer-app-policy.js). This sends the ask through
-- the existing announcement engine (TARGET_RULES.easer_app_missing in
-- api/_announcements.js), to approved Easers who signed their contractor
-- agreement on an iPhone and have not used the app.
--
-- "Used the app" is a push sign-in (native_push_tokens) or the app itself having
-- opened, which completes this delivery (markEaserAppSeen, called by
-- api/assembler/required-actions.js). Every send is re-checked first.
--
-- Email and push only. The web jobs page already shows its own app banner, so
-- this has no in_app channel and never adds a second banner.
--
-- Reminders are [0, 4]: ask once, remind once, then stop. Running this
-- migration is what starts the emails; pause with
--   UPDATE easer_announcements SET status = 'paused' WHERE key = 'easer_app_download';

BEGIN;

INSERT INTO easer_announcements
  (key, type, title, body, action_label, action_url, target_rule, blocks_offers, channels, reminder_days, status, created_by)
VALUES (
  'easer_app_download',
  'required_action',
  'Get the Easer app',
  'The Easer app is on the App Store. Download it on your iPhone and sign in with the same email and password you use on the website. Job offers, job details, photos and payouts are all in the app.',
  'Get the Easer app',
  'https://apps.apple.com/us/app/easer-by-assembleatease/id6820654960',
  'easer_app_missing',
  false,
  ARRAY['email', 'push']::TEXT[],
  ARRAY[0, 4]::INTEGER[],
  'active',
  'system'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (125, 'easer_app_announcement')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT key, target_rule, status, channels, reminder_days
--   FROM easer_announcements WHERE key = 'easer_app_download';
-- Expected: easer_app_download | easer_app_missing | active | {email,push} | {0,4}

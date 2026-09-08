-- Migration 093: ask Easers who have never been asked to turn on job texts.
--
-- api/_sms.js refuses to send without profiles.sms_consent_at, which is correct:
-- TCPA consent is an affirmative act and a phone number on file is not one. But
-- until 2026-09-08 the only place that timestamp was ever written was the
-- optional checkbox on the application form, so anyone approved before that box
-- was being ticked is invisible to every job notification.
--
-- This is not theoretical. notification_log for 2026-08-28 records a real job
-- where every message was dropped for exactly this reason:
--
--   dispatch_offer          -> Easer     suppressed: no_consent_recorded
--   assignment_confirmation -> Easer     suppressed: no_consent_recorded
--   arrival_nudge           -> Easer     suppressed: no_consent_recorded
--   en_route                -> customer  suppressed: no_consent_recorded
--   arrived                 -> customer  suppressed: no_consent_recorded
--
-- The consent can only come from the Easer, so this asks them, through the
-- existing announcement engine (TARGET_RULES.sms_consent_missing in
-- api/_announcements.js). It never blocks offers, and the rule deliberately
-- excludes anyone with sms_opted_out_at set — that is a decision, and re-asking
-- someone who made it is the behaviour the opt-out exists to prevent.
--
-- Reminders are [0, 5]: ask once, remind once, then stop. This is a preference,
-- not a blocker, and it should not become a nag.

BEGIN;

INSERT INTO easer_announcements
  (key, type, title, body, action_label, action_url, target_rule, blocks_offers, channels, reminder_days, status, created_by)
VALUES (
  'sms_job_texts',
  'required_action',
  'Turn on job texts',
  'Job offers, crew adds and arrival reminders can be sent to your phone, but we need your OK before we can text you. Turn on job texts in your profile so you do not miss an offer. Message and data rates may apply, and you can reply STOP to any text to turn them off again.',
  'Turn on job texts',
  '/assembler/profile',
  'sms_consent_missing',
  false,
  ARRAY['email', 'in_app', 'push']::TEXT[],
  ARRAY[0, 5]::INTEGER[],
  'active',
  'system'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (93, 'easer_sms_consent_announcement')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT key, target_rule, status, blocks_offers, reminder_days
--   FROM easer_announcements WHERE key = 'sms_job_texts';
-- Expected: sms_job_texts | sms_consent_missing | active | false | {0,5}

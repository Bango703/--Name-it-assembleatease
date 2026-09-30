-- 102: Tell every active Easer about the cancellation policy and record that
-- they read it.
--
-- WHY. The reliability policy (EASER_RELIABILITY_POLICY, 2026-09-30) counts
-- strikes for late and same-day cancellations of accepted jobs. It should be
-- known before it is applied. This notice goes by email, in-app banner and
-- push, reminds on days 0, 2 and 5, and stops for an Easer once they tap
-- "I understand" (target_rule 'policy_acknowledgment' in api/_announcements.js;
-- the tap is stored as dismissed_at on their delivery row). It never blocks
-- job offers.
--
-- Safe to run more than once.

BEGIN;

INSERT INTO easer_announcements
  (key, type, title, body, action_label, action_url, target_rule, blocks_offers, channels, reminder_days, status, created_by)
VALUES (
  'reliability_policy_2026_09',
  'required_action',
  'Cancellation policy for accepted jobs',
  E'Cancelling a job you have accepted now counts toward your reliability.\n\n- Within 15 minutes of accepting: no strike.\n- 24 hours or more before the job: no strike.\n- Less than 24 hours before the job: 1 strike.\n- On the day of the job: 2 strikes.\n\nStrikes count for 90 days. Each strike moves you lower when jobs are offered. At 3 strikes, new job offers pause until AssembleAtEase reviews your account. When you cancel, the app shows what it will count before you confirm.\n\nOpen the app and tap I understand to confirm you have read this.',
  'Open the app to confirm',
  '/assembler/my-assignments',
  'policy_acknowledgment',
  false,
  ARRAY['email', 'in_app', 'push']::TEXT[],
  ARRAY[0, 2, 5]::INTEGER[],
  'active',
  'system'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (102, 'easer_cancellation_policy_announcement')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

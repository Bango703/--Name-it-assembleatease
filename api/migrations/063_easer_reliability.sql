-- 063_easer_reliability.sql
-- The Easer reliability layer — the enforcement floor that mirrors what every
-- major platform (DoorDash completion rate, Uber cancellation rate, TaskRabbit
-- reliability rate) enforces and AssembleAtEase was missing.
--
-- Reward (tiers) defends the upside; this defends the downside so a customer is
-- never stranded. Computed by the daily tier-check cron from REAL signals:
--   * no_show_count  — count of activity_logs 'no_show_flagged' events for the Easer
--   * completion_rate — completed / (completed + no-shows), the "can we count on
--     them" metric that becomes a 4th tier gate (you can't be Elite if you strand
--     customers, no matter your volume).
--
-- Owner stays in the loop (launch mode): the cron ALERTS the owner at thresholds
-- and coaches the Easer — it does NOT silently auto-suspend. Dedup columns below
-- stop the same alert/email firing every day.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS no_show_count          INTEGER    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_rate        NUMERIC,
  ADD COLUMN IF NOT EXISTS reliability_alert_count INTEGER   DEFAULT 0,   -- no_show_count at last owner alert (dedup)
  ADD COLUMN IF NOT EXISTS acceptance_alert_at    TIMESTAMPTZ,            -- last chronic-decline owner alert (dedup)
  ADD COLUMN IF NOT EXISTS coaching_email_at      TIMESTAMPTZ;            -- last coaching email to the Easer (dedup)

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (63, 'easer_reliability') ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name, applied_at = NOW();

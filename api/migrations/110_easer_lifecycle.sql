-- Migration 110: the rest of the Easer job lifecycle (owner audit, 2026-10-12).
--
-- 1. profiles.work_services / weekly_availability: which services an Easer
--    takes and the hours they work. NULL means "any", so every Easer dispatches
--    exactly as before until they set them (api/_easer-work-preferences.js).
-- 2. easer_time_proposals: an assigned Easer proposes a new appointment time;
--    the customer accepts it on their booking page through the normal
--    reschedule path (api/booking/reschedule.js), which keeps that Easer.
-- 3. customer_feedback: an Easer's private rating of a customer after a job,
--    and a flag for a safety or conduct concern. Owner only.
--
-- Server only (service role): RLS on, no policies, no grants to app roles.
-- The code reads all three defensively, so it runs before this is applied.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS work_services TEXT[],
  ADD COLUMN IF NOT EXISTS weekly_availability JSONB,
  ADD COLUMN IF NOT EXISTS work_preferences_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.easer_time_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  easer_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  proposed_date  date NOT NULL,
  proposed_time  text NOT NULL,
  note           text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_easer_time_proposals_one_open
  ON public.easer_time_proposals (booking_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_easer_time_proposals_booking
  ON public.easer_time_proposals (booking_id, created_at DESC);
ALTER TABLE public.easer_time_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.easer_time_proposals FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.customer_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  easer_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating       smallint CHECK (rating BETWEEN 1 AND 5),
  flagged      boolean NOT NULL DEFAULT false,
  flag_reason  text CHECK (flag_reason IS NULL OR flag_reason IN ('safety', 'conduct', 'payment', 'access', 'other')),
  note         text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_feedback_has_content CHECK (rating IS NOT NULL OR flagged),
  CONSTRAINT customer_feedback_one_per_job UNIQUE (booking_id, easer_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_flagged
  ON public.customer_feedback (created_at DESC) WHERE flagged;
ALTER TABLE public.customer_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_feedback FROM PUBLIC, anon, authenticated;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (110, 'easer_lifecycle')
ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    applied_at = NOW();

COMMIT;

NOTIFY pgrst, 'reload schema';

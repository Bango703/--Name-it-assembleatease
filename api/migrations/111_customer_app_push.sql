-- 111: Customer app notifications and lock-screen trackers.
--
-- WHY. The customer iPhone app tells people their pro is confirmed, on the way,
-- has arrived and has finished, and shows a Live Activity on the lock screen
-- while the visit is under way. Each installed app has one Firebase (FCM)
-- token; each Live Activity has its own Apple push token for its booking.
-- native_push_tokens stays the Easer app's; it is keyed to profiles, and a
-- customer account has no profile row.
--
-- Code is safe before this runs: api/_customer-push.js and the register
-- endpoints treat a missing table as "no devices" and send nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_push_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_push_tokens_user ON public.customer_push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_push_tokens_email ON public.customer_push_tokens(email);

CREATE TABLE IF NOT EXISTS public.customer_live_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fcm_token       TEXT NOT NULL,
  activity_token  TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customer_live_activities_booking ON public.customer_live_activities(booking_id);

-- Server-only tables: the service role writes them; no client access.
ALTER TABLE public.customer_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_live_activities ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (111, 'customer_app_push')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

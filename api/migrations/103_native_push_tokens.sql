-- 103: Native app push tokens (Easer iOS / Android app).
--
-- WHY. The Easer app ships to the App Store and Google Play as a Capacitor
-- shell around the existing Easer pages. Web push only reaches an iPhone that
-- added the site to its home screen; the app gets native push through Firebase
-- Cloud Messaging (FCM), which needs one token per installed device.
-- push_subscriptions (web push: endpoint + keys) is unchanged and still used.
--
-- Code is safe before this runs: api/_push.js treats a missing table as
-- "no native devices" and sends web push exactly as before.

BEGIN;

CREATE TABLE IF NOT EXISTS public.native_push_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_native_push_tokens_user ON public.native_push_tokens(user_id);

-- Server-only table: the service role writes it; no client access.
ALTER TABLE public.native_push_tokens ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (103, 'native_push_tokens')
ON CONFLICT (migration_number) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

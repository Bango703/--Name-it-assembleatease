ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_recovery_token_hash TEXT;

COMMENT ON COLUMN public.bookings.payment_recovery_token_hash IS
  'SHA-256 hash of the token used only for secure payment recovery; independent of booking management credentials.';

NOTIFY pgrst, 'reload schema';
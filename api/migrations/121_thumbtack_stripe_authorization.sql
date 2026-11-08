-- Allow Thumbtack lead source to use the standard AAE Stripe authorization
-- and capture path. Legacy Thumbtack/offline records remain valid.
-- Safe to re-run.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS external_payment_authorization_expires_at TIMESTAMPTZ;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_thumbtack_external_truth;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_thumbtack_external_truth
  CHECK (
    (external_platform = 'thumbtack'
      AND external_agreement_verified_at IS NOT NULL
      AND (
        payment_method = 'thumbtack'
        OR (
          payment_method IS NULL
          AND stripe_payment_intent_id IS NOT NULL
        )
      ))
    OR (external_platform IS NULL AND payment_method IS DISTINCT FROM 'thumbtack')
  );

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (121, 'thumbtack_stripe_authorization')
ON CONFLICT (migration_number) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS payment_method_type TEXT;

UPDATE public.bookings
SET payment_method_type = 'card'
WHERE payment_method_type IS NULL
  AND stripe_payment_intent_id IS NOT NULL;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_method_type_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_method_type_check
  CHECK (payment_method_type IS NULL OR payment_method_type IN ('card', 'klarna'));

COMMENT ON COLUMN public.bookings.payment_method_type IS
  'Customer-selected Stripe payment method for this booking. Financial status remains authoritative in Stripe.';

NOTIFY pgrst, 'reload schema';

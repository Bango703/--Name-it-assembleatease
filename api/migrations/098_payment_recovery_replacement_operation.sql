ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_financial_operation_type_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_financial_operation_type_check
  CHECK (
    financial_operation_type IS NULL OR financial_operation_type IN (
      'completion_owner', 'completion_easer',
      'cancel_owner', 'cancel_customer', 'cancel_guest',
      'payout_manual', 'payout_connect', 'refund_owner',
      'reauth_payment', 'expire_payment', 'authorize_scheduled_payment',
      'payment_recovery_replacement'
    )
  );

NOTIFY pgrst, 'reload schema';
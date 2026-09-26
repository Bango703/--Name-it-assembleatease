-- Allow the customer-facing recovery page to take a financial operation lock.
--
-- WHY. When a card authorization dies, Stripe moves the PaymentIntent to
-- canceled. The secure payment page could only ever CONTINUE an existing
-- authorization, so a canceled one left it with nothing to do and it refused.
-- Customers read that as "the link expired" and asked for another link, which
-- refused identically, because the link was never the problem.
--
-- The page now creates a replacement hold instead. Creating it is a financial
-- operation, so it takes the same booking-level lock every other money path
-- uses — otherwise a completion or a cancellation can interleave with it and
-- capture an intent that is being replaced out from under it.
--
-- The lock needs a type, and bookings_financial_operation_type_check did not
-- permit one for this. Without this migration the lock UPDATE fails the check
-- constraint and no replacement can be created, which is the original bad
-- experience with a different error message.
--
-- Deliberately NOT added to the reserve_financial_operation RPC allow-list in
-- migration 092. Every type there carries eligibility rules enforced inside the
-- RPC; this lock is taken by a direct compare-and-set that does its own
-- checking, and adding it to the RPC would create a way to reserve it with no
-- rules attached.

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

-- PostgREST caches the schema. Migration 068 cost twelve hours this way.
NOTIFY pgrst, 'reload schema';

-- Single use, customer-specific $10 review thank-you codes.
-- The reward is issued only after a review on our own site is accepted.
-- (Written as 114 on Codex's branch and applied from there; renumbered 117
-- because 114-116 were taken on main. Re-running replaces reserve_review_reward_v1
-- with the version that cannot hand one code to two bookings.)
BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS review_reward_discount_cents INTEGER NOT NULL DEFAULT 0
  CHECK (review_reward_discount_cents BETWEEN 0 AND 1000);

CREATE TABLE IF NOT EXISTS public.review_reward_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT,
  customer_email TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^AAE10-[A-F0-9]{24}$'),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'reserved', 'redeemed')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reserved_booking_id UUID REFERENCES public.bookings(id) ON DELETE RESTRICT,
  reserved_until TIMESTAMPTZ,
  redeemed_booking_id UUID REFERENCES public.bookings(id) ON DELETE RESTRICT,
  redeemed_at TIMESTAMPTZ,
  CONSTRAINT review_reward_reservation_fields CHECK (
    (status = 'reserved' AND reserved_booking_id IS NOT NULL AND reserved_until IS NOT NULL)
    OR (status <> 'reserved' AND reserved_booking_id IS NULL AND reserved_until IS NULL)
  ),
  CONSTRAINT review_reward_redemption_fields CHECK (
    (status = 'redeemed' AND redeemed_booking_id IS NOT NULL AND redeemed_at IS NOT NULL)
    OR (status <> 'redeemed' AND redeemed_booking_id IS NULL AND redeemed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS review_reward_email_status_idx
  ON public.review_reward_codes (customer_email, status, expires_at);
ALTER TABLE public.review_reward_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_reward_codes_service_role_all ON public.review_reward_codes;
CREATE POLICY review_reward_codes_service_role_all ON public.review_reward_codes
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.review_reward_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.review_reward_codes TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_review_reward_v1(
  p_code TEXT, p_customer_email TEXT, p_booking_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE public.review_reward_codes
     SET status = 'reserved', reserved_booking_id = p_booking_id,
         reserved_until = now() + INTERVAL '24 hours'
   WHERE code = upper(btrim(p_code))
     AND customer_email = lower(btrim(p_customer_email))
     AND expires_at > now()
     AND (
       status = 'issued'
       -- An expired checkout hold can be taken over, but never from a booking
       -- that went ahead: a future booking on a saved card keeps its code until
       -- authorization redeems it, which can be weeks after the 24-hour hold.
       OR (status = 'reserved' AND reserved_until < now()
           AND NOT EXISTS (
             SELECT 1 FROM public.bookings b
              WHERE b.id = review_reward_codes.reserved_booking_id
                AND b.status IN ('confirmed', 'en_route', 'arrived', 'in_progress', 'completed')
           ))
     );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_review_reward_v1(p_booking_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE public.review_reward_codes
     SET status = 'issued', reserved_booking_id = NULL, reserved_until = NULL
   WHERE status = 'reserved' AND reserved_booking_id = p_booking_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_review_reward_v1(p_booking_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE public.review_reward_codes
     SET status = 'redeemed', redeemed_booking_id = p_booking_id,
         redeemed_at = now(), reserved_booking_id = NULL, reserved_until = NULL
   WHERE status = 'reserved' AND reserved_booking_id = p_booking_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_review_reward_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_review_reward_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_review_reward_v1(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_review_reward_v1(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_review_reward_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_review_reward_v1(UUID) TO service_role;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (117, '117_review_reward_codes')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';
COMMIT;

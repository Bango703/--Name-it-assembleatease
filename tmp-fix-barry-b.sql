-- ============================================================
-- Correct AAE-MPBUPWVA (Barry B · Furniture Assembly · 2026-05-18)
-- v3 — clears both guards without disabling either
--
-- TWO GUARDS FIRE ON THIS CORRECTION, AND BOTH ARE RIGHT TO EXIST
--
-- 1. guard_booking_easer_closure_assignment()
--      "Customer payment must be verified before assignment or acceptance"
--    It accepts payment_status 'authorized' or 'deposit_paid' when an Easer is
--    attached — not 'captured', because assignment normally happens BEFORE the
--    money is taken. Handled by staging the update through the states this
--    booking genuinely occupied: authorized, then captured. The guard passes on
--    its own terms with the linked PaymentIntent present, exactly as it demands.
--
-- 2. guard_profile_self_update()  (via refresh_easer_performance_counters)
--      "Profile ownership is required"
--    Setting assembler_id cascades into sync_easer_performance_counters(), which
--    writes completed_jobs and total_earned onto the Easer's profile. That guard
--    lets service_role through untouched, but the SQL editor leaves auth.role()
--    unset so it reads NULL. set_config below declares the role this session is
--    actually operating with. It is LOCAL to the transaction (the `true`), so it
--    reverts at COMMIT and changes nothing permanently.
--
-- NEITHER TRIGGER IS DISABLED. Both still run, and both still enforce every rule
-- they were written for.
--
-- EVERY FIGURE IS DERIVED, NOT ASSUMED
--   charged        $153.00   Stripe balance transaction
--   sales tax      $11.66    booking row — pass-through, never in the fee base
--   revenue base   $141.34   charged − tax
--   platform 30%    $42.40   standard tier
--   easer 70%       $98.94   owed to Travis Gibson
--   stripe fee       $4.18   Stripe balance transaction (actual)
--   platform net    $38.22   platform fee − stripe fee
-- ============================================================

BEGIN;

-- Transaction-local only. Reverts at COMMIT.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── 1. Point at the intent that actually collected the money ────────────────
-- pi_3TYYoG… charged $153.00 at 21:35 and succeeded.
-- pi_3TYaqB… (currently stored) was created at 23:44 and abandoned at $0.
UPDATE public.bookings SET
  stripe_payment_intent_id = 'pi_3TYYoGFofFuw3QLK1cb4Z356',
  payment_status           = 'authorized'
WHERE ref = 'AAE-MPBUPWVA'
  AND assembler_id IS NULL
  AND assembler_due = 0;

-- ── 2. Attribute the work and apply the split ───────────────────────────────
UPDATE public.bookings SET
  assembler_id           = 'd02cfed8-a432-430f-8a19-44bc751328f9',  -- Travis Gibson
  assembler_name         = 'Travis Gibson',
  assembler_tier         = 'elite',
  easer_fee_pct_snapshot = 30,
  assembler_due          = 9894,   -- $98.94
  platform_fee           = 4240,   -- $42.40
  stripe_fee             = 418,    -- $4.18  actual
  platform_revenue       = 3822,   -- $38.22
  -- Nothing was ever paid out and there is no payout_ledger row. Say so.
  payout_status          = 'pending',
  payout_amount          = 0,
  paid_out_at            = NULL
WHERE ref = 'AAE-MPBUPWVA'
  AND assembler_id IS NULL
  AND assembler_due = 0;

-- ── 3. Restore the true payment state — the money WAS captured ──────────────
UPDATE public.bookings SET
  payment_status = 'captured'
WHERE ref = 'AAE-MPBUPWVA'
  AND assembler_id = 'd02cfed8-a432-430f-8a19-44bc751328f9';

-- ── 4. Crew lead row ────────────────────────────────────────────────────────
-- Migration 077's backfill skipped this booking because assembler_id was NULL.
INSERT INTO public.booking_crew (
  booking_id, easer_id, role, due_cents, fee_pct_snapshot,
  funded_from, payout_status, added_by, added_reason
)
SELECT b.id, b.assembler_id, 'lead', 9894, 30, 'labor_pool', 'owed', 'correction',
       'Backfilled after AAE-MPBUPWVA was attributed to Travis Gibson; migration 077 skipped it because assembler_id was NULL'
  FROM public.bookings b
 WHERE b.ref = 'AAE-MPBUPWVA'
   AND b.assembler_id IS NOT NULL
ON CONFLICT (booking_id, easer_id) DO NOTHING;

COMMIT;

-- ── Verify the correction ───────────────────────────────────────────────────
SELECT ref, amount_charged, tax_amount,
       platform_fee, assembler_due, stripe_fee, platform_revenue,
       assembler_name, payment_status, payout_status, stripe_payment_intent_id
  FROM public.bookings WHERE ref = 'AAE-MPBUPWVA';
-- Expected: 15300 · 1166 · 4240 · 9894 · 418 · 3822 ·
--           Travis Gibson · captured · pending · pi_3TYYoGFofFuw3QLK1cb4Z356

SELECT role, due_cents, funded_from, payout_status
  FROM public.booking_crew c
  JOIN public.bookings b ON b.id = c.booking_id
 WHERE b.ref = 'AAE-MPBUPWVA';
-- Expected: one row — lead · 9894 · labor_pool · owed

-- ── Verify BOTH guards are still armed ──────────────────────────────────────
-- 'O' or 'A' means enabled. 'D' would mean a trigger got disabled — it must not.
SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS status
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE t.tgname IN ('bookings_guard_easer_closure_assignment',
                    'profiles_guard_self_update',
                    'bookings_refresh_easer_performance_counters')
   AND NOT t.tgisinternal
 ORDER BY 1, 2;

-- And that the impersonation did not persist outside the transaction.
-- Expected: empty or null — NOT service_role.
SELECT current_setting('request.jwt.claims', true) AS leftover_claims;

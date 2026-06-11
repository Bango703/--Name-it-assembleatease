-- ============================================================
-- Migration 011: Actual Stripe processing fee
-- Run once in Supabase SQL editor (safe to re-run: IF NOT EXISTS)
--
-- Stores the ACTUAL Stripe processing fee (cents) pulled from the
-- charge's balance transaction at capture time, written by
-- assembler-complete.js and complete.js. Until this is populated,
-- reporting falls back to the 2.9% + $0.30 estimate
-- (estimateStripeFeeCents in _source-of-truth.js). With it, owner
-- "Net After Stripe" / "Platform Profit" reconcile to real Stripe.
-- ============================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_fee integer;

COMMENT ON COLUMN bookings.stripe_fee IS 'Actual Stripe processing fee in cents, from the balance transaction at capture. NULL = not captured yet; reporting falls back to estimate.';

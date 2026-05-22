-- ============================================================
-- Migration 007: review_count column + reviews table guarantee
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS)
-- ============================================================

-- ── review_count on profiles ──────────────────────────────────────────────
-- Referenced in api/review.js recalcEaserRating() but never formally migrated.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;

-- ── Ensure reviews table exists (idempotent from migration 003) ───────────
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id    UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  customer_name TEXT,
  service       TEXT,
  rating        INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT        NOT NULL,
  approved      BOOLEAN     NOT NULL DEFAULT true,
  featured      BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_created        ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_booking        ON reviews(booking_id);
CREATE INDEX IF NOT EXISTS idx_reviews_approved       ON reviews(approved) WHERE approved = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_unique
  ON reviews(booking_id) WHERE booking_id IS NOT NULL;

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='reviews' AND policyname='public_read_approved'
  ) THEN
    CREATE POLICY "public_read_approved" ON reviews
      FOR SELECT USING (approved = true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='reviews' AND policyname='service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON reviews
      USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
  END IF;
END $$;

-- ── Verification ─────────────────────────────────────────────────────────
-- SELECT
--   (SELECT COUNT(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name='reviews') AS reviews_table_exists,
--   (SELECT COUNT(*) FROM information_schema.columns
--    WHERE table_name='profiles' AND column_name='review_count') AS review_count_col_exists;
-- Expected: 1, 1

-- ============================================================
-- Migration 003: Reviews Table
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS)
-- Required before any review can be submitted or displayed.
-- ============================================================

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

-- Index for fast owner review listing (newest first)
CREATE INDEX IF NOT EXISTS idx_reviews_created  ON reviews(created_at DESC);
-- Index for Easer rating recalculation (by booking)
CREATE INDEX IF NOT EXISTS idx_reviews_booking  ON reviews(booking_id);
-- Index for public display (approved only)
CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews(approved) WHERE approved = true;

-- One review per booking — prevents duplicate submission
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_unique
  ON reviews(booking_id) WHERE booking_id IS NOT NULL;

-- RLS: public can read approved reviews, service role has full access
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'reviews' AND policyname = 'public_read_approved'
  ) THEN
    CREATE POLICY "public_read_approved" ON reviews
      FOR SELECT USING (approved = true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'reviews' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY "service_role_all" ON reviews
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Verification ─────────────────────────────────────────────
-- Run after applying. Should return 1 row.
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'reviews';

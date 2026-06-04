-- ============================================================
-- Migration 015: Booking item and add-on line items
-- Purpose: Persist selected booking items so add-on attachment,
-- add-on revenue, and service profitability can use real data.
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS booking_items (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id           UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_category     TEXT        NOT NULL,
  service_name         TEXT        NOT NULL,
  item_name            TEXT        NOT NULL,
  item_price           INTEGER     NOT NULL DEFAULT 0,
  quantity             INTEGER     NOT NULL DEFAULT 1,
  is_add_on            BOOLEAN     NOT NULL DEFAULT false,
  add_on_name          TEXT,
  add_on_price         INTEGER     NOT NULL DEFAULT 0,
  line_total           INTEGER     NOT NULL DEFAULT 0,
  add_on_revenue       INTEGER     NOT NULL DEFAULT 0,
  base_service_revenue INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT booking_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT booking_items_money_nonnegative CHECK (
    item_price >= 0
    AND add_on_price >= 0
    AND line_total >= 0
    AND add_on_revenue >= 0
    AND base_service_revenue >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_booking_items_booking_id
  ON booking_items (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_items_service_category
  ON booking_items (service_category);

CREATE INDEX IF NOT EXISTS idx_booking_items_add_on
  ON booking_items (is_add_on)
  WHERE is_add_on = true;

ALTER TABLE booking_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE tablename = 'booking_items'
      AND policyname = 'service_role_all_booking_items'
  ) THEN
    CREATE POLICY "service_role_all_booking_items" ON booking_items
      USING     (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

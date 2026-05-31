-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014: booking_evidence table
-- Purpose: Immutable completion photo / evidence records per booking.
-- Safe to run multiple times (all statements use IF NOT EXISTS / OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_evidence (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id      UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  uploaded_by     UUID        NOT NULL REFERENCES profiles(id),
  storage_path    TEXT        NOT NULL,
  evidence_type   TEXT        NOT NULL DEFAULT 'completion_photo',
  mime_type       TEXT,
  file_size_bytes INTEGER,
  visibility      TEXT        NOT NULL DEFAULT 'owner',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT booking_evidence_storage_path_unique UNIQUE (storage_path),

  CONSTRAINT booking_evidence_type_check CHECK (
    evidence_type IN ('completion_photo', 'before_photo', 'damage_claim', 'customer_confirmation')
  ),

  CONSTRAINT booking_evidence_visibility_check CHECK (
    visibility IN ('owner', 'all')
  ),

  CONSTRAINT booking_evidence_file_size_positive CHECK (
    file_size_bytes IS NULL OR file_size_bytes > 0
  ),

  CONSTRAINT booking_evidence_mime_type_check CHECK (
    mime_type IS NULL OR mime_type IN (
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
    )
  )
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_booking_evidence_booking_id
  ON booking_evidence (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_evidence_uploaded_by
  ON booking_evidence (uploaded_by);

CREATE INDEX IF NOT EXISTS idx_booking_evidence_booking_visibility
  ON booking_evidence (booking_id, visibility)
  WHERE visibility = 'all';

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE booking_evidence ENABLE ROW LEVEL SECURITY;

-- Easer INSERT: only for bookings where they are the assigned assembler.
-- uploaded_by must equal auth.uid() — prevents impersonation.
CREATE POLICY IF NOT EXISTS "easer_insert_own_booking_evidence"
  ON booking_evidence
  FOR INSERT
  TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND booking_id IN (
      SELECT id FROM bookings WHERE assembler_id = auth.uid()
    )
  );

-- Easer SELECT: only their own uploaded rows.
CREATE POLICY IF NOT EXISTS "easer_select_own_evidence"
  ON booking_evidence
  FOR SELECT
  TO authenticated
  USING (uploaded_by = auth.uid());

-- No UPDATE policy: evidence is immutable for all authenticated users.
-- No DELETE policy: only the service role (owner API) can delete rows.
-- Service role bypasses all RLS — owner reads/writes use getSupabase() (service key).

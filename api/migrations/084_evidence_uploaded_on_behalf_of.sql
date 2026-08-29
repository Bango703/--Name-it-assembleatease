-- ============================================================
-- Migration 084: the owner can supply completion evidence for an Easer
--
-- WHAT THIS UNBLOCKS
-- Requesting evidence sets bookings.evidence_requested_at, which holds the
-- payout until a completion photo uploaded BY THE ASSIGNED EASER exists. If
-- that Easer cannot upload — phone died, left the platform, lost the photo,
-- simply stopped responding — the money is stranded with no owner-side way out.
-- The owner-upload endpoint that existed was locked to the owner's own
-- historical manual jobs, so it could not help with a real Easer's job.
--
-- WHY A COLUMN AND NOT JUST RELAXING THE CHECK
-- The obvious shortcut is to let the owner write uploaded_by = the Easer's id.
-- That would make the payout hold clear itself, and it would also put a false
-- statement into the one record that matters in a damage dispute: who actually
-- documented this job. Evidence whose authorship is wrong is worse than no
-- evidence, because it looks trustworthy.
--
-- So uploaded_by stays literally true — the owner — and this column records who
-- it was supplied FOR. The payout check accepts either, and every surface can
-- still tell the difference.
--
-- The completion GATE is deliberately NOT changed by this. An Easer still needs
-- their own photo to mark a job complete. This is about releasing money for work
-- already completed, not about letting the owner complete jobs on someone's
-- behalf.
-- ============================================================

ALTER TABLE public.booking_evidence
  ADD COLUMN IF NOT EXISTS uploaded_on_behalf_of UUID REFERENCES public.profiles(id);

COMMENT ON COLUMN public.booking_evidence.uploaded_on_behalf_of IS
  'Set when someone other than the assigned Easer supplied this evidence for them. uploaded_by remains the literal uploader.';

-- Supplying evidence for yourself is just uploading it; the column would only
-- add a second way to say the same thing.
ALTER TABLE public.booking_evidence
  DROP CONSTRAINT IF EXISTS booking_evidence_on_behalf_not_self;
ALTER TABLE public.booking_evidence
  ADD CONSTRAINT booking_evidence_on_behalf_not_self
  CHECK (uploaded_on_behalf_of IS NULL OR uploaded_on_behalf_of <> uploaded_by);

-- The payout check asks "is there completion evidence for THIS Easer", which is
-- now a two-column question.
CREATE INDEX IF NOT EXISTS idx_booking_evidence_on_behalf
  ON public.booking_evidence (booking_id, uploaded_on_behalf_of)
  WHERE uploaded_on_behalf_of IS NOT NULL;

DO $do$
BEGIN
  IF to_regclass('public.platform_schema_state') IS NOT NULL THEN
    INSERT INTO public.platform_schema_state (migration_number, migration_name)
    VALUES (84, '084_evidence_uploaded_on_behalf_of')
    ON CONFLICT (migration_number) DO NOTHING;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'booking_evidence' AND column_name = 'uploaded_on_behalf_of';
-- Expected: one row, uuid, YES.

SELECT COUNT(*) AS rows_supplied_on_behalf
  FROM public.booking_evidence WHERE uploaded_on_behalf_of IS NOT NULL;
-- Expected: 0 — nothing has been supplied on behalf of anyone yet.

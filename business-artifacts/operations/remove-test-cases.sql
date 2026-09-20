-- Remove confirmed test cases from the owner's Cases view.
--
-- A case opened while testing stays in operations_cases after its test booking
-- is cleaned up, because operations_cases.booking_id is ON DELETE SET NULL.
-- Since PR #176 the Cases view hides cases whose booking is flagged
-- is_test_booking (migration 094), but the rows are still there. This script
-- deletes only the cases the owner confirms, by case reference.
--
-- Run in the Supabase SQL editor:
--   1. Run STEP 1 on its own. It only reads.
--   2. Put the case references you confirmed into STEP 2, then run STEP 2.
-- Running the whole file unedited deletes nothing: STEP 2 stops on the
-- placeholder references.

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — PREVIEW. Read-only. Run this first and look at the list.
--
-- Rows with a `looks_like_test` value are the likely test cases, listed first.
-- The value is a hint, not a decision: check each one against the dashboard.
-- ═══════════════════════════════════════════════════════════════════════════
WITH test_emails AS (
  SELECT DISTINCT lower(customer_email) AS email
    FROM public.bookings
   WHERE is_test_booking
     AND customer_email IS NOT NULL
),
listed AS (
  SELECT
    c.case_ref,
    c.created_at,
    c.case_type,
    c.source,
    c.status,
    left(c.subject, 60)  AS subject,
    c.customer_name,
    c.customer_email,
    b.ref                AS booking_ref,
    CASE
      WHEN b.is_test_booking                                          THEN 'test booking'
      WHEN lower(c.customer_email) IN (SELECT email FROM test_emails) THEN 'same email as a test booking'
      WHEN c.source_ref ~* '(test|preview|sora)'                      THEN 'test source'
      WHEN c.booking_id IS NULL AND c.source = 'booking'              THEN 'booking since deleted'
    END                  AS looks_like_test,
    (SELECT count(*) FROM public.operations_case_events e WHERE e.case_id = c.id) AS history_rows
  FROM public.operations_cases c
  LEFT JOIN public.bookings b ON b.id = c.booking_id
)
SELECT case_ref, created_at::date AS created, case_type, source, status, subject,
       customer_name, customer_email, booking_ref, looks_like_test, history_rows
  FROM listed
 ORDER BY looks_like_test IS NULL, created_at DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — DELETE. Only after checking step 1.
--
-- 1. Replace the two placeholder lines with the exact case references to
--    remove (copy them from the case_ref column above).
-- 2. Run the whole block. If ANY reference you listed does not exist, it
--    names it and stops, and nothing is deleted.
--
-- History rows go first: the database refuses to delete a case that still
-- has history. Email log rows are kept; they just lose their link to the
-- case. This cannot be undone.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TEMP TABLE cases_requested ON COMMIT DROP AS
SELECT DISTINCT trim(t.ref) AS case_ref
  FROM unnest(ARRAY[
   'PASTE-CASE-REF-1',
   'PASTE-CASE-REF-2'
  ]) AS t(ref);

CREATE TEMP TABLE cases_to_remove ON COMMIT DROP AS
SELECT c.id, c.case_ref
  FROM public.operations_cases c
  JOIN cases_requested r ON r.case_ref = c.case_ref;

DO $$
DECLARE
  missing text;
  found integer;
BEGIN
  SELECT string_agg(r.case_ref, ', ' ORDER BY r.case_ref) INTO missing
    FROM cases_requested r
   WHERE NOT EXISTS (SELECT 1 FROM cases_to_remove t WHERE t.case_ref = r.case_ref);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Not found: %. Nothing was deleted.', missing;
  END IF;
  SELECT count(*) INTO found FROM cases_to_remove;
  RAISE NOTICE 'Removing % case(s) and their history.', found;
END $$;

DELETE FROM public.operations_case_events
 WHERE case_id IN (SELECT id FROM cases_to_remove);

DELETE FROM public.operations_cases
 WHERE id IN (SELECT id FROM cases_to_remove);

COMMIT;

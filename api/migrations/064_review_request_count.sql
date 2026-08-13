-- 064_review_request_count.sql
-- Up-to-3 spaced review requests. Tracks how many review emails a booking has
-- received so the cron can space them out and stop at 3. The sequence ALSO stops
-- the moment a row exists in `reviews` for the booking (customer left a review) —
-- that check is done live in the cron, no column needed here.
-- Additive; existing rows default 0. review_requested_at is reused as "last sent".

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS review_request_count INTEGER DEFAULT 0;

INSERT INTO public.platform_schema_state (migration_number, migration_name)
VALUES (64, 'review_request_count') ON CONFLICT (migration_number) DO UPDATE
SET migration_name = EXCLUDED.migration_name, applied_at = NOW();

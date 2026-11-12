---
name: aae-weekly-business-check
description: Run the AssembleAtEase business check-up from production data: bookings by source and outcome, cancellations and why, completed-job money, demand by area, Easer supply, job-offer acceptance and speed, payouts, Stripe event health, email/text delivery and the partner pipeline. Use this whenever the owner asks how the business is doing, for a weekly or monthly report, why bookings are low or cancelling, whether Easers are paid, what the numbers say, or for "real data", even if they don't say "weekly check".
---

# Weekly business check

The owner runs AssembleAtEase without database access in this environment, and
reads from production are not allowed from here. So the check is: give the owner
one read-only query, they run it in Supabase and paste the result back, and you
turn it into a short, honest report. The value is in separating what the data
proves from what it only suggests: a confident wrong number costs more than an
honest "unknown", because the owner acts on it.

## 1. Give the owner the query

Tell them: open Supabase, then SQL Editor, paste this, click Run, then copy the
single result cell (right-click > Copy cell content, or double-click the cell,
then Ctrl+A, Ctrl+C) and paste it back. It only reads; it changes nothing.

Change `90 days` if they ask for a different window.

```sql
select json_build_object(
  'a_bookings_by_source', (select json_agg(t) from (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as booking_month,
             coalesce(booking_attribution->>'channel', 'unknown') as channel,
             status, payment_status, count(*) as n
      from bookings
      where created_at >= now() - interval '90 days' and coalesce(is_test_booking, false) = false
      group by 1, 2, 3, 4 order by 1, 2, 3, 4) t),
  'b_completed_money', (select json_agg(t) from (
      select service, count(*) as jobs, sum(amount_charged) as charged, sum(platform_fee) as platform_fee,
             sum(stripe_fee) as stripe_fee, sum(payout_amount) as easer_pay,
             sum(promo_discount_cents) as promo_cents, sum(assemblecash_redeemed_cents) as cash_redeemed_cents
      from bookings
      where status = 'completed' and coalesce(is_test_booking, false) = false
      group by 1 order by 2 desc) t),
  'c_demand_by_area', (select json_agg(t) from (
      select left(service_zip, 3) as zip3, status, count(*) as n
      from bookings
      where created_at >= now() - interval '90 days' and coalesce(is_test_booking, false) = false
      group by 1, 2 order by 1, 2) t),
  'd_easer_supply', (select json_agg(t) from (
      select p.application_status, p.status,
             coalesce(to_jsonb(p)->>'city', to_jsonb(p)->>'zip', '?') as area, count(*) as n
      from profiles p
      where p.role = 'assembler' and coalesce(p.is_demo_account, false) = false
      group by 1, 2, 3 order by 4 desc) t),
  'e_job_offers', (select json_agg(t) from (
      select offer_status, count(*) as n,
             round(avg(extract(epoch from (coalesce(accepted_at, declined_at, timed_out_at) - sent_at)) / 60)) as avg_minutes
      from dispatch_offers
      where created_at >= now() - interval '90 days'
      group by 1) t),
  'f_time_to_accept', (select row_to_json(t) from (
      select count(*) as total, count(assembler_accepted_at) as accepted,
             count(*) filter (where needs_manual_dispatch) as manual_dispatch,
             percentile_cont(0.5) within group (order by extract(epoch from (assembler_accepted_at - created_at)) / 3600) as median_hours
      from bookings
      where created_at >= now() - interval '90 days' and coalesce(is_test_booking, false) = false) t),
  'g_cancelled_and_declined', (select json_agg(t) from (
      select b.ref, to_char(b.created_at,'YYYY-MM-DD') as booked, b.date as appt_date, b.status, b.payment_status,
             left(b.service_zip,3) as zip3, b.service, (b.assembler_id is not null) as had_easer,
             b.assembler_accepted_at is not null as easer_accepted,
             coalesce(to_jsonb(b)->>'cancellation_reason', to_jsonb(b)->>'cancel_reason', to_jsonb(b)->>'decline_reason') as reason
      from bookings b
      where b.created_at >= now() - interval '90 days' and coalesce(b.is_test_booking,false) = false
        and b.status in ('cancelled','declined')
      order by b.created_at) t),
  'h_completed_payout_state', (select json_agg(t) from (
      select b.ref, b.payment_status, b.payout_status, b.payout_amount, to_char(b.completed_at,'YYYY-MM-DD') as completed
      from bookings b
      where b.status = 'completed' and coalesce(b.is_test_booking,false) = false
      order by b.completed_at desc limit 30) t),
  'i_stripe_events', (select json_agg(t) from (
      select event_type, status, count(*) as n
      from financial_event_audit
      where created_at >= now() - interval '90 days'
      group by 1, 2 order by 3 desc limit 30) t),
  'j_message_delivery', (select json_agg(t) from (
      select channel, status, count(*) as n
      from notification_log
      where sent_at >= now() - interval '30 days'
      group by 1, 2 order by 1, 2) t),
  'k_partner_pipeline', (select json_agg(t) from (
      select stage, kind, count(*) as n, count(*) filter (where follow_up_on < current_date) as overdue
      from partner_leads
      group by 1, 2 order by 1, 2) t)
) as audit;
```

If Supabase reports a missing column, fix only that line (look the column up in
`api/migrations/`) and give the corrected query; do not guess a new name twice.

## 2. Read it correctly

These details decide whether a number is right:

- **Money is in cents** (`charged`, `platform_fee`, `stripe_fee`, `easer_pay`,
  `payout_amount`). Divide by 100. `charged` includes sales tax; tax is a
  pass-through, never revenue.
- **Test bookings are excluded** by the query. Do not add them back.
- **Channel**: `unknown` means the booking predates source tracking;
  `unattributed` means no source tag and no referrer (typed URL, app, bookmark,
  or an owner-entered booking). Neither means "nobody". If most bookings have no
  source, say the source of demand is unknown.
- **Cancellations**: count duplicates (same customer, same job, minutes apart) as
  duplicates, not lost demand. A cancellation with `had_easer=false` or
  `easer_accepted=false` is a staffing failure until shown otherwise.
- **Job offers**: `superseded` means another Easer took it; `expired` means
  nobody answered in time; `cancelled` usually means the booking was cancelled.
- **Stripe events**: `processing` rows for `capture_attempt` / `transfer_attempt`
  are start entries, each normally followed by a `processed` row; compare the
  counts before calling anything stuck. Many identical `failed` rows for one
  booking an hour apart are retries; check that booking's payout state in `h`.
- **Small numbers**: with fewer than about 30 bookings, percentages swing wildly.
  Give counts, and say the sample is small.

## 3. Write the report

Use this shape, in plain words, no jargon:

```
# Business check, <date range>

## The short version
Two or three sentences: the single biggest thing the numbers say, and the one
thing to do about it.

## Verified from the data
- Bookings: N (completed X, cancelled Y, declined Z, upcoming W)
- Money on completed jobs: customers paid $A; Easers earned $B; we kept $C after Stripe fees of $D
- Easers: N active (by area); time to an Easer accepting: median H hours
- Cancellations: what they had in common (staffing, duplicates, customer changes)
- Easers paid: yes / exceptions by booking ref
- Delivery: emails/texts delivered vs failed
- Partners: contacted / never contacted / overdue

## What it suggests (not proven)
Hypotheses, each with the data that would confirm it.

## Unknown
What this query cannot show (for example traffic, ad spend, why a customer cancelled when no reason was recorded).

## What to do this week
Up to three actions, most valuable first.
```

Never fill a gap with an estimate presented as fact. If the owner wants traffic
or search numbers, those come from Google Analytics and Search Console, not
this query; say so.

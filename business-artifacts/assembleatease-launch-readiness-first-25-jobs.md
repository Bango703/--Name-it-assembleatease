# AssembleAtEase Launch Readiness and First 25 Jobs Checklist

Use this before accepting real Austin customers. Do not treat the site as self-running until every item below is true.

## Launch Blockers

- Supabase production schema verified for all migrations through `037_owner_easer_workflow_completion.sql`; the owner readiness endpoint reports `DATABASE_SCHEMA_037: pass`.
- `record_booking_payout` RPC accepts `p_payout_method`.
- `booking_evidence`, `booking_items`, `financial_event_audit`, `notification_log`, `payout_ledger`, and `dispatch_offers` exist.
- `profiles` includes agreement evidence fields: `contractor_agreement_signed_at`, `code_of_conduct_agreed_at`, `contractor_agreement_version`, `contractor_agreement_ip`, `contractor_agreement_user_agent`, `contractor_agreement_signed_name`.
- Stripe test booking completed end to end: authorization, confirmation, dispatch, Easer accept, on the way, arrived, in progress, evidence upload, completion, capture, customer receipt.
- Stripe refund test completed after capture.
- Manual payout record test completed after capture.
- Terms, privacy, and contractor agreement reviewed for manual payout and Founding Easer fee-waiver language.
- The exposed owner password is rotated in hosting, local snapshots, and the password manager; repository history is treated as compromised.
- `OWNER_SESSION_SECRET` is a separate random secret of at least 32 characters, legacy production password headers are disabled, and Upstash rate-limit credentials are configured.
- A Texas tax professional has approved service taxability and address sourcing; only then is `TEXAS_TAX_CONFIGURATION_APPROVED=true` set in production.
- The current contractor agreement version is `2026-07-13`; active Easers have reaccepted it before receiving offers.
- W-9 status is recorded for every paid Easer. Raw forms, SSNs, and EINs are retained only in an approved secure tax-document system, never in dashboard notes.
- Stripe Connect stays disabled unless every active Easer has completed Connect onboarding and a test transfer has reconciled.
- Easer membership remains disabled for launch. No priority-dispatch or reduced-fee benefit is active unless the feature is deliberately enabled and fully tested later.
- Instant booking is limited to ZIP codes in the shared server/browser service-area source of truth. Do not advertise or accept instant bookings in a new market until its tax, pricing, Easer supply, dispatch, and support checks pass.

## Daily Owner Checklist

- Review pending bookings older than 30 minutes.
- Review confirmed bookings with no Easer assigned.
- Review dispatch offers that expired without acceptance.
- Review today’s jobs for assigned Easer, accepted status, address, time, and customer phone.
- Review active jobs in `en_route`, `arrived`, and `in_progress`.
- Review completed jobs awaiting capture or payout.
- Compare completed/captured bookings against Stripe dashboard.
- Compare payout ledger against actual manual payments sent.
- Review failed or suppressed notifications.
- Review refunds, cancellations, and damage/rework notes.

## First 25 Jobs Operating Rules

- Owner personally reviews every booking before service without overriding server payment or consent gates.
- Owner personally contacts every same-day or next-day customer to reconfirm access and timing.
- Custom quotes are never owner-confirmed: the customer must approve the itemized quote, cancellation terms, and Stripe authorization through the one-time link.
- Owner confirms Easer acceptance by text/call for the first 10 jobs.
- No payout is recorded until customer payment is captured.
- No payout is recorded without an external payout method and separate proof retained by owner.
- A Stripe Connect transfer is never labeled as a completed bank payout; Connect remains disabled during manual-payout launch.
- Completion photo is required before Easer completion whenever possible.
- If a customer complains, do not pay out until the complaint is triaged unless the complaint is clearly unrelated to the Easer.
- If a refund is issued after payout, record whether the Easer payout stands, is reduced, or requires clawback.
- Track actual labor time and travel time for every job.
- Track customer satisfaction for every job before requesting a public review.

## Minimum Metrics To Watch

- Completed jobs.
- Average ticket.
- Platform gross per job after estimated Stripe fee and Easer payout.
- Refund count and refund dollars.
- Rework count.
- Late arrivals.
- Easer acceptance rate.
- Easer payout timing.
- Customer complaints by reason.
- Review request sent and review received.

## Stop Conditions

Pause new booking intake if any of these happen:

- More than one payment capture mismatch occurs.
- Any customer is charged incorrectly.
- Any Easer payout is disputed as recorded but not received.
- Two same-day jobs go unassigned.
- Any damage claim lacks photos, timeline, and owner notes.
- Refund/rework rate exceeds 10% during the first 25 jobs.
- Owner cannot complete the daily checklist.

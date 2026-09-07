# Owner Ops Card — First 25 Jobs

One page. What to check, and what to do when something fails. This is a *routine*,
not a system — every workflow named here already exists in the owner dashboard.
Keep it lean; expand only when real volume demands it.

**Contact for customers/Easers:** (979) 232-5139 · service@assembleatease.com
**Response promise:** during business hours, within one business day.
**Internal missed-call target:** return calls within 15 minutes during business hours; return after-hours calls by 8:00 AM the next business day.

---

## Daily 2-minute check (owner dashboard)
1. **Bookings** — any new booking? Confirm status is moving: created → confirmed → accepted → en route → arrived → completed.
2. **Live Ops / dispatch** — any booking sitting on `needs_manual_dispatch` (no Easer accepted)? That one needs you *today*.
3. **Financials** — any Easer payout marked pending that a completed job is waiting on?
4. **Cases** — any open support case? (Cases view.)
5. **Any red banner** — failed email, failed dispatch, clawback, or review-required. Red = act.

## When a booking comes in
- Card is **authorized (held), not charged** — capture happens at completion. Confirm the hold shows in Stripe.
- If it's **same-day**, *you* are the backstop: if no Easer accepts, take it on your own Easer account.
- Check the ZIP is one you can actually reach today.

## Phone and SMS lead routine
- Calls to (979) 232-5139 forward to the owner phone. Keep forwarding enabled and keep the destination phone's voicemail forwarding disabled.
- During published hours (Mon–Fri 7 AM–5 PM; Sat 7 AM–1 PM), answer when safe. If a job is active, finish the safety-critical step before returning the call.
- After hours, let the destination phone's professional AssembleAtEase voicemail answer. Review and return those messages by 8:00 AM the next business day.
- Log every qualified phone lead in the owner workflow with source, city, requested service, and whether it became a booking. Do not rely on the phone's recent-calls list as the business record.
- Review Telnyx failed SMS and webhook deliveries during the daily owner check. A failed notification must never change booking or payment truth.
- For an active safety or access problem, tell the caller to use 911 for an immediate emergency; then open a Case and document the operational follow-up. Do not route emergency calls through the Telnyx web dialer until E911 is registered and verified.

## Failure playbook (one line each)
| If this happens | Do this |
|---|---|
| **No Easer accepts (needs_manual_dispatch)** | Assign manually, or take it yourself on your Easer account. Text the customer with the confirmed pro + arrival window. |
| **No-show (Easer)** | Reassign or self-fulfill same day; text the customer proactively before they call. Do not capture until done. |
| **Customer cancels** | Apply the policy (free >24h; 10% after, 15% once en route — service price only, never tax). Confirm the refund/hold release in Stripe matches. |
| **Payment declined / re-auth fails** | Booking can't proceed on that card — contact the customer for a new card; never mark it paid in the dashboard if Stripe says otherwise. |
| **Refund** | Refund in the flow, then confirm Stripe **and** the payout ledger both reflect it. If the Easer was already paid, that's a clawback — flag it, don't silently absorb. |
| **Partial job / dispute** | Do not capture the full amount; open a case, gather the completion evidence, resolve before releasing payout. |
| **Failed email** | It's logged in the dashboard — the booking is NOT stranded. Follow up by text if it was a customer-facing message. |

## Customer support escalation
- Customer reaches you at the phone/email above.
- Booking issues → open a **Case** in the owner dashboard so it's tracked, not lost in texts.
- Anything touching money (refund, wrong charge, dispute) → resolve in the flow so Stripe + ledger stay in sync; never adjust one without the other.

## Weekly money reconciliation (15 min)
- **Stripe captured** = sum of completed-job charges.
- **Payout ledger** = every Easer payment recorded, none missing.
- **Tax reserve** = 100% of collected sales tax set aside (never spent — it's Texas's, remit quarterly via WebFile).
- **Same-day** (while live): part of each $69 is a rush bonus to the fulfiller, the rest is business margin — confirm the split matches on completed same-day jobs.

## The one rule
**Never let DB/dashboard state disagree with Stripe.** Stripe is the money truth. A payment captured is not an Easer paid; a manual payout recorded is not a bank transfer done. Keep them separate and reconciled.

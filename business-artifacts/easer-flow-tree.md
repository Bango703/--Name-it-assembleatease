# Easer flow tree

Every action an Easer can take on a job, what the platform does, and where it
lands for the owner. Read from the code on 2026-10-12. The same flows run in the
iPhone app and on the Easer website.

Legend: **Case** = an Operations Case in the owner Cases panel.
**Msg** = the booking's message thread for the owner. **Email** = an email to the owner.

```
JOB ARRIVES
├── Offer (auto-dispatch, 20-minute window)      api/booking/_dispatch-internal.js
│   ├── Accept  -> job is on the schedule; other offers are withdrawn
│   │                                                   api/booking/accept-dispatch.js
│   ├── Decline -> next Easer is offered the job        api/booking/decline-dispatch.js
│   └── Expires -> re-offered, up to 3 rounds, then "needs manual dispatch" for the owner
│                                                       api/cron/expire-offers.js
└── Owner assigns directly -> Easer reviews and accepts  api/booking/assign.js

BEFORE THE DAY
├── Message the customer         -> customer thread (customer sees it on the booking page,
│                                   by email and text; owner gets a copy on the timeline)
├── Message AssembleAtEase       -> AssembleAtEase thread           Owner: Msg + Email
├── Propose a new time           -> customer accepts or declines on the booking page
│   ├── Accepted -> job moves; the Easer stays on it; not counted as a customer reschedule
│   └── Declined -> original time stands; the Easer is told
│                                   api/booking/time-proposal.js, api/booking/reschedule.js
└── I can't make this job (release)
    ├── Owner-assigned job -> back to the owner, no automatic re-dispatch
    └── Dispatched job     -> re-offered to other Easers; strikes apply
                              (within 24 hours: 1 strike; same day: 2)
                                                       api/booking/drop-job.js

ON THE DAY
├── On my way -> Arrived -> Start -> Complete (photos required)
│                                                       api/booking/easer-status.js,
│                                                       api/booking/assembler-complete.js
├── Directions  -> opens Apple Maps or Google Maps at the address (app: chosen once)
├── Running late -> message in the customer thread
├── Customer isn't here (after Arrived)
│   ├── Start the wait -> customer is texted and emailed; 15-minute wait   Owner: Case
│   └── After 15 minutes: report no-show                                  Owner: Case
│       (the owner confirms the no-show and any fee; nothing is charged here)
│                                                       api/booking/customer-unavailable.js
├── Extra work on site -> priced from the catalog, sent to the customer to approve;
│                         charged only after they approve     Owner: Email
│                                                       api/booking/extra-work.js
└── Get help with this job (job accepted)
    ├── Problem with the job   -> Owner: Case + Msg (with a link to the case) + Email
    ├── I can't make this job  -> release flow above when allowed; otherwise Case
    ├── Safety concern         -> Owner: urgent Case + Msg + Email
    └── Something else         -> Owner: Case + Msg + Email
                                                       api/booking/message.js (supportType)

AFTER THE JOB
├── Report damage (with photos) -> Owner: damage Case; the payout waits until the owner
│                                  resolves the damage review
│                                                       api/booking/upload-evidence.js
├── Rate the customer (private) -> a flagged concern opens a Case
│                                                       api/booking/customer-feedback.js
├── Photos requested by owner   -> Easer uploads; payout waits for the photos
│                                                       api/owner/request-evidence.js
└── Payment captured -> earnings recorded -> payout (Stripe transfer or owner-recorded)
                                                       api/booking/assembler-complete.js,
                                                       api/cron/release-payouts.js, api/booking/payout.js
```

## What opens a case, and what does not

| Easer action | Case | Where else the owner sees it |
|---|---|---|
| Get help: problem, can't make it, something else | Yes (support) | Booking messages, with a link to the case; email |
| Get help: safety concern | Yes (safety, urgent) | Booking messages; email |
| Customer isn't here / no-show | Yes (support, high) | Booking timeline |
| Report damage | Yes (damage) | Booking damage review; the payout waits |
| Flag a customer | Yes (safety) | Customer feedback on the booking |
| Release a job | No | Booking timeline; dispatch or the owner's queue |
| Extra work | No | Change order on the booking; email |
| Propose a time | No | Booking timeline; the customer's answer |
| Message the customer | No | Copy on the booking timeline |
| Message AssembleAtEase | No | Booking messages; email |

Cases raised on test bookings are hidden in the Cases panel by default. The panel
shows "N test cases hidden" with a Show button, and the case link on the
booking message opens the case either way.

## Messages: two separate conversations

| Conversation | Who is in it | The Easer sees |
|---|---|---|
| Customer | Customer and the assigned Easer (the crew helper sees it too) | Messages between them only |
| AssembleAtEase | Easer and the owner | Their own messages with the owner |

What a customer writes to AssembleAtEase never reaches the Easer, and a
previous Easer's conversation never reaches the next one. The server decides
which conversation each message belongs to (api/booking/_message-routing.js).

## Inbox

Every notice has its own wording, a group (Jobs, Money, Account) and one button
that goes where the notice is about: the job, its customer or AssembleAtEase
conversation, Payouts, Account, Personal information or Today. The full list is
in api/assembler/notifications.js. The test scripts/test-easer-threads-and-inbox.mjs
fails if a new Easer notification is added without one.

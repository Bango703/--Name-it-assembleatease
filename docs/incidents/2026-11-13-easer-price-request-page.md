# 2026-11-13: The Easer price-request page did not say where a request stood

## What happened
During the live hybrid test the owner, signed in as an Easer, priced booking AAE-DMA4UGNPV2 on `/assembler/price-requests` and reported: it looks basic, there is little information, it is unclear how it works, and after a price is sent the form stays on screen and nothing else happens.

## Root cause
- The page derived its own state from `status` (`open`, `sent`, `chosen`, `closed`, `missed`, `withdrawn`), which only described the price offer row. Nothing told the Easer what happens after a price is chosen: the customer quote, the approval, the job offered to them first, payment.
- `chosen` covered three different facts (the customer is deciding, the customer approved, the job is the Easer's) and the page never read the job offer, so it could not link to the job.
- A sent price re-rendered the same editable form with an "Update price" button, so the Easer saw no confirmation and no change of state.
- The custom-quote catalog placeholder ("describe your project in the notes") was shown as a work item.
- No area context beyond the ZIP text, and no statement of when the address is released.

## Fix
- `easerRequestStage` in `api/booking/_quote-offers.js` decides one stage per request on the server: `open`, `sent`, `in_review`, `with_customer`, `customer_approved`, `job_offered`, `offer_ended`, `job_yours`, `job_taken`, `not_chosen`, `withdrawn`, `missed`, `closed`. `api/assembler/price-requests.js` reads this Easer's own latest dispatch offer for approved quotes so `job_offered` is only claimed when an offer is live.
- The page renders `stage` only: job facts with a ZIP-level map link and "Exact address after you accept the job", the work, a five-step tracker, and one action panel per stage. A sent price collapses to a "Your price" summary with Change price and Withdraw (confirmed on the card, no browser dialog). Requests that need the Easer are listed first; closed ones fold under "Earlier requests".
- The Jobs page banner counts `stage === 'open'`, the same server answer.

## Prevention
- `scripts/test-hybrid-offers.mjs`: every stage, the job link only when the job is the Easer's, the placeholder filtered, the page switching on `r.stage` and never on `r.status`, no `confirm()`, the dispatch read scoped to the Easer.
- `tests/e2e/easer-price-requests.spec.mjs` (iPhone viewport): send, collapse, change, cancel, withdraw with confirm, a request closing mid-entry, and every later stage with its job link.

## Caught in review before merge
- Two lines on the rebuilt page asserted things nothing verifies (Article 16): "We will let you know if your price is chosen" (no notification is sent when a price is chosen) and "paid to your bank" (payout preference can be Zelle, PayPal or check). Both reworded to what is true.

## Follow-up the owner asked for
- 2026-11-13: "they need to get a text once their bid amount is approved". When the owner sends a quote priced from an Easer's offer, that Easer gets a text, push and email (`notifyEaserPriceApproved` in `api/booking/_quote-offer-invites.js`), once per offer, after the quote is saved. The amount is the Easer's own price, never the customer total. The owner's toast says whether the Easer was reached. The screen now says "approved" too, so text and screen use one word.

## Same weakness elsewhere
- The native Easer app links to this web page (`EaserViews.swift`), so it gets the fix. A native price screen is still not built (backlog).

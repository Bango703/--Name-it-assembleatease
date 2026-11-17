# 2026-11-17: The review request email looked unlike every other AssembleAtEase email

The owner opened the review request sent to a customer for a Mounting & Hanging job (AAE-EYXG5NSDUN) and asked why it looked the way it did.

## What was wrong
- **No frame.** Since Oct 23 `buildReviewEmail` (`api/_review-email.js`) returned a complete hand-built page: white background, no logo header, no card, five paragraphs. `ensureEmailShell` passes a complete page through and only staples the house footer under it, so the customer saw a bare note with a grey company footer bolted on. The booking confirmation, assignment, completion and follow-up emails all open with the logo header (checked in `api/booking-confirmed.js`, `api/booking/assign.js`, `api/booking/assembler-complete.js` through `buildStatusEmail`, `api/cron/followup.js`); this one did not.
- **The ask was buried.** The action was two inline text links in the middle of a paragraph ("rate your Mounting & Hanging job", "Review us on Google"), competing with each other and with two "reply to this email" paragraphs.
- **Two opt-out messages.** Review requests are marketing mail, so `sendEmail` appends the Unsubscribe block (`broadcastFooter`); the house footer then added "This is a transactional email related to your booking". One email described itself two ways.
- **"Serving customers across Texas" printed twice:** once in the body, once in the footer.
- **The automatic sender never read the customer's name.** `COLS_BASE` in `api/cron/review-request.js` did not select `customer_name`, so every automatic request would have opened "Hi there" with the impersonal subject. Not yet seen by a customer: the cron's last send was Oct 5, before that template; every request since was sent by hand from the dashboard, which reads the full row.

## Why it was plain
On Oct 23 the designed version (star grid, large photo, $10 discount box, button blocks) was stripped to a plain note on the theory that it landed in Gmail's Promotions tab. That theory was never measured: the email provider events table receives sent, delivered, delayed and bounced events, never opens or clicks. Production data, read-only, 2026-11-17:

| Version | Customers asked | Emails | Reviews back |
|---|---|---|---|
| Designed (Jul 18 to Oct 20) | 7 | 23 | 0 |
| Plain (Oct 28 to Nov 17) | 2 | 3 | 0 |

The `reviews` table holds no rows at all; there have been 11 completed bookings. Neither version has worked, and the sample is too small to say the plain one was better or worse.

## What real review requests do (research, 2026-11-17)
- One question and one action, readable in seconds; the reader should know exactly what happens when they tap ([Sequenzy](https://www.sequenzy.com/blog/review-collection-email-strategies), [Really Good Emails on Airbnb](https://reallygoodemails.com/school/feedback-fridays/feedback-friday-airbnb), [Mailchimp](https://mailchimp.com/resources/what-is-the-best-way-to-ask-for-product-reviews-via-email/)).
- A star rating tapped inside the email that opens the review page with the rating already chosen is the common pattern; vendors claim it lifts completion, without independent data ([Sequenzy](https://www.sequenzy.com/blog/review-collection-email-strategies), [Mailchimp](https://mailchimp.com/resources/what-is-the-best-way-to-ask-for-product-reviews-via-email/), [RaveCapture](https://ravecapture.com/?p=246168)).
- Name the job and the person: first name, the pro, the service. Home-service guidance sends it within hours to a day while the job is fresh ([Housecall Pro](https://www.housecallpro.com/resources/how-to-automate-customer-follow-ups-home-services), [Stamped](https://website.stamped.io/blog/best-ways-to-optimize-your-review-request-emails/)).
- Gmail places mail by its content, the sender's history and how each reader handles it; hero images, product grids, offer language and walls of buttons read as marketing, a single action reads as account mail. A review request should be assumed to be at risk of Promotions whatever it looks like, and tested ([Suped](https://www.suped.com/knowledge/email-deliverability/technical/how-does-gmail-categorize-transactional-emails-for-tab-placement)).
- Google forbids offering incentives for Google reviews and selectively asking happy customers ([Google contribution policy](https://support.google.com/contributionpolicy/answer/7400114)); the FTC review rule (16 CFR Part 465) treats review gating and suppression as high risk and sent warning letters in Dec 2025 ([Arnold & Porter](https://www.arnoldporter.com/en/perspectives/blogs/consumer-products-and-retail-navigator/2026/01/ftc-warning-letters-over-consumer-review-rule)).

## Fix
- `buildReviewEmail` returns a fragment and a preview line, so `sendEmail` frames it like every other email: logo header, white card, house footer.
- In the card: service and the day it was finished, "How did Phil do?", one sentence, five tappable gold stars (text links, no images) that open `/review?...&rating=N` (review.html already selects the rating from the link), "Poor" and "Excellent" under the first and last star, then "Open the review page" and "Review us on Google" for everyone, the two reply lines (including the anti-solicitation question, unchanged) in a quiet box, and the sign-off. No photo, no offer, no button blocks.
- `emailFooter` omits the "transactional" line when the email carries its own Unsubscribe block; mail without one keeps it.
- The cron selects `customer_name` and appends the Unsubscribe block to the fragment instead of replacing `</body>`; both senders pass the preview line.

## Tests
- New `scripts/test-review-request-email.mjs` (in `test:launch`): the job, day and pro are named; each star opens the review page with its rating; Google is offered to everyone; no photo or offer; both reply lines kept; fallbacks; the framed email has the logo header, exactly one Unsubscribe link, no "transactional" line and one service-area line; both senders read the name and pass the preview line.
- `scripts/test-review-reward.mjs`: the old "no star grid" rule is replaced by "stars are text links, never images".
- `scripts/test-review-and-statewide-email-consistency.mjs`: the review email no longer carries its own service-area line and is a fragment.

## Prevention
- An email that builds its own complete page skips the house frame. New customer emails are fragments. Two customer emails still have their own layout without the logo header, the app sign-in code (`api/customer/sign-in.js`) and the AssembleCash code (`api/assemblecash/request-code.js`); EMAIL-FRAME-STRAYS in the backlog.
- A claim about inbox placement is measured before it changes a design. REVIEW-TAP-MEASURE in the backlog records star taps so the next decision rests on data.

## Follow-up the same day: the owner's check failed with a message that hid why
After #461 went live, the owner pressed Request Review to see the new email and got "Review email delivery was not accepted. Nothing was marked sent." Vercel logs show eight presses between 2:07 and 2:20 PM:
- Six on the two test bookings (AAE-GX0XLYQM, AAE-4NSSNOA): `prepareNotification` (`api/_notification-policy.js`) refuses routine mail for test bookings, and review requests are routine (quiet hours). The rule is meant for automatic mail; it also blocked the owner's deliberate send, so the check suggested after #461 could not work.
- Two on a real customer (AAE-DVSNHXE4OO) who clicked Unsubscribe on Oct 24: the opt-out list stopped the send, as the law requires.

Both blocks were right; `api/review-request.js` turned every refusal into one sentence.

Fix:
- `reviewSendRefusal` in `api/review-request.js` states the reason: the customer unsubscribed; automatic emails are not sent for test bookings; or the email service's own reason.
- The owner's send carries `ownerInitiated: true`, and `prepareNotification` lets that one through to a test booking. The automatic sender never sets it, quiet hours still apply, and real customers are unaffected.
- Both test bookings send to an @assembleatease.com mailbox (checked by domain, read-only).

Test: `scripts/test-review-request-email.mjs` section 7 runs the real `prepareNotification` against a fake database. An automatic review on a test booking is refused; the owner's send reaches the reservation; the cron never sets the flag; the old catch-all sentence is gone.

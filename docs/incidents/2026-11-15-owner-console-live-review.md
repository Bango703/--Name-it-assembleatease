# 2026-11-15: Owner review of the live console found five problems

After PR #456 put the revamped owner console live, the owner reviewed it with real data and sent screenshots.

## 1. Messages did not appear to open
- Cause: the conversation panel was placed after the whole list, so clicking a row in a list of nine opened the thread below the fold. Nothing changed on screen.
- Fix: list on the left, conversation on the right (sticky), a placeholder until one is chosen, the chosen row marked.
- Test: `tests/e2e/owner-messages-console.spec.mjs` opens the ninth conversation and checks it is beside the list and on screen.

## 2. "Onboarding links can be reissued only for a pending Easer application" for a pending applicant
- Cause: the Easer page offers the button for every account with status `pending`; the server allowed only application status `applied`, `pending` or `reviewing`. Nothing writes `pending` or `reviewing`; a waitlisted application (`waitlist`, which Easer readiness treats as submitted) was refused. Carlos de la torre: status `pending`, application `waitlist` (read-only query, 2026-11-15).
- Fix: one list of open applications, `OPEN_APPLICATION_STATUSES` (`applied`, `waitlist`) in `api/_assembler-onboarding.js`, used by `api/owner/resend-easer-onboarding.js`; a refusal names the state that stopped it.
- Test: `scripts/test-onboarding-open-applications.mjs` keeps the list equal to readiness's submitted states.

## 3. Automatic social posting failed on Google Business Profile
- Cause: every campaign and review image was `.webp`; Google Business Profile (through Buffer) refuses `.webp` ("Invalid post"), recorded in Live Ops platform errors on Nov 15, 2:00 PM.
- Fix: campaign and review posts use the original JPG and PNG photos; a blog page with a `.webp` preview falls back to its service photo; the publisher never attaches a `.webp` to a Google post.
- Test: `scripts/test-social-images.mjs` checks every image the posts can choose (26) is JPG or PNG and exists.

## 4. Booking record: item list squeezed
- Cause: wide fields (Items & Add-ons, change orders) were laid out like short label-value rows inside the Job Details card, wrapping prices ("$34 / 9.00"); "Time on Job" fell into "More".
- Fix: wide fields read as a block across the card; Job Details spans the record; Time on Job and the Easer's feedback belong to Job Details.
- Test: `tests/e2e/owner-bookings-console.spec.mjs` checks the items field spans its card.

## 5. Market Demand: cramped acquisition and area cards
- Cause: the acquisition table sat in a narrow card with its own scroll; area figures wrapped ("$2,282. / 35"); nine small unverified locations crowded the configured areas.
- Fix: acquisition spans the page without an inner scroll; area figures two by two on one line each; unverified and review locations fold into one section, every one still listed.
- Test: `tests/e2e/owner-market-demand-console.spec.mjs` checks the fold.

## Prevention
Each class has a test above. The general lesson: a layout tested only with a short list or short values can hide content once real data arrives; the new tests use full-length lists and real field shapes.

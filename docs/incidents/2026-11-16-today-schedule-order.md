# 2026-11-16: Today's schedule listed 11:00 AM above 8:00 AM

Found while moving the Today screen onto the owner console frame (screenshot pass with three jobs at 8:00, 9:00 and 11:00 AM).

- Today screen: `renderTodayView` in `owner/index.html` sorted jobs by comparing their time slots as text (`'11:00 AM' < '8:00 AM'` because `'1' < '8'`). Any morning list with a 10, 11 or 12 o'clock job read out of order, so the owner could miss the first job of the day.
- Live Ops Today panel: `api/owner/live-ops.js` sent `todaySchedule` in database order, not sorted at all.
- Fix: the server orders today's schedule with `orderByStartTime` in `api/owner/_active-jobs.js`, which reads each slot through the existing `slotStartMinutes` (`api/_easer-work-preferences.js`); the Today screen, which works from the bookings list in the browser, sorts by `scheduleMinutes`, the same reading of the slot start. A slot without a readable time goes last.
- Tests: `scripts/test-live-ops-active-jobs.mjs` (section 7) checks the order and that Live Ops uses it; `tests/e2e/owner-console-screens.spec.mjs` ("Today") checks the rows come out 8:00 AM, 9:00 AM, 11:00 AM.
- Prevention: a time shown in a list is sorted as a time. `grep localeCompare` over `owner/` finds no other time sorted as text.

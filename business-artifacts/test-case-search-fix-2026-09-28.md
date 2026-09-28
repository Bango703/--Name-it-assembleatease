# Owner test-case search: focused fix and release checks

## Finding and business impact

P1: the owner's **Find test cases** action queried `operation_cases`, while the canonical case table is `operations_cases`. Its GET endpoint returned 503 with the screenshot's exact message, `Cases could not be read.` The existing tests checked source patterns but never executed this query against the expected schema.

Read-only production verification on September 28 found:

- `GET /api/owner/test-cases`: 503 with the reported message.
- `GET /api/owner/cases?status=active`: 200.
- The misspelled table query: 404 / PGRST205, missing `public.operation_cases`.
- The identical selection against canonical `operations_cases`: 200, 21 records.

This establishes a broken test-search utility, not missing customer case data. The utility rendered its error using a full-panel class with a 220px minimum height, explaining the oversized blank-looking area. Its controller does not clear the main case list, detail, or counts.

Owner operations and confidence are affected. This repair does not alter customer or Easer workflows, strand bookings, change pay, or change customer terms. It restores a read-only lookup; classifying or closing real cases automatically would be an unsafe expansion and is not part of this fix.

## What changed

- Read the canonical case table.
- Return a retryable error if linked bookings cannot be read, instead of silently presenting partial detection as a complete result.
- Use compact, accessible loading/error feedback for this utility, with an inline Retry search action.
- Block duplicate in-flight searches.
- Report that no suspected test cases were found, without claiming every other record is verified as real.
- Add actual-handler tests with a schema-aware, read-only fake and actual-controller UI tests.

Existing closure selection, confirmation, compare-and-set, damage guards and audit trail stay on the existing case-action path. No live cases were closed or edited. No customer messages, payments, refunds or payouts were invoked.

## Exact files

```text
api/owner/test-cases.js
owner/assets/cases.js
owner/assets/cases.css
scripts/test-owner-cases-test-bookings.mjs
scripts/test-owner-test-cases-ui.mjs
package.json
business-artifacts/backlog.md
business-artifacts/test-case-search-fix-2026-09-28.md
```

## Verification matrix

| Perspective/check | Result | Scope |
| --- | --- | --- |
| Owner test-search API | PASS | Actual handler: canonical schema, active statuses, reasons, empty results, unknown bookings, read failures, owner authentication and GET-only restrictions. |
| Owner search interaction | PASS | Actual Cases controller with DOM fixture: failure/retry, duplicate clicks, network failure, escaped messages, honest empty state, preserved main list/detail/counts and GET-only requests. |
| Customer/Easer protection | PASS | Search fake rejects mutations; case closure and notification paths are unchanged. Existing Operations Cases security/copy/workflow tests pass. |
| Production evidence | PASS | Read-only API and database checks reproduce the typo and verify the correct table/query. No production application fix claimed. |
| Browser visual check | WARNING | Browser automation repeatedly timed out. A local fixture using actual owner markup, controller and CSS is prepared outside the repository, with fictional data and network blocked; no rendered responsive pass is claimed. |
| Full launch suite | PASS | `npm run test:launch` exited 0, including lint and the new controller test. Changed JavaScript syntax, diff hygiene, and additional SEO/sitemap/phone/Sora CI checks also pass. |
| Production rollout | BLOCKED | At audit time GitHub's required check could not start because of an account billing lock. This fix is isolated from PR 226. |

## Deployment and remaining limits

No schema migration or live record repair is required. No pricing, payment, payout, fee or notification behavior changes. Merge only after required checks pass and verify the production GET plus the Cases utility. Retain a browser verification warning until the connected browser is available. The search remains a heuristic over its existing capped case selection; finding no matches is not proof that all cases are real.

The payment/dispatch policy recommendation and the exhaustive platform UX/IA audit remain separate work.

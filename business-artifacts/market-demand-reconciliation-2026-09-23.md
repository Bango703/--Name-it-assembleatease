# Market Demand reconciliation — September 23, 2026

## 1. Executive summary

The first local fix restored omitted readiness inputs, but it did not resolve the geographic mismatch or stale dashboard snapshots. Market Demand grouped Easers and bookings by typed city while dispatch uses the canonical ZIP-based service markets. Those definitions disagree for surrounding cities such as Pflugerville and Austin. This is a P1 owner-operational defect: an eligible local Easer can disappear from the area's supply count.

The smallest safe correction is one reporting bucket per existing service market, shared roster/readiness definitions, complete paged reads, visible location exceptions, and a refreshed atomic dashboard snapshot. Do not change dispatch coverage, booking availability, profiles, or payment rules.

## 2. PASS / WARNING / FAIL matrix (before the local correction)

| Workflow | Audit result | Finding |
|---|---|---|
| Owner: area counts | FAIL | Exact typed-city joins disagree with canonical ZIP service areas. |
| Owner: freshness | FAIL | No periodic/focus refresh, relevant Easer mutations do not invalidate the market snapshot, and old responses can overwrite newer data. |
| Owner: missing data | FAIL | A failed profile read looks like zero; profiles with incomplete location disappear. |
| Owner: reconciliation | FAIL | Only the top 12 area cards render while totals include additional areas; profile reads can hit the provider row cap. |
| Easer: eligibility | WARNING | Complete readiness fields now exist locally; report must also normalize account state like the roster. |
| Customer: assignment | PASS for scope | This reporting change must preserve existing dispatch and booking rules. It does not prove that a particular Easer can take a particular appointment. |
| Financial state | PASS for scope | No charge, refund, fee, earnings, or payout mutations are needed. |

## 3. P0 issues

No new direct payment, payout, authentication, or booking-mutation defect was found in this bounded reporting review. Misleading supply can still cause an owner to promise coverage or spend marketing money in the wrong area, so the P1 findings need correction before relying on this view.

## 4. P1 issues

1. **Geographic mismatch:** profile home city is not the service-area definition. Use `marketForZip` from `_source-of-truth.js` for known regions. Never use the fail-open `isSameServiceMarket` helper to infer reporting coverage for unknown ZIPs.
2. **Hidden or inconsistent people:** missing locations are skipped, raw states such as `Texas` can normalize incorrectly, and raw profile statuses differ from the roster's normalized statuses. Keep every unique profile in one visible reporting bucket and use the roster normalization before canonical readiness.
3. **False zero on source failure:** profile/waitlist failures need independent availability flags and unknown counts. A warning beside a zero is not enough.
4. **Stale and racing snapshots:** reload after relevant owner mutations, poll while this view is visible, refresh on focus, and commit only the newest request. Counts and people lists must represent the same response.
5. **Truncated reporting:** fetch complete profile/waitlist pages and render every returned market rather than silently limiting the display to 12.
6. **Ambiguous count definitions:** approved accounts, eligible Easers, and available-for-offers Easers are nested but distinct groups. `is_available` is an availability setting, not browser presence or proof that an Easer is free for a specific appointment. Live Ops also excludes assigned work from its free count.

## 5. P2 issues

Show snapshot time, recorded home location, eligibility blockers, and location-review reasons in drilldowns. Keep Live Ops offline totals visible even when its online list is empty.

## 6. Business impact and read-only production evidence

The production profile read returned 11 Easer records: five normalized active, one pending, two suspended, and three rejected. The five eligible records all currently have availability enabled. The waitlist query returned zero rows. These are point-in-time database observations, not a guarantee of service-date or skill coverage.

| Existing canonical service area | Eligible Easers | Availability enabled |
|---|---:|---:|
| Austin / Central Texas | 1 | 1 |
| San Antonio area | 2 | 2 |
| Houston area | 1 | 1 |
| Lubbock area | 1 | 1 |
| Permian Basin | 0 | 0 |
| **Total** | **5** | **5** |

An additional pending application has recorded Caddo Mills, TX 75135, outside the currently configured ZIP-prefix regions. It must remain visible as recorded-location supply with unverified area coverage; it must not be treated as an Austin Easer or discarded. Stored location inconsistencies should be explained rather than silently rewritten. No live profile was edited.

The owner is directly affected through staffing, recruitment, and advertising decisions. Customers and Easers are indirectly affected if the owner assumes unverified coverage. The report does not itself move money, strand a booking, create a payout, or change contractor/legal terms. It must avoid presenting potential regional supply as a guaranteed individual service commitment.

Relevant review perspectives: Marketplace Operations and Data require reconcilable people lists; UX requires honest freshness and error states; Security requires the existing owner gate; Payments requires no financial mutation; Supply and Customer Experience require no unsupported coverage promise.

## 7. Recommended fix order

1. Shared market-area resolver and normalized readiness, with complete reads and explicit source failures.
2. Reconciled counts and drilldowns, including unconfigured and missing locations.
3. Frontend refresh, request ordering, complete-area display, and clear count definitions.
4. Behavioral API/frontend tests, production read-only comparison, browser desktop/mobile check, and launch regressions.

## 8. Files / APIs involved

- `api/_market-area.js`: reporting geography from the existing canonical ZIP markets.
- `api/owner/market-demand.js`: authenticated, read-only market aggregation and source status.
- `owner/index.html`: Market Demand rendering and refresh lifecycle; narrow Live Ops empty-list count presentation.
- Existing truth, read-only dependencies: `api/_source-of-truth.js`, `api/_booking-location.js`, `api/_assembler-state.js`, `api/_easer-readiness.js`.
- Behavioral tests: `scripts/test-market-area-reconciliation.mjs`, `scripts/test-market-demand-refresh.mjs`, existing related dashboard guards.

## 9. Test plan and implementation receipt

Local implementation is complete. The existing owner authentication gate remains; the handler factory permits isolated boundary testing, not a second deployed endpoint.

| Verification | Result |
|---|---|
| Actual handler, projected database fields, canonical readiness | PASS |
| Canonical region membership and five visible configured areas | PASS |
| Unique-profile counts, malformed locations, normalized roster states | PASS |
| More than 1,000 profiles with a smaller provider page cap; failed/duplicate/changing pages | PASS |
| Independent profile/waitlist failures produce unknown counts | PASS |
| Complete area rendering and explanatory people drilldowns | PASS |
| Refresh race, Easer mutation refresh, visible polling/focus, stale/failure snapshot handling | PASS |
| Full `npm run test:launch`, including both new market suites | PASS |
| 58 changed JavaScript files; 776 inline blocks across 427 pages | PASS |
| Desktop and exact 390 px browser fixtures, including expanded people/blocker lists | PASS; no horizontal overflow |

At **2026-09-23 14:45:25 UTC**, the new local handler ran against read-only production queries. All four sources were available. It returned 11 unique profiles, five approved/eligible/availability-enabled profiles, one pending application, and zero waitlist entries. Every area's profile, approved, eligible, availability and pending counts summed exactly to the corresponding global total. This verifies the new aggregation against current records; it is not a test of a deployed owner endpoint. No live record or message was changed.

Independent review also caught and corrected two demand-count defects: terminal jobs no longer count as needing assignment within area cards, and distinct confirmed jobs or jobs at different times/addresses are no longer collapsed as failed booking retries.

Browser QA used actual production markup, renderers and styles with fictional records; it did not use authenticated production APIs. The browser was restored and the local fixture server stopped. No code changed after the passing launch check.

A bounded pre-existing exception is tracked as M02 in the single backlog: the roster normalizes legacy stored tier `verified` to `professional`, while automatic dispatch filters raw tiers before normalization. No current affected live eligible record was identified. This market report does not change dispatch tier rules.

## 10. Launch recommendation

Do not rely on the current deployed Market Demand totals for staffing or advertising decisions until the corrected report is deployed and checked. Local implementation and validation do not change production. The user subsequently authorized push/deployment. Production prerequisite 046 and migration 096 are applied and verified; the combined application release proceeds through the protected GitHub checks. No customer/Easer record was altered and no test message was sent. See the release receipt and pull request for publication status.

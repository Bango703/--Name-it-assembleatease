# Marketplace Geography, Eligibility & Dispatch Contract, v1.0

Status: **proposed by the owner, 2026-11-13. Target, not a description of today's system.** What exists today, measured against this contract, is in `docs/decisions/2026-11-13-dispatch-contract-audit.md`. Policy items that need the owner's explicit approval (section 11.4) are listed there.

Scope: customer booking, geographic coverage, Easer eligibility, offers, bidding, assignment, notifications, payments, status synchronization. Preserve existing production behavior until dependency audit, tests, and authorized migration.

## 1. Non-negotiable invariants
1. One booking has one canonical record and one authoritative lifecycle. UI components are projections; they do not independently own booking state.
2. A job can have multiple invitations/offers but at most one active confirmed assignment unless explicitly modeled as a multi-crew job with separately scoped work packages.
3. A customer ZIP code is a postal attribute, not proof of service availability, worker eligibility, or city membership.
4. No invitation or assignment to an Easer without verified required skills, approved geographic coverage, active eligibility, and compatible time/crew capacity.
5. An invitation is NOT an assignment. A read notification is NOT acceptance. A bid is NOT a confirmed award.
6. Offers and awards reference a particular immutable scope/pricing revision. Material revisions invalidate or revalidate prior offers.
7. Payout, fees, tax, promotions, rewards, and processor costs are separate amounts with explicit ledgers. Never compute payouts from tax-inclusive totals by accident.
8. Customer pricing and changes require explicit customer agreement; a contractor bid may not silently change customer price.
9. Notifications use a transactional outbox and idempotent delivery; messages may be retried without redoing the underlying business action.
10. The server authorizes every state transition; never trust the frontend, notification payload, cache, or AI interpretation as authority.
11. Every workflow has timeouts, retries, exception states, and an operations fallback. No booking disappears silently.
12. Never automatically change coverage, worker status, service eligibility, pricing rules, or payouts as a side effect of unrelated UI changes.

## 2. Geographic model
- market: business operating unit (e.g., Austin Metro); status planned | limited | active | paused.
- dispatch_zone: polygons or carefully governed ZIP sets, linked to market; includes active dates, priority, pricing and escalation policies. Zones can overlap; deterministic resolution needed.
- postal_code: validated address attribute, text (retain leading zeroes); may be linked to zones for candidate lookup but should not alone determine final geographic match.
- service_address: normalized address, provider metadata, latitude/longitude with precision and quality status; apartment/unit and access info kept separately.
- easer_coverage: worker-authorized zones, polygons or travel limits, service-specific exclusions, explicit availability and travel preferences.
- serviceability: separate customer-facing market_supported from job_fulfillable_now; coverage does not promise available workers.

Resolve location:
1. Collect complete address, with consent and provider-appropriate handling.
2. Validate address; prompt for correction when incomplete or low confidence.
3. Geocode to a physical point and save accuracy metadata.
4. Resolve market and active dispatch zone using approved geographic rules; use ZIP as additional index/quick-check.
5. Check whether service and requested time are supported in that market.
6. Build eligible Easer pool; if zero, report NO_ELIGIBLE_EASERS separately from OUTSIDE_SERVICE_AREA.
7. Recheck eligibility at actual offer acceptance or award commitment.

Avoid converting city names directly to administrative coverage and avoid assuming ZIP codes match municipal limits. Postal codes can change. For polygon containment including a boundary, PostGIS ST_Covers is appropriate.

## 3. Job definition and dispatch types
Every booking captures service_code, scope_revision, required skill_codes, required crew count, verified documents/photos, service address, requested date window, customer quote, Easer payout floor/policy, market/zone, and dispatch policy version.
- INSTANT_SEQUENTIAL: invite one eligible Easer at a time, expiry and next-in-line.
- INSTANT_BATCH: invite limited eligible group; server grants first valid atomic acceptance.
- SEALED_OFFERS: invite qualified Easers, receive private offers until deadline, check payout and scope, rank and award. Human review for high-risk work.
- COMMERCIAL_DISPATCH: account-specific preferred network and SLAs, fallback pools, verified crew scheduling.
- MANUAL_REVIEW: unusual, insufficiently scoped, regulated, high-risk, or unserviceable work.

Routing must be chosen from configuration by service + complexity + market + customer account + risk, not just price or ZIP.

## 4. Candidate eligibility: hard filter then ranking
Hard filters (must all pass as applicable): account_active, identity/onboarding approved, required skill and legal authorization, insurance where required, customer address within approved coverage, service-specific qualifications, necessary crew and tools, available time, no conflicting confirmed commitments, required payout floor feasible, no blocking safety issue, commercial-account authorization where relevant.

Ranking only among eligible candidates: verified quality, relevant experience, reliability of accepted commitments, travel time, availability alignment, workload balance, declared price for bid jobs. Weights must be versioned, explainable, audited, and testable. Never use score to override failed eligibility.

Declining an optional invitation is not equivalent to cancelling an accepted job. Avoid disciplinary policies that create contractor-classification risk; obtain legal review.

## 5. Core state machine
Suggested canonical states: DRAFT -> ADDRESS_VALIDATED -> SCOPE_VERIFIED -> QUOTE_PRESENTED -> CUSTOMER_APPROVED -> DISPATCH_READY -> OFFERING | BIDDING_OPEN -> AWARD_PENDING -> ASSIGNED -> IN_PROGRESS -> COMPLETION_REVIEW -> COMPLETED -> PAYOUT_PENDING -> PAID.

Exception states with guarded recovery: ADDRESS_REVIEW, OUTSIDE_SERVICE_AREA, NO_ELIGIBLE_EASERS, OFFERS_EXHAUSTED, OFFER_EXPIRED, ASSIGNMENT_DECLINED, REASSIGNMENT_REQUIRED, CUSTOMER_ACTION_REQUIRED, CANCELLED, DISPUTED, REFUND_PENDING, PAYMENT_FAILED.

Do not equate payment state with booking state. Maintain separately linked payment state and transfer/payout state; no unsupported capture window assumptions.

For every transition record: actor/service, previous and next state, timestamp (UTC), reason code, correlation ID, scope version, policy version. Guard illegal transitions server-side.

## 6. Offer and assignment lifecycle
1. A booking becomes DISPATCH_READY after scope, quote, eligibility policy and payment prerequisites pass.
2. Dispatcher creates an offer batch tied to scope version and candidate eligibility snapshot.
3. Offers are persisted BEFORE notifications. An outbox event is committed in same transaction.
4. Worker receives an offer in the Easer portal; push/email/SMS are supplemental. The portal always queries authoritative current state.
5. On accept, server rechecks invitation expiry, worker eligibility and booking state. Atomic transaction sets unique assignment/commit; competing accepts fail gracefully.
6. System writes assignment event and outbox events. Customer, Easer and admin views update from canonical state or subscribed events.
7. On expiry/non-response, time-based worker escalates according to versioned dispatch policy; no endless loops or unbounded blasts.
8. On accepted-job cancellation, start separate reassign procedure and notify customer honestly.

One implementation strategy: DB transaction with row-level lock / optimistic concurrency and partial unique index enforcing only one active assignment per booking. Multi-crew bookings require explicit structured assignment slots/roles; do not bypass invariant.

## 7. Commercial and complex bids
Customer accepts fixed AAE quote. SEALED_OFFERS jobs invite qualified crews. An Easer submits payout amount, team, scheduling, scope acknowledgment and optional notes. Others' bids are not visible before closing. On close, reject invalid bids, validate floor and margin, rank qualified offers, approve high-risk awards manually. Selected crew confirms under written terms; rejected offers are notified after award. Bid pricing cannot silently add to customer quote. Scope changes create a revised quote and matching offers.

Illustrative six-box playground: $2,495 customer service amount, minimum payout at 70% of service amount ($1,746.50), selected crew offer $1,825, platform gross share $670 (before costs/tax). These values are examples, not production price policy. Manufacturer instructions, crew experience, site conditions and anchoring are mandatory checks.

## 8. Notifications and sync
- Use an event/outbox table with unique idempotency key (booking_id, event_type, revision, recipient, channel as appropriate).
- A retryable worker sends email, push, SMS and in-app notifications; records provider acceptance, delivery results when available, failures and retry count.
- Never change booking status because a message was sent or read.
- Dashboard state comes from canonical query/API and realtime event invalidation; background reconciliation repairs missed events and detects stale caches.
- Reconciliation alerts for assigned bookings with no Easer, offers after cancellation, lost payment webhooks, conflicting statuses, or undelivered essential notifications.
- Restrict pre-award customer identity and contact details; support legitimate task information safely.

## 9. Suggested data entities (names illustrative)
markets, dispatch_zones, zone_postal_codes, service_addresses, easer_coverage, easer_skills, easer_availability, service_catalog, service_skill_requirements, bookings, booking_scope_revisions, dispatch_policies, dispatch_runs, dispatch_candidates, job_invitations, easer_offers, assignments, assignment_history, booking_events, notification_outbox, notification_deliveries, payment_intents, transfers, payout_ledger, audit_log, customer_change_orders.

Use stable IDs, foreign keys, status constraints, timestamps and indexes; do not create duplicate sources of truth merely because separate user dashboards exist.

## 10. Decision examples
- A: Customer in 78745 requests bed assembly; zone covered. Easer A qualified+available, B TV-only, C qualified in neighboring approved zone, D unavailable. Invite A and possibly C per policy. B and D excluded. Only one atomic winning acceptance.
- B: 6-box playground requires two-person crew and verified experience. Send sealed offers to approved crews; do not invite a solo bed assembler based solely on proximity. Manual award review.
- C: Valid ZIP but address point outside active polygon: mark as ADDRESS_REVIEW or out of coverage according to confidence/policy, not automatic acceptance.
- D: Zero eligible Easers: NO_ELIGIBLE_EASERS; do not notify unqualified workers. Consider waitlist, a truthful time alternative, recruitment signal, or admin escalation.
- E: Offers sent but no accept: OFFERS_EXHAUSTED, not equivalent to no workers. Expand only to worker-opted-in adjacent zones under payout and SLA rules.
- F: Two Easers accept at same time: server commits exactly one assignment; the other gets a clear 'already assigned' response.
- G: Scope changed after offers: freeze dispatch, issue revised scope/quote, invalidate or reconfirm affected offers, prevent old version from winning.
- H: Easer accepts then cancels: preserve old assignment/audit record, open reassign workflow and accurate customer notifications.

## 11. Agent change protocol (mandatory)
Before editing code:
1. Inspect architecture and existing code paths for booking creation, geocoding, quoting, invitations, assignment, notification providers, webhooks, Easer and customer dashboard data.
2. Trace one actual booking ID end to end in a staging/test environment. Identify source of truth and dependency graph. Identify undocumented rules and duplicate state ownership.
3. State precisely which invariants are affected, planned schema/API changes, backfills, migrations, rollback procedure, security considerations, and test cases.
4. Ask for explicit approval before production mutations, destructive migrations, dispatch-policy changes, mass notifications, fee changes, or worker-impacting changes.
5. Implement behind feature flags with a market/service-level pilot. Preserve legacy behavior for other traffic.
6. Run unit, integration, concurrency, regression, end-to-end, and webhook retry tests. Include stale-cache and partial-failure tests.
7. Verify customer, Easer and admin projections agree on state, and reconcile event counts against database records.
8. Document changes to this contract and create a decision record; do not silently change policy.

Prohibited shortcuts:
- No hardcoded ZIP arrays in frontend or duplicate area lists across services.
- No UI-specific ad hoc worker matching.
- No auto assignment from 'notification sent' or 'offer opened'.
- No payout calculation from unverified client-supplied numbers.
- No background job that silently changes booking status without audited event.
- No treating a README or this Markdown file as a runtime source of truth.
- No making an LLM the final arbiter of eligibility, authorization, assignment or money movement.

## 12. Operational dashboard and alerts
Track: customer coverage by ZIP and polygon, bookings per service/market/zone, eligible Easer density, first-offer latency, notification delivery rate, offer acceptance rate, time to assignment, no-coverage vs no-available-supply, cancellation/abandonment, completed jobs, job-level contribution margin, payout delays, unmatched state events, scope amendments, and commercial SLA compliance.

Alerts: dispatch-ready booking without an active workflow, expired open invitation, too many retries, accepted job without canonical assignment, duplicate active assignment, unqualified award, customer-paid but unfulfilled work, stuck payout, status divergence, outbox backlog.

## 13. Suggested architecture, not a required technology mandate
- Relational database (PostgreSQL) is authoritative; PostGIS if polygon coverage is needed.
- Address validation/geocoding provider; optional route-time matrix when it materially improves matching.
- Domain services: CoverageService, EligibilityService, DispatchPolicyService, OfferService, AssignmentService, NotificationService, PaymentsService.
- Durable queue/workflow runner for timeouts and retries. A simple reliable DB-backed queue can work at small volume; a dedicated workflow engine is optional at scale.
- Transactional outbox, audit/event history, idempotent consumers, transactional assignment uniqueness.
- Admin tooling to manage markets/zones/coverage/skills/policies, monitor exceptions and override with reason codes.

## 14. Questions to resolve from the real system
Answered for today's system in `docs/decisions/2026-11-13-dispatch-contract-audit.md`. Still open: contract terms that permit or restrict ranking, bids and cancellation handling (legal review).

## Research references
- USPS ZIP Code Basics: https://faq.usps.com/articles/Knowledge/ZIP-Code-The-Basics
- Google Address Validation: https://developers.google.com/maps/documentation/address-validation/overview
- Google Routes Matrix: https://developers.google.com/maps/documentation/routes/compute_route_matrix
- Bringg Service Areas: https://help.bringg.com/docs/service-areas
- Bringg Skills: https://help.bringg.com/docs/set-up-skills
- Onfleet Auto Assignment: https://support.onfleet.com/hc/en-us/articles/360023669852-Auto-Assignment
- PostGIS ST_Covers: https://www.postgis.net/docs/ST_Covers.html
- Temporal workflow background: https://docs.temporal.io/tasks

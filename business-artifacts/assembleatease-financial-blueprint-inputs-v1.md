# AssembleAtEase Financial Blueprint Inputs - V1 Draft

These are draft operating assumptions for Theodore to use in a first financial model. They are not final prices, legal policies, or proven labor data. The labor estimates should be validated against actual Austin jobs during launch.

## Catalog Coverage Status

- Current booking catalog rows: 202
- Labor-assumption rows modeled in the V1 CSV: 178
- Current low-priced non-add-on services under $99: 41
- Current custom-quote rows: 3
- The V1 labor CSV is not a pricing source of truth. The 24-row coverage gap must be modeled and all labor assumptions must be validated against actual Austin jobs before they are used for automated pricing decisions.

## Service Area Rules to Model

| Zone | Coverage | Rule |
| --- | --- | --- |
| Core Austin | Austin 787xx and close-in routes | No travel surcharge; $99-$119 minimum booking. |
| Near suburbs | Round Rock, Pflugerville, Cedar Park, Leander, Lakeway, Bee Cave, Buda, Kyle, Georgetown | No standalone quick jobs unless bundled; minimum target $149 or travel surcharge. |
| Far or high-traffic routes | 25+ miles, 45+ expected drive minutes, or uncertain parking/access | Custom quote or owner approval before confirmation. |

## Easer Pay Philosophy

- Do not promise one flat payout percentage across every service.
- Use a job-level payout shown as a flat dollar amount in the Easer offer.
- Internal formula: customer price minus payment processing, rework reserve, and target platform gross equals maximum Easer payout.
- Sanity check every payout against estimated labor time so Easers can still earn attractive effective hourly income.
- Complex jobs should pay strong dollars to Easers while still protecting platform gross.

## Cancellation and Refund Rules Already Present in Current Platform Draft

| Situation | Current draft rule |
| --- | --- |
| Customer cancels more than 24 hours before service | No charge; card hold released. |
| Customer cancels less than 24 hours before service | 10% of the pre-tax service subtotal, excluding the service-call fee. |
| Customer cancels within 2 hours, after the Easer is en route, or no-shows | 15% of the pre-tax service subtotal, excluding the service-call fee; never the full unperformed service amount. |
| Customer dissatisfied | Customer must contact within 7 days; company may offer redo, partial refund, or full refund. |
| Refund processing | Owner can issue full or partial Stripe refund after payment capture. |

## Damage Claim Process to Model

1. Easer reports damage immediately through the platform with photos.
2. Customer submits claim and photos within 7 days.
3. Owner reviews job evidence, messages, before/after photos, and scope.
4. Company decides redo, partial refund, full refund, service credit, Easer chargeback/withheld payout, or insurance escalation.
5. Financial model should set aside 1%-3% of revenue as rework/damage/refund reserve.

## Customer Acquisition Plan for First 100 Customers

| Channel | Launch action | Why it matters |
| --- | --- | --- |
| Google Business Profile | Build reviews, photos, weekly posts, service keywords | Highest-intent local demand. |
| Local SEO/service pages | Keep Austin pages for furniture, TV, smart home, fitness, outdoor, office | Compounds over time. |
| Founder-led outreach | Realtors, apartments, property managers, designers, office managers | Low CAC, higher repeat potential. |
| Referral offers | Post-completion referral link/discount | Turns every job into acquisition. |
| Paid search test | Small capped campaigns only after margins are modeled | Prevents paid ads from eating low-margin jobs. |

## Business Account Revenue Model

- Target accounts: apartment communities, property managers, realtors, interior designers, office managers, furniture stores, short-term rental operators.
- Separate residential from business-account economics. Business accounts may have lower CAC, higher repeat rate, higher average ticket, and more predictable routing.
- Suggested offers: move-in assembly packages, turnover repair/assembly, office setup days, model-unit setup, bulk furniture install days, preferred vendor agreement.

## Monthly KPI Targets for Austin Launch

| KPI | Early target |
| --- | --- |
| Average ticket | $149+ target, with no standalone checkout below the zone minimum |
| Platform gross per completed job | $35+ minimum, $50+ blended target |
| Rework rate | Under 5% |
| Refund rate | Under 2% |
| Customer rating | 4.8+ |
| Easer acceptance rate | 80%+ |
| Repeat/referral bookings | Rising monthly |
| Revenue per active Easer | Track weekly; avoid recruiting faster than demand |
| Dispatch time for confirmed jobs | Same day for normal jobs; urgent manual review for same-day bookings |

## Expansion Exit Criteria

Do not expand beyond Austin until the business has:

- 250+ completed Austin jobs.
- 4.8+ average customer rating.
- Positive operating profit after CAC, support, software, insurance, and reserves.
- Rework rate under 5% and refund rate under 2%.
- 10+ active Easers with reliable acceptance/completion.
- Stable dispatch process with no recurring manual bottleneck.
- Documented service-level profitability by category.

## Important Platform Conflict Status

- Earlier drafts conflicted on Easer payouts and application fees.
- Current intended launch assumption: manual payouts are allowed and Stripe Connect is optional when enabled and tested.
- Current intended launch assumption: Founding Easer application fees may be waived; if a fee is charged, the submission-time fee terms control.
- This should still be reviewed by counsel before broad launch, but the operating model should assume manual payouts for the first 25 jobs unless Stripe Connect is deliberately enabled and reconciled.

## Files Provided

- assembleatease-service-labor-assumptions-v1.csv: full service catalog with rough labor estimates, pricing bucket, target gross, and recommended pricing action.

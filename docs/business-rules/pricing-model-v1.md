# Pricing model v1

Status: **proposed, 2026-11-13; revised the same day after reviewing an outside proposal (schedule A, profitability floor, tax table, quote records, release gates adopted from it).** The numbers in section 4 take effect only after the owner approves them (dispatch contract 11.4: fee changes need explicit owner approval). Evidence: `docs/decisions/2026-11-13-custom-quote-take-rate-research.md`.

Owner goal (2026-11-13): high demand, affordable, out-do every competitor.

## 1. The position: the lowest final price among trusted options

- Win on the number the customer pays, against TaskRabbit, Best Buy (Geek Squad), IKEA assembly, Mr. Handyman and other franchises.
- Do not chase the cheapest price in Austin. An unvetted, uninsured handyman has no fees and no guarantee; matching that price means underpaying Easers, losing them, and having no jobs at any price. Customers pay about 10% more for trust, not 40-55% (research section 2).
- Never call the brand cheap, budget or discount (CLAUDE.md, premium positioning). "Affordable", "flat price", "know the price before you book" are the words.

## 2. Five rules

1. **Win on the final number.** Every catalog price sits at or below TaskRabbit's Austin all-in and below Best Buy and franchise rates. Checked monthly (section 8).
2. **One flat price, upfront.** Service subtotal, tax on its own line, total. No hourly meter, no fee line, no surprise charges (Rule 9; research section 5).
3. **The platform's cut shrinks as the job grows,** with a dollar minimum on small jobs (section 4).
4. **Easers are paid fairly and exactly.** On a custom quote the Easer's price is their pay. Catalog Easer pay stays at or above what Austin Taskers keep for the same work.
5. **Win on speed and certainty when prices are close.** Quotes out in minutes, a booked and confirmed pro, the work guaranteed.

## 3. Catalog pricing

- **No change now.** Most items sit at or below the clearest retail anchors (research table "Catalog pricing"): TV 56-65" $149 vs Best Buy $179.99; smart thermostat $99 vs Geek Squad $129.99; hardwired doorbell $119 vs $149.99; dresser $109 vs about $114-150.
- Keep the 30% split (`computeBookingSplit`, `getPlatformFeePct`) and the minimum pre-tax booking ($129 Austin, $149 elsewhere, `MIN_PRETAX_BOOKING_BY_ZONE`). At $129 the platform keeps $34.35 after card fees, above the cost floor.
- Watch two prices against real bookings: TV plus in-wall concealment (about $48 above Best Buy's package) and treadmill assembly (above the Thumbtack average).

## 4. Custom quotes from Easer prices (proposed numbers)

Today (verified in code, live since #445): `customerQuoteForEarnings` in `api/booking/_quote-offers.js` sets the subtotal to the Easer's price divided by 0.7, so the platform keeps 30% of the subtotal and adds 42.9% on top of the Easer's price at every size.

The fee works like tax brackets on the Easer's price: each rate applies only to its slice, so a bigger price never costs the customer less. Two schedules are on the table; the owner picks one.

**Schedule A (board default since 2026-11-13 review): affordable at every size.** Rates are added on top of the Easer's price.

| Slice of the Easer's price | Platform adds |
|---|---|
| First $200 | 28% |
| $200 to $800 | 20% |
| $800 to $2,000 | 12% |
| Above $2,000 | 8% |

**Schedule B (first draft): catalog-equal on small quotes, stepped down above $500.** First $500 adds 43% (30% of that slice of the subtotal, the catalog split); $500 to $1,500 adds 25%; above $1,500 adds 15%.

Rules for either schedule:
- **Minimum platform fee:** $45. The subtotal is never below the zone's catalog minimum.
- **No dollar cap.** Card fees grow with the job; a capped fee does not. With a $450 cap, card fees pass the fee at about a $14,300 subtotal, and at the $25,000 quote maximum (`MAX_QUOTE_CENTS`) the platform would lose about $275 on card fees alone.
- **Profitability floor (section 4a) overrides the schedule.** A quote that does not clear it is held, never sent.
- **Owner adjustment:** the owner may lower one quote's fee down to the profitability floor, never below it. Every cut records a reason; the owner sees how often cuts happen.
- **Money is whole cents** (integer arithmetic, as the code does today). Tax is calculated exactly; the subtotal is never rounded in a way that changes Easer pay.
- **Easer pay:** exactly the Easer's price.

Worked examples (estimates; card fee 2.9% + $0.30 on the tax-inclusive total, which is how Stripe charges):

| Easer price | Total today | Total, A | Total, B | Platform after card fees: today / A / B |
|---|---|---|---|---|
| $150 | $231.97 | $211.09 | $231.66 | $57.26 / $38.58 / $56.98 |
| $400 | $618.57 | $536.92 | $618.11 | $153.19 / $80.13 / $152.77 |
| $1,200 | $1,855.72 | $1,541.48 | $1,720.09 | $460.17 / $179.00 / $338.82 |
| $3,000 | $4,639.28 | $3,680.50 | $3,993.34 | $1,150.87 / $292.97 / $572.89 |

Against Austin anchors (research, pre-tax): A puts a $1,200 gazebo-kit price inside the $600-$1,500 labor range ($1,424); B and today do not. Both A and B sit mid-range on $3,000 office and shed work. A earns less per quote: it matches today's profit only if it wins about 2.6 times as many $1,200 quotes and about 3.9 times as many $3,000 quotes. Watch item for A: between about $105 and $500 an Easer-priced quote comes out cheaper than the same work at the catalog's 30% split.

What flips the choice: after the first 10 custom quotes, more than half accepted at A means A leaves money on the table (move toward B); quotes still declined for price at A mean the Easer prices are the problem, not the fee.

Building it: `normalizePlatformFeePct` in `api/_source-of-truth.js` accepts only 30% or 25%. The stepped fee is stored on each quote as a dollar fee with Easer pay fixed at the price. That file is a critical module (Article 10): audit before code, and tests at $0, $200, $800, $2,000, the minimum, and odd cents proving the Easer is paid exactly the price, the fee never falls below the floor, and tax is exact.

## 4a. Profitability floor

Before any quote is sent, the server computes the expected contribution: platform fee minus card fees on the actual charge, payout fees, and owner-set reserves (support, rework and dispute, acquisition) per service category. The owner sets the minimum in dollars and as a share of the subtotal. A quote below either is held for the owner: change the scope, the Easer's price, or the fee within limits. Reserves start as owner-entered estimates, marked as estimates, and are replaced by measured rates once jobs exist. Never lower an accepted Easer price or exceed an approved customer quote.

## 5. How Easers price

- An Easer's price is **the take-home pay they want for the labor**: hours times people times their rate. No materials, no fee, no tax; the platform adds those. The form already asks for hours and crew.
- Austin Taskers keep $43-$64 an hour. $45-$65 per person-hour is competitive.
- The owner's quote window shows the price per person-hour and flags anything above **$75 per person-hour** (where the customer price passes the $106/hr franchise rate). Guidance only; Easers set their own prices and the owner may decline one.
- One promise to Easers, never more: **your price is your pay.**

## 6. What the customer sees

- One quote: service subtotal, Texas sales tax on its own line, total. No "platform fee" or "service fee" line (Content Design seat; research section 5).
- A quote declined for **"Price is too high"** keeps the booking open for a new quote instead of closing it; the owner can lower the fee to the floor or ask the Easer for a lower price.
- Large quotes (about $1,000 and up): written scope and before-and-after photos before capture, because one lost dispute on a $3,993 job costs the margin of about seven such jobs.

## 7. Agents: what may run automatically

| Layer | What it does | Runs on its own? |
|---|---|---|
| Fee rules (code) | Applies section 4 to every quote on the server | Yes. Deterministic, tested, audited (Rule 4) |
| AI quote advisor | Reads the request, writes the scope with contact details removed, asks the area's Easers, picks a price, drafts the quote with a one-line reason | Drafts automatically; the owner taps Send |
| Automatic sending | Sends low-risk drafts without the owner: total under about $500, a known kind of job, a clear scope, an Easer price in hand | Built behind a switch, off until about 20 drafts went out with 90% unchanged |
| Weekly pricing review agent | Reads quote outcomes (sent, approved, declined and why), catalog conversion and competitor prices; opens a pull request with proposed changes and reasons | Proposes only; the owner merges (same pattern as the blog engine) |

No agent changes a live price, a fee or Easer pay without the owner's approval. Every agent decision is logged.

## 8. Review triggers

- After the first 10 custom quotes: if more than half sent at the schedule are accepted, raise the top step; if fewer than a third are accepted and lost quotes cite price, lower the middle step and use the floor more.
- Monthly: catalog prices against TaskRabbit Austin, Best Buy and franchise anchors.
- A damage or dispute rate above about 2% on large jobs raises the floor.
- Repeat customer and Easer pairs on custom work get a standing lower rate if side deals appear.

## 9. Open questions (owner to take to a CPA)

| Question | Why it matters |
|---|---|
| Which services are taxable in Texas: mounting a customer-owned TV, smart thermostat, doorbell and lock installs, playsets, sheds and gazebos, office installs? | Furniture and equipment assembly **is taxable** (Comptroller Publication 96-259, "Taxable Services", 01/2026, checked 2026-11-13: tax is due on assembling products such as furniture, toys or equipment, even when the customer supplies them). Residential installation and real-property labor may not be. Non-taxable services would drop those totals 8.25% at no cost to margin |
| Is AssembleAtEase or the Easer the seller for tax purposes? | Decides who collects and remits |
| What happens to tax already collected on services found non-taxable? | Refund or remittance exposure |
| Does insurance cover property damage on a $3,000+ job? | Risk grows as the cut shrinks |

Keep collecting 8.25% until a written answer arrives; under-collecting a taxable service is the costlier mistake. The answer becomes a versioned taxability table, one row per service, tested before it changes any price. Past over-collection is assessed by the CPA; no automatic refunds.

## 9a. Quote records and release gates

- **Provenance:** every quote stores the pricing schedule version, tax version, Easer price, scope version, fee, card-fee estimate, contribution, owner decision and any override reason, with timestamps. Historical prices are never rewritten.
- **States:** custom quotes keep the existing server states (booking status and payment status, price-offer status, and the Easer stage from `easerRequestStage`). No second quote lifecycle is added beside them (Articles 1-3); a new state is added to the existing machine only when one is missing.
- **Release gates before any fee change goes live:** the boundary tests in section 4; the profitability floor; the tax table for the services affected; Stripe hold, capture and refund paths unchanged and idempotent; test and demo accounts excluded from price requests; owner approval; a switch to turn it off; and the required CI check green (a skipped check is not a pass).
- **Pilot:** an owner-approved start, measured on response time, acceptance, completion, decline reasons, Easer earnings per hour, refunds, disputes and contribution, by price band and service. Ten or twenty-five quotes guide a decision; they do not prove one.

## 10. State

- Built: catalog pricing; custom quotes from Easer prices at a flat 30% (`customerQuoteForEarnings`); hours and crew on every Easer price; one all-in quote display.
- Not built: stepped fee and owner floor (section 4), price per person-hour flag (section 5), "Price is too high" re-quote (section 6), AI advisor, automatic sending, weekly review agent (section 7). Tracked in `business-artifacts/backlog.md` under PRICING-*.

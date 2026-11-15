# Pricing model v1

Status: **section 4 approved by the owner 2026-11-13 and built behind a switch** (dispatch contract 11.4: fee changes need explicit owner approval). The rest is the board's operating policy; items marked "Next" are not built. Evidence: `docs/decisions/2026-11-13-custom-quote-take-rate-research.md`.

Owner goal (2026-11-13): high demand, affordable, out-do every competitor.

## 1. The position: the lowest final price among trusted options

- Win on the number the customer pays, against TaskRabbit, Best Buy (Geek Squad), IKEA assembly, Mr. Handyman and other franchises.
- Do not chase the cheapest price in Austin. An unvetted, uninsured handyman has no fees and no guarantee; matching that price means underpaying Easers, losing them, and having no jobs at any price. Customers pay about 10% more for trust, not 40-55% (research section 2).
- Never call the brand cheap, budget or discount (CLAUDE.md, premium positioning). "Affordable", "flat price", "know the price before you book" are the words.

## 2. Five rules

1. **Win on the final number.** Every catalog price sits at or below TaskRabbit's Austin all-in and below Best Buy and franchise rates. Checked monthly (section 8).
2. **One flat price, upfront.** Service subtotal, tax on its own line, total. No hourly meter, no fee line, no surprise charges (Rule 9; research section 5).
3. **The platform's cut shrinks as the job grows,** with no dollar cap and a profit floor on every quote (section 4).
4. **Easers are paid fairly and exactly.** On a custom quote the Easer's price is their pay. Catalog Easer pay stays at or above what Austin Taskers keep for the same work.
5. **Win on speed and certainty when prices are close.** Quotes out in minutes, a booked and confirmed pro, the work guaranteed.

## 3. Catalog pricing

- **No change now.** Most items sit at or below the clearest retail anchors (research table "Catalog pricing"): TV 56-65" $149 vs Best Buy $179.99; smart thermostat $99 vs Geek Squad $129.99; hardwired doorbell $119 vs $149.99; dresser $109 vs about $114-150.
- Keep the 30% split (`computeBookingSplit`, `getPlatformFeePct`) and the minimum pre-tax booking ($129 Austin, $149 elsewhere, `MIN_PRETAX_BOOKING_BY_ZONE`). At $129 the platform keeps $34.35 after card fees, above the cost floor.
- Watch two prices against real bookings: TV plus in-wall concealment (about $48 above Best Buy's package) and treadmill assembly (above the Thumbtack average).

## 4. Custom quotes from Easer prices (approved 2026-11-13)

Owner approval, 2026-11-13 ("okay good"), after rejecting a capped fee ("I don't want Easer making 15k and business cap at 450") and asking that card processing not come out of the business share. Code: `api/booking/_quote-offers.js` (`quoteNetTakeCents`, `steppedQuoteFeePct`, `customerQuoteForEarnings`, `quoteFeeOptions`). Before this, the subtotal was the Easer's price divided by 0.7 (a flat 30%, live since #445).

**What the business keeps after card fees**, added on top of the Easer's price in slices like tax brackets, so a bigger price never costs the customer less:

| Slice of the Easer's price | Business keeps (after card fees) |
|---|---|
| First $500 | 30% |
| $500 to $2,000 | 20% |
| Above $2,000 | 15% |

- **Card processing is in the customer's price,** never taken from the Easer (Easers keep their price; the Angi Services settlement is the warning). No fee line is shown.
- **No dollar cap.** The business share keeps growing with the job.
- **One whole percent per quote.** The schedule's result is expressed as a whole percent of the subtotal from 10 to 30, rounded up, so the existing percentage-based pay pipeline (split, earnings snapshot, dispatch acceptance, crew pay) pays the Easer at least their price and the business never keeps less than the schedule. The database allows 10 to 30 (migration 131).
- **Owner control:** on one quote the owner may set any whole percent from 15 to 30 that clears the profit floor, with a reason. The server prices each choice; the owner's screen shows them and does no money math.
- **Profit floor (section 4a):** $25 after card fees by default (`QUOTE_MIN_CONTRIBUTION_CENTS`). A quote below it is held, never sent.
- **Switch:** `QUOTE_FEE_SCHEDULE=stepped` turns it on, after migration 131 is applied. Unset, quotes use the flat 30% exactly as before. Setting it back is the rollback.
- **Record:** every quote sent from an Easer's price logs the schedule version, fee, schedule fee, subtotal, tax, total, card-fee estimate, what the business keeps and any fee-change reason.

Worked examples (card fee 2.9% + $0.30 on the tax-inclusive total, as Stripe charges; computed by the code):

| Easer price | Fee | Customer pays | Business keeps after card fees | Before (flat 30%): customer / business |
|---|---|---|---|---|
| $150 | 26% | $219.43 | $46.04 | $231.97 / $57.26 |
| $400 | 26% | $585.15 | $123.27 | $618.57 / $153.19 |
| $1,200 | 23% | $1,687.02 | $309.22 | $1,855.72 / $460.17 |
| $3,000 | 20% | $4,059.38 | $631.98 | $4,639.28 / $1,150.87 |
| $15,000 | 17% | $19,563.25 | $2,504.66 | $23,196.43 / $5,755.58 |

Against Austin anchors (research, pre-tax): a $1,200 gazebo-kit price lands at $1,558 subtotal, near the top of the $600-$1,500 labor range (the flat 30% gave $1,714); $3,000 office and shed work sits mid-range. Before tax the customer pays about 1.35 times the Easer's price on small quotes, 1.30 at $1,200, 1.25 at $3,000 and 1.20 at $15,000; TaskRabbit's fees on top of a Tasker's rate are reported (unverified) at about 1.15 to 1.23 times, so small quotes run a little above it and large quotes near it, with no hourly meter.

Alternatives considered: a 28/20/12/8% schedule with a $450 cap from an outside proposal (cheaper, but the cap loses money above about a $14,300 subtotal and keeps too little on large jobs) and a 43/25/15% draft (catalog-equal on small quotes, above market on large outdoor jobs).

What moves it: after the first 10 custom quotes, more than half accepted means the schedule leaves money on the table (raise the middle step); quotes declined for price mean the Easer prices are the problem, not the fee (section 5).

## 4a. Profitability floor

Built: before a quote from an Easer's price is sent, the server computes what the business keeps after the estimated card fee (`estimateStripeFeeCents`, 2.9% + $0.30 on the total) and holds the quote when it is below the owner-set minimum (default $25). Next: owner-set reserves per service category (support, rework and disputes, acquisition), entered as estimates and replaced by measured rates once jobs exist. Never lower an accepted Easer price or exceed an approved customer quote.

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

Owner, 2026-11-15: not pursued for now. Every service keeps collecting 8.25%.

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

- Built: catalog pricing; the stepped custom-quote fee with card processing in the price, owner fee control (15% to 30%, with a reason), the profit floor and the quote record (section 4, behind `QUOTE_FEE_SCHEDULE=stepped`, needs migration 131); hours and crew on every Easer price; one all-in quote display.
- Not built: price per person-hour flag (section 5), "Price is too high" re-quote (section 6), category reserves in the floor (section 4a), AI advisor, automatic sending, weekly review agent (section 7), the taxability table (section 9). Tracked in `business-artifacts/backlog.md` under PRICING-* and SALES-TAX-TAXABILITY.

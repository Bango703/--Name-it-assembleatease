# Pricing model v1

Status: **proposed, 2026-11-13.** The structure is the board's recommendation; the numbers in section 4 take effect only after the owner approves them (dispatch contract 11.4: fee changes need explicit owner approval). Evidence: `docs/decisions/2026-11-13-custom-quote-take-rate-research.md`.

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

The platform's fee works like tax brackets on the Easer's price. Each rate applies only to its slice, so a bigger price never costs the customer less.

| Slice of the Easer's price | Platform adds | Platform's share of that slice |
|---|---|---|
| First $500 | 43 cents per dollar | 30% (same as the catalog) |
| $500 to $1,500 | 25 cents per dollar | 20% |
| Above $1,500 | 15 cents per dollar | about 13% |

- **Minimum platform fee:** $45 per quote. The quote subtotal is never below the catalog minimum for the zone.
- **Owner adjustment:** the schedule is the ceiling. The owner may lower the fee on one quote down to the larger of $45 or 15% of the subtotal. Every cut records a reason, and the owner sees how often the floor is used.
- **Rounding:** round the subtotal down to whole dollars; the platform absorbs the cents; Easer pay never changes; tax is calculated exactly.
- **Easer pay:** exactly the Easer's price.

Worked examples (estimates; card fee 2.9% + $0.30 on the tax-inclusive total):

| Easer price | Customer total today | Customer total, v1 | Platform after card fees, today | Platform after card fees, v1 | Owner-floor total |
|---|---|---|---|---|---|
| $150 | $231.97 | $231.66 | $57.26 | $56.98 | $211.09 |
| $400 | $618.57 | $618.11 | $153.19 | $152.77 | $509.86 |
| $1,200 | $1,855.72 | $1,720.09 | $460.17 | $338.82 | $1,528.49 |
| $3,000 | $4,639.28 | $3,993.34 | $1,150.87 | $572.89 | $3,821.23 |

The trade: v1 earns the same total only if it wins about 1.4 times as many $1,200 quotes and about 2 times as many $3,000 quotes. Small quotes do not change. Review after the first 10 quotes (section 8).

Building it: `normalizePlatformFeePct` in `api/_source-of-truth.js` accepts only 30% or 25%. The stepped fee is stored on each quote as a dollar fee with Easer pay fixed at the price. That file is a critical module (Article 10): audit before code, and tests proving the Easer is paid exactly the price, the fee never falls below the floor, and tax is exact.

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
| Which services are taxable in Texas: furniture assembly, mounting a customer-owned TV, smart thermostat, doorbell and lock installs, playsets, sheds and gazebos, office installs? | Old rulings say furniture assembly is taxable; residential installation labor and installing items the installer did not sell may not be. Non-taxable services would drop those totals 8.25% at no cost to margin |
| Is AssembleAtEase or the Easer the seller for tax purposes? | Decides who collects and remits |
| What happens to tax already collected on services found non-taxable? | Refund or remittance exposure |
| Does insurance cover property damage on a $3,000+ job? | Risk grows as the cut shrinks |

Keep collecting 8.25% until a written answer arrives; under-collecting a taxable service is the costlier mistake.

## 10. State

- Built: catalog pricing; custom quotes from Easer prices at a flat 30% (`customerQuoteForEarnings`); hours and crew on every Easer price; one all-in quote display.
- Not built: stepped fee and owner floor (section 4), price per person-hour flag (section 5), "Price is too high" re-quote (section 6), AI advisor, automatic sending, weekly review agent (section 7). Tracked in `business-artifacts/backlog.md` under PRICING-*.

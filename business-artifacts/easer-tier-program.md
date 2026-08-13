# Easer Tier Program — "The Pro Path" (Full Spec)

Designed by the full Executive Board + Panel, reviewed by the **Chairman / Owner's
Office** (the overseer seat above the board). Grounded in the existing code
(`ACTIVE_EASER_TIERS`, `tier-check` cron, dispatch scoring) — this spec fills the
gaps that code never defined: **benefits, communications, demotion, and Easer/
customer visibility.**

> **Chairman's launch ruling (read first):** This is a *supply-density* program.
> With ~1–5 Easers and Travis as backstop, tiers are meaningless — everyone is
> Starter, "priority dispatch" means nothing with one pro, and a customer-visible
> "Elite" badge no one holds builds no trust. **Build the spec now; do NOT turn it
> on until there are ~10+ active Easers.** Turning it on early is theater. This
> ruling overrides any board seat that wants to ship it for its own sake.

---

## 1. The three tiers (names, identity, how you get there)

Internal keys stay `starter / professional / elite` (code-compatible). Customer-
and Easer-facing names below.

| Tier | Easer-facing name | How you reach it (all gates required) |
|---|---|---|
| `starter` | **Starter Pro** | Default on approval (identity verified + agreement + code of conduct). |
| `professional` | **Professional** | 10+ completed jobs · 4.5★+ rating · **80%+ acceptance rate** · no open damage/violation. |
| `elite` | **Elite Pro** | 30+ completed jobs · 4.8★+ rating · **85%+ acceptance rate** · clean record (no damage upheld, no policy violation) in last 90 days. |

**Board fix flagged:** the current cron promotes on *volume + rating only*. It
does **not** gate on `acceptance_rate` (which it already calculates) or on
damage/violations. That lets a flaky or careless Easer become "Elite" — which
poisons the badge. The acceptance + clean-record gates above must be added to
`tier-check.js` before this ships.

---

## 2. Benefits per tier (what the Easer actually gets)

Escalating, and **only benefits we can truly deliver at each stage.**

| Benefit | Starter Pro | Professional | Elite Pro |
|---|---|---|---|
| Receive job offers (dispatch) | ✅ Standard | ✅ **Higher priority** (tier score) | ✅ **Top priority — first offers** |
| Earnings share | 70% base | 70% base | 70% base **+ Elite per-job bonus** (see §6) |
| **Same-day ($69) jobs** | After higher tiers pass | **First look** | **First dibs** — most rush earnings |
| Customer-visible badge | — | **"Professional" badge** on the assigned-pro card | **"Elite Pro ⭐" badge** — prominent (drives more bookings) |
| Support response | Email, 1 business day | Faster queue | **Priority** (front of the owner's line) |
| Early access / voice | — | — | New-feature preview + **quarterly feedback call with the owner** |
| Recognition | — | — | Eligible for **"Elite Pro of the month"** feature |

**Design rationale (from the majors):** Uber Pro escalates *priority matching to
higher-value orders* + perks; TaskRabbit Elite's biggest lever is the **customer-
visible badge** (clients pick Elite pros → more work → the badge pays for itself).
Our strongest, cheapest levers are **priority on same-day/high-value jobs** and the
**badge** — both cost us nothing and directly raise the Easer's income.

---

## 3. What the CUSTOMER sees
- On the assigned-pro card (confirmation email, `/track`, reminders): the pro's
  name + tier badge — e.g., **"Your pro: Marcus — Elite Pro ⭐."**
- Starter shows **no** badge (never advertise "starter" to a customer — it reads
  as "unproven"). Absence of a badge is neutral; a badge is a positive signal only.
- The badge is a *trust* signal, matching the TaskRabbit-Elite playbook.

---

## 4. The full Easer lifecycle (end-to-end)
1. **Approved →** starts as **Starter Pro**. Welcome email explains the Pro Path.
2. **Works jobs.** The Easer app shows a **live progress meter**: "8 / 10 jobs ·
   4.6★ · 82% acceptance — 2 jobs from Professional." (Without this, the program is
   invisible and unmotivating — see Chairman's gaps.)
3. **Hits the gates →** the daily `tier-check` cron promotes them; a **promotion
   email + in-app banner** fires ("You're now Professional — here's what you
   unlocked").
4. **Maintains status.** Tiers are *earned and kept*, not permanent — see §5.
5. **Elite pros** get the badge, priority, bonus, and the quarterly owner call.

---

## 5. Demotion & maintaining status (the code has NONE — new)
A badge only means something if it can be lost. But it must be fair (contractors):
- **Grace, not a cliff.** If a tier's rating/acceptance falls below its threshold,
  the Easer enters a **30-day grace window** with a warning email ("Your rating
  dipped to 4.6 — keep it at 4.8★ to stay Elite. You have 30 days.").
- **Demotion** only after the grace window closes still under threshold. One step
  down at a time (Elite → Professional, never straight to Starter).
- **Serious cause = immediate review** (upheld damage claim, safety/policy
  violation) — handled by the owner, not the cron.
- Demotion sends a **supportive email** with the exact path back.

---

## 6. Every email / notification (nothing is left out)
| Trigger | Channel | Message (intent) |
|---|---|---|
| Approved (new Starter) | Email + in-app | Welcome + the Pro Path explained + first-tier goal. |
| **Near promotion** (within 2 jobs / 0.1★) | In-app banner + optional email | "You're 2 jobs from Professional — keep it up." Motivational. |
| **Promoted** (→ Professional / → Elite) | Email + in-app | Congrats + exactly what you unlocked + (Elite) the badge is now live. |
| **Grace warning** (metric dipped) | Email + in-app | What dropped, the threshold, the 30-day window, how to fix it. |
| **Demoted** | Email + in-app | Which tier now, why, and the specific path back. Supportive tone. |
| **Elite monthly feature** | Email | Recognition + (optional) social feature ask. |
| Quarterly Elite call invite | Email | Book a feedback call with the owner. |

**Code gap:** `tier-check.js` currently sends **zero** emails on any transition.
All of the above must be built (reuse `_email.js` + the announcement engine
`_announcements.js` already used for Easer required-actions).

---

## 7. Board seats — who owns what
- **VP of Supply / Easer Growth (owner of this program):** the whole tier ladder,
  retention, and that benefits actually motivate supply.
- **VP of Marketplace Operations:** tier → dispatch priority is already wired;
  ensure it stays fair (a new metro's lone Elite shouldn't starve Starters of all
  work — fairness factor must survive).
- **Payments & Financial-Ops + VP Finance:** any earnings benefit (§6 Elite bonus)
  must be modeled against margin BEFORE it's promised — no pay perk ships unsized.
- **VP Design / Brand:** the badge design + placement (sky-blue system), and the
  in-app progress meter.
- **General Counsel:** tier changes that affect pay for **independent contractors**
  must avoid looking like behavioral control / misclassification — keep benefits
  about *access and recognition*, be careful with anything that reads as
  "do X or we cut your pay."
- **Head of Data & AI:** the progress meter + promotion metrics must read from real
  data (completed_jobs, rating, acceptance_rate), clearly, no invented numbers.
- **Service Quality / VP Delivery Standards:** the clean-record gate — Elite must
  mean genuinely excellent, verified work, not just volume.

---

## 8. Chairman / Owner's Office review — what the board MISSED
The overseer above the board audited the design and caught six gaps the seats
would have shipped without:
1. **Cold-start / supply density.** (Ruling at top.) Meaningless below ~10 Easers.
   Do not launch early.
2. **Gaming.** Volume-only promotion is gameable (cherry-pick easy jobs, pad the
   count). Fixed by the acceptance + clean-record gates (§1).
3. **Undefined money.** "Elite earns more" cannot be promised until VP Finance
   sizes it against margin. Until then, Elite's earning benefit is **priority on
   same-day/high-value jobs** (more work), not a higher %.
4. **Contractor/legal exposure.** Pay-affecting tiers can raise misclassification
   flags. Keep the core benefits *access + recognition + badge*; route any pay
   lever through General Counsel.
5. **Invisible to the Easer.** Without the **live progress meter** (§4.2), the
   program can't motivate anyone — it's the single most important build.
6. **Undeliverable perks.** "Priority support" is only real if someone answers.
   At this stage that's Travis — so keep perks to what he can actually deliver
   (badge, priority jobs, a real quarterly call) and don't promise a support team
   that doesn't exist.

**Chairman's final ruling:** Approve the *design*. **Gate the launch on supply
(~10+ active Easers) and on VP Finance sizing any pay benefit.** Build order when
the time comes: (a) live progress meter, (b) promotion/demotion emails, (c) the
acceptance + clean-record gates in `tier-check`, (d) the customer-facing badge,
(e) only then any earnings benefit. Distribution of *Easers* is the gate — same as
distribution of *customers* is the gate for the business.

---

## 9. Implementation gap list (for when this ships)
- `tier-check.js`: add acceptance-rate + clean-record gates; add demotion with the
  30-day grace window; fire transition emails.
- New: Easer-app **tier + progress meter** (my-assignments / profile).
- New: customer-facing **badge** on the assigned-pro card (confirmation, `/track`,
  reminders) — Professional + Elite only.
- New: promotion/grace/demotion emails via `_email.js` + `_announcements.js`.
- Decision required (VP Finance): the Elite earnings benefit — bonus %, or same-day
  priority only.

---

## 10. SHIPPED (2026-08) — engine + reliability floor + UI

**Canonical tier names (use everywhere):** Starter Pro · Professional · Elite Pro.
Standardized across the Easer app, the customer badge, and every email. Do not
reintroduce "Elite Easer" / bare "Elite" / "Starter" — one name per tier.

**Tier gates (ALL must hold):**
- Professional: 10+ jobs · 4.5★ · 80% acceptance · **90% completion** · identity verified
- Elite Pro:    30+ jobs · 4.8★ · 85% acceptance · **95% completion** · identity verified
- acceptance_rate null (fewer than 3 scored offers) = fails (can't vouch yet).
- completion_rate null (no accepted-job failures yet) = passes.

**Reliability floor (the enforcement layer — closes the gap vs DoorDash completion
rate / Uber cancellation rate / TaskRabbit reliability rate):**
- `completion_rate` = completed / (completed + no-shows), computed daily by
  `tier-check` from real `activity_logs` `no_show_flagged` events. It's the 4th
  tier gate — you can't hold the top tier if you strand customers.
- **Owner-in-the-loop, never silent auto-suspend at launch:** the cron ALERTS the
  owner on a repeat no-show (2+) or a chronic decliner (<50% acceptance) with a
  recommended action; the owner decides. Dedup via `reliability_alert_count` /
  `acceptance_alert_at`.
- **Coaching:** the Easer gets one email (30-day cooldown) when acceptance slips
  into [50,70)% — help before it costs a tier.

**Files:** `api/cron/tier-check.js` (engine), `api/assembler/tier-status.js` +
`assembler/profile.html` Pro Path meter (progress incl. Reliability), `api/booking/track.js`
+ `track.html` (customer badge), migrations `062_easer_tier_program.sql` +
`063_easer_reliability.sql`. Activates by DATA (no flag). **Run 062 + 063 in Supabase.**

**Still open (tracked in backlog):** surface tier + reliability metrics on the OWNER
dashboard (currently owner learns via alert emails); real Reviews module once review
data exists.

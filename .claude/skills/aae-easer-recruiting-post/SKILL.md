---
name: aae-easer-recruiting-post
description: Write AssembleAtEase Easer (independent assembly / TV-mounting pro) recruiting posts for a Texas city or hub, for Nextdoor, Facebook groups, Craigslist gigs, Indeed-style listings, flyers or texts. Use this whenever the owner wants more Easers, pros, installers, assemblers or "people to work" in Austin, Houston, San Antonio, Dallas-Fort Worth or any Texas city, asks for a hiring/recruiting/gig post or caption, or says supply is short, even if they never say "recruiting post".
---

# Easer recruiting post

AssembleAtEase needs real Easers in its four hubs (Austin, Houston, San Antonio,
Dallas-Fort Worth) and anywhere bookings come in. A recruiting post is often the
first thing a skilled installer reads about us, so it has to be concrete, true
and short. Vague "join our team" posts get ignored; a real dollar figure for a
real job gets replies.

## 1. Get today's facts (never from memory)

Run from the repo root, with a ZIP from the target city:

```bash
node .claude/skills/aae-easer-recruiting-post/scripts/pay_examples.mjs <zip>
```

It prints the Easer share (from `getPlatformFeePct`), what an Easer earns on real
catalog items (price plus the service fee, before tax, at that share), and the
live answer to "is there an application fee at this ZIP". Use those numbers
exactly. Prices change; a stale figure in a public post is a broken promise.

If the fee answer says no fee, say "No application fee." If it shows a fee, do
not mention fees at all; the apply page states it before anyone pays. If the
script cannot reach the site, leave the fee out rather than guess.

Useful ZIPs: Austin 78745, Houston 77002, San Antonio 78240, Dallas 75227,
Fort Worth 76102.

## 2. Pick the link

- A hub or city with a recruiting page: `https://www.assembleatease.com/easer-jobs-<slug>-tx`
  (slugs: `austin`, `houston`, `san-antonio`, `dallas`, `fort-worth`, or the city
  name lowercased with hyphens; check the file `easer-jobs-<slug>-tx.html` exists).
- Otherwise: `https://www.assembleatease.com/become-an-easer`.

Add source tags so the application is credited to the post (the site records
them, `api/_attribution.js`):

| Where | Add to the link |
|---|---|
| Nextdoor | `?utm_source=nextdoor&utm_medium=social&utm_campaign=easer_<city>` |
| Facebook group | `?utm_source=facebook&utm_medium=social&utm_campaign=easer_<city>` |
| Craigslist | `?utm_source=craigslist&utm_medium=referral&utm_campaign=easer_<city>` |

`<city>` is lowercase with underscores (`easer_san_antonio`).

## 3. Write it

What the post must get right, and why:

- **Independent contractor, never employment.** Say "independent", "per completed
  job", "choose your jobs". Do not say employee, hourly wage, salary, shifts,
  guaranteed income or "we're hiring staff": AssembleAtEase uses a 1099
  independent-contractor model, and employment language creates
  worker-classification risk.
- **Tools only.** Easers bring their own tools. Customers supply furniture,
  mounts and hardware. Never say we provide parts, mounts or hardware.
- **Pay as real examples.** Two or three "a [job] pays you $X" lines from the
  script, plus "you keep [share]% of the job price plus 100% of tips". No
  averages, no "up to", no income projections.
- **No guarantees.** Job volume varies; never promise a number of jobs.
- **Business voice.** "We" and "AssembleAtEase". Never the founder's name or "I".
- **No emojis**, anywhere. No all-caps shouting, no "!!!".
- **Short.** People skim on phones: one hook line, two or three pay lines, what
  you need (tools, transportation, smartphone, ID check), one link.

Length and tone by place:

- **Nextdoor**: neighbourly, 60 to 110 words, mention the area by name once.
- **Facebook group**: 60 to 120 words. Many groups ban business posts; remind the
  owner to check the group rules or ask the admin first.
- **Craigslist (gigs > labor or skilled trade)**: a plain title of 70 characters or
  fewer ("Furniture assembly and TV mounting gigs, Austin, you pick the jobs"),
  then a slightly fuller body; Craigslist readers expect details.
- **Text or flyer**: 2 to 4 lines.

## 4. Hand it over

Give the owner, for each requested place: the title (where the place uses one),
the body, and the tagged link, ready to paste. Then one line listing the facts
used and where they came from (for example "Pay from the catalog today: TV mount
$107.80; no application fee at 78745 per the live site"), so the owner can see
nothing was invented. Do not post anything yourself; the owner posts.

## Example

Request: "need easers in houston, nextdoor post"

Output (numbers from the script on the day):

> **Furniture assembly and TV mounting work in Houston, on your schedule**
>
> AssembleAtEase is adding independent assembly and mounting pros around
> Houston. You choose the jobs that fit your week and keep 70% of the job price
> plus 100% of tips. A 56 to 65 inch TV mount pays you $107.80; a treadmill
> assembly pays $156.80. You bring your own tools, reliable transportation and a
> smartphone, and pass an ID check. No application fee.
>
> Apply: https://www.assembleatease.com/easer-jobs-houston-tx?utm_source=nextdoor&utm_medium=social&utm_campaign=easer_houston

Facts used: Easer share 70% and pay from the catalog today; no application fee
at 77002 per the live site.

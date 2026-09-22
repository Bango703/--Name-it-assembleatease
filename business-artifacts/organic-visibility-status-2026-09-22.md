# Organic visibility: findings, fixes and indexing status

AssembleAtEase — September 22, 2026. Branch: `fix/organic-discovery-indexing`.

## What changed

- The Locations page now gives Austin, Dallas, Houston and San Antonio compact, direct links to all six existing service categories, plus relevant surrounding-area links. All 54 Texas city entries and all 324 service pages remain available, including Lubbock. Statewide booking rules are unchanged.
- Eight furniture/TV pages across those four metros have more useful preparation and scope guidance and matching visible/schema FAQs. This replaces generic copy; it does not invent local jobs, reviews, staffing or availability.
- All six San Antonio service pages correct the misleading nearby-city list. Statewide options remain available through Locations.
- Selective service generation avoids rebuilding unrelated pages. Sitemap dates for the 13 changed public pages are updated to the actual change date, and generator behavior preserves existing per-URL dates instead of resetting them to July 16.
- The SEO audit now checks every public sitemap URL and intentional search exclusion. It checks useful service guidance rather than requiring identical keyword lists on every page.
- **Google accepted a Request indexing submission for the existing San Antonio furniture page.** The UI confirmed that it was added to a priority crawl queue. Acceptance is not proof of indexing. No repeat request was submitted.

The user approved push and deployment on September 22 after reviewing this change set. At the time this report was prepared, the website changes were tested locally and the Google indexing request above was accepted. Production publication and live verification are recorded in the release results rather than inferred from the local checks.

## Why it changed / what is going on

### Technical access is healthy

The current live sitemap contains 412 URLs. Every URL was fetched in a bounded read-only sweep: all returned HTTP 200, exactly one expected self-canonical, and no noindex meta or HTTP header. Public URLs are allowed by robots. Google Search Console shows the sitemap as Success, last read September 20, with all 412 discovered.

Search Console reports no manual actions and no security issues. This does **not** establish that every page is indexed or ranks well. It rules out the broad technical blocks checked in this audit.

Local inventory: 429 HTML pages, comprising 412 sitemap URLs and 17 intentional private/utility exclusions. Google's index report covers a different set of 434 known URLs, including old, alternate and parameter URLs; its 394 indexed count cannot be subtracted directly from the current 412 sitemap URLs to determine missing pages.

### Google has not selected some useful service pages

The September 17 indexing snapshot contains 15 service URLs in the discovered/not-indexed or crawled/not-indexed categories. None failed the current HTTP/canonical/noindex sweep. The exact reason Google has not selected each page remains unproven; there is no evidence here of a sitewide ban or a robots block on these pages.

| Service URL | Google report status | Action/status |
|---|---|---|
| `/furniture-assembly-san-antonio-tx` | Discovered, not indexed | Individual inspection confirmed; live test passed; Google accepted indexing request. Content/navigation improvements prepared locally. |
| `/furniture-assembly-baytown-tx` | Discovered, not indexed | Direct Houston-area navigation added locally; monitor after deployment. |
| `/office-furniture-assembly-new-braunfels-tx` | Discovered, not indexed | Direct San Antonio-area navigation added locally; monitor after deployment. |
| `/fitness-equipment-assembly-mcallen-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/furniture-assembly-abilene-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/playset-assembly-baytown-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/playset-assembly-bryan-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/smart-home-installation-corpus-christi-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/smart-home-installation-pearland-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/smart-home-installation-san-angelo-tx` | Discovered, not indexed | Public and technically eligible; statewide page preserved. |
| `/smart-home-installation-leander-tx` | Crawled, not indexed | Direct Austin-area navigation added locally. |
| `/furniture-assembly-pasadena-tx` | Crawled, not indexed | Direct Houston-area navigation added locally. |
| `/furniture-assembly-hutto-tx` | Crawled, not indexed | Direct Austin-area navigation added locally. |
| `/smart-home-installation-cedar-park-tx` | Crawled, not indexed | Direct Austin-area navigation added locally. |
| `/tv-mounting-round-rock-tx` | Crawled, not indexed | Direct Austin-area navigation added locally. |

Also discovered/not indexed: `/blog/tv-mounting-tips-austin`, `/blog/why-hire-handyman-austin`, `/easer-jobs-round-rock-tx`, `/privacy`, `/terms`. These all remain in the sitemap and passed the same live eligibility check. Two other crawled/not-indexed examples are an application query URL and a retired junk-removal article; they should not be treated as missing customer-service destinations.

### Some exclusions are correct

Directly inspected examples:

- Robots: `/api/contact`, `/assembler/contractor-agreement`, legacy `/assembler/earn`. Do not open private/API areas merely to reduce exclusion counts.
- Noindex: `/auth/signup`, `/track`. Keep these out of search.
- Alternate canonical: `/assembler/apply?city=Mesquite`, `/book?service=Furniture Assembly`. Canonical destination indexing is the intended outcome, not indexing every parameter variation.
- 404: retired `/repairs`. Do not recreate a retired service or redirect to an unrelated service solely for an indexing statistic.
- Ten redirects appear as another exclusion category; sitemap audit confirms no redirect-source URL is in the current sitemap. No redirect changes were justified.

### Ranking and customer demand remain separate work

Web performance, August 24–September 20: 69 property clicks, approximately 5,320 impressions, 1.3% CTR, average position 21.3. Austin furniture has 1,328 page impressions / 4 clicks / position 36.9; Austin TV has 453 / 1 / 32.4. Houston furniture has 14 / 1 / 21.2; Dallas furniture 14 / 0 / 6.0; San Antonio TV 39 / 0 / 16.8. These are small samples, not citywide demand estimates or fixed rankings.

Recruitment pages receive part of the traffic; they remain useful and are not removed. Count qualified customer requests separately from Easer applications. The earlier GA4 audit also found booking-measurement gaps, which are not changed in this SEO patch.

Google's AI Search report contains 227 impressions over the same 28 days. This is existing visibility in Google's AI features, not proof of visits or bookings and not a measurement of every AI assistant. The Links report currently lists two external links, from MapQuest and Yahoo; this is Google's reported sample, not a complete inventory of the web. It supports investigating stronger genuine local references, but does not prove that link count alone causes the rankings.

## Files changed

- `locations.html`
- `furniture-assembly-austin-tx.html`
- `furniture-assembly-dallas-tx.html`
- `furniture-assembly-houston-tx.html`
- `furniture-assembly-san-antonio-tx.html`
- `tv-mounting-austin-tx.html`
- `tv-mounting-dallas-tx.html`
- `tv-mounting-houston-tx.html`
- `tv-mounting-san-antonio-tx.html`
- `fitness-equipment-assembly-san-antonio-tx.html`
- `office-furniture-assembly-san-antonio-tx.html`
- `playset-assembly-san-antonio-tx.html`
- `smart-home-installation-san-antonio-tx.html`
- `scripts/build-flagship-service-pages.mjs`
- `scripts/apply-flagship-cities.mjs`
- `scripts/generate-location-pages.js`
- `scripts/seo-site-audit.mjs`
- `scripts/test-location-sitemap-lastmod.mjs`
- `sitemap.xml`
- `.github/workflows/guards.yml` (runs the indexability and sitemap-date checks in CI)
- `business-artifacts/organic-visibility-status-2026-09-22.md` (this document)

## What was not changed

Prices, service catalog, booking/statewide eligibility, Easer readiness, dispatch market rules, payment authorization/capture, payouts, taxes, refunds, Analytics configuration, ads and social publishing. No cities or public service pages were removed. No private pages were made indexable. No automatic posting, paid campaign, customer message or Easer message was started.

## Validation performed

| Perspective/check | Result |
|---|---|
| Customer: desktop Locations navigation and San Antonio furniture page | PASS — links and page render; existing booking links preserved. |
| Customer: 390px Locations navigation and Austin TV FAQ | PASS — usable single-column layout, accordion/FAQ interaction works, no observed overflow. |
| Easer: statewide dispatch market regression | PASS — Lubbock and Houston jobs retain their local-market eligibility; no availability restriction introduced. |
| Owner: catalog/status/readiness source-of-truth audit | PASS — 12 checks, no warning/failure. |
| SEO audit | PASS — 324 service pages, 54 cities, 412 sitemap URLs, 17 intentional exclusions. |
| Governance strict | PASS — 429 pages, zero warnings/failures. |
| Existing smoke tests | PASS. |
| Inline script syntax | PASS — 2,331 blocks across the script's 1,283-page scan. |
| Changed generator/audit ESLint and syntax | PASS. |
| Prices, schema, assets, generator idempotence | PASS — existing pricing sections preserved; visible FAQ and schema match; targeted regeneration is stable. |
| Audit negative controls | PASS — malformed indexability and missing/duplicate useful guidance are rejected. |
| Sitemap date regression | PASS — all 412 URLs retained, existing dates preserved, new URL dated, invalid/missing old dates omitted, repeat generation stable in an isolated fixture. |
| Stripe | Not exercised: no money behavior changed and no live transaction was created. |

Test-generated governance findings were restored to their original contents so routine report output is not included as unrelated churn.

## Remaining warnings / follow-up

1. Publishing approval was received. Until the approved deployment is complete, Google sees the current live pages, not the local improvements.
2. After approved deployment, verify the changed canonical URLs and sitemap dates live. The existing successful sitemap covers all public URLs. Use a few targeted URL inspections and monitor the affected service URLs; repeated requests do not force indexing.
3. Check the 15 service URLs after Google processes the published changes. If some remain excluded, inspect actual Google-selected canonical, crawl/render output, usefulness and local proof for those pages. Do not label them fixed merely because local checks pass.
4. Build real local credibility: accurate business listings, genuine completed-job evidence and legitimate referrals/partner references. Do not fabricate a location or customer review. Keep Buffer as the publishing hub.
5. Review customer-search clicks, qualified requests and real completed/captured jobs weekly. Compare equivalent periods; ranking growth and additional bookings are not guaranteed by this patch.

## Safe to deploy?

The scoped SEO/content/navigation changes passed the focused combined checks and have explicit push/deployment approval. Release through the existing CI checks before promotion. They do not change financial or fulfillment behavior and cannot guarantee indexing, Maps placement, AI inclusion or a particular ranking.

Evidence: `tmp/live-indexability-audit-2026-09-22.json`, `tmp/technical-indexability-audit-2026-09-22.md`, `tmp/search-console-organic-audit-2026-09-22.md`, `tmp/ga4-growth-audit-2026-09-22.md`.

Official guidance: [URL inspection and indexing requests](https://support.google.com/webmasters/answer/9012289?hl=en), [Google indexing statuses](https://support.google.com/webmasters/answer/7440203?hl=en), [Google AI Search report](https://support.google.com/webmasters/answer/16984139?hl=en).

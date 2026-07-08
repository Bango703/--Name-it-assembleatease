# Page Governance System

This is the site-governance foundation for AssembleAtEase. It is meant to give the repo the same kind of repeatable structure professional teams use for large page sets:

- one source of truth for core business and social links
- one inventory for every HTML page
- one page taxonomy
- one audit pass for drift, missing fields, and stale links
- one repeatable workflow for future site-wide changes

## What This Covers

- flagship Austin service pages
- city and service landing pages
- blog index and blog articles
- core marketing pages
- pricing, business, and booking pages
- support, policy, and utility pages
- auth, assembler, and owner pages

## Source Of Truth

Primary source-of-truth file:

- `business-artifacts/page-governance/site-governance.json`

This file currently stores:

- business name and legal name
- domain
- primary city and state
- support email
- phone display and E.164
- review rating and review count
- current Facebook URL
- legacy Facebook URL to block
- core CTA routes
- flagship Austin page list
- service prefixes for location pages

## Page Types

Current taxonomy:

- `home`
- `booking`
- `flagship_service`
- `city_service`
- `pricing`
- `business`
- `blog_index`
- `blog_article`
- `core_marketing`
- `support`
- `policy`
- `auth`
- `assembler_public`
- `assembler_portal`
- `owner_portal`
- `utility`
- `unknown`

## Generator Ownership

Current ownership model:

- `flagship_service` -> `scripts/build-flagship-service-pages.mjs`
- `city_service` -> `scripts/generate-location-pages.js` plus `scripts/refresh-seo-and-promo-pages.mjs`
- `blog_*` -> manual content plus `scripts/cleanup-blog-pages.mjs`
- core, support, policy, auth, assembler, owner pages -> currently manual

This matters because a future site-wide change should hit the source generator first when possible, not only the already-generated output.

## Commands

- `npm run governance:sync`
- `npm run governance:nav`
- `npm run governance:footer`
- `npm run governance:consent`
- `npm run governance:public`
- `npm run governance:report`
- `npm run governance:check`
- `npm run governance:check:strict`

What they do:

- `governance:sync` updates pages and generator scripts to the current source-of-truth values for business identity and social links
- `governance:nav` rewrites governed public nav blocks across the public site from one shared nav builder
- `governance:footer` rewrites governed public footers across the public site from one shared footer builder
- `governance:consent` rewrites the shared cookie-consent and analytics layer across public pages
- `governance:public` runs the full public-site shell sync sequence in one command
- `governance:report` creates a full page manifest and a human-readable report
- `governance:check` audits the current pages and writes findings without failing the command
- `governance:check:strict` fails if there are `FAIL` findings

## Report Files

Generated under `business-artifacts/page-governance/`:

- `page-manifest.json`
- `page-manifest.csv`
- `page-governance-report.md`
- `page-governance-findings.json`
- `page-governance-findings.md`
- `page-governance-sync-report.json`
- `page-governance-sync-report.md`
- `page-public-nav-sync-report.json`
- `page-public-nav-sync-report.md`
- `page-public-footer-sync-report.json`
- `page-public-footer-sync-report.md`
- `page-public-consent-sync-report.json`
- `page-public-consent-sync-report.md`

## Current Governance Checks

The first version checks for:

- missing title
- missing meta description
- missing canonical
- missing core Open Graph tags
- missing LocalBusiness/HomeAndConstructionBusiness schema where required
- missing current Facebook Page link
- legacy Facebook link still present
- malformed current Facebook link still present
- legacy Google Maps link still present
- missing shared promo script on service pages where required
- missing shared cookie-consent banner/script on public pages
- missing book link where required
- recommended missing track or business links
- unmapped page types

## Intended Workflow

For future "change this everywhere" work:

1. update the source-of-truth file if the value is business-wide
2. run `npm run governance:sync`
3. run `npm run governance:nav` when the change affects a governed public nav
4. run `npm run governance:footer` when the change affects a governed public footer
5. run `npm run governance:consent` when the change affects cookie consent or analytics bootstrap behavior
6. update the generator or manual template that owns the page type if the sync report shows hard-coded drift in source files
7. regenerate affected pages if needed
8. run `npm run governance:report`
9. run `npm run governance:check`
10. review failures and warnings before deploy

## What This Does Not Solve Yet

This foundation does not yet:

- rewrite every page to consume one shared runtime component system
- centralize all metadata generation into one template engine
- add Meta Pixel or ads tracking
- convert every manual page into a generator-backed page

Those are next-layer improvements. This foundation is the control system that tells us what exists, who owns it, and what is drifting.

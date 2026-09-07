# Supabase SQL Editor organization - completed

Project: Assembleatease Project (`ukamyqnaukxlmeoncjgr`). User explicitly requested careful naming and organization. Preserve all saved SQL. No query execution, database mutation, deletion, sharing changes, or website deployment is authorized by this cleanup.

## Audit baseline

- 169 private saved queries; 70 titled Untitled query; no folders.
- The two queries named List Public Tables of Interest contain different SELECT statements and must not be treated as duplicates by title.
- Add persona_checks JSONB Column repeats one ALTER TABLE statement twice; Add persona checks to profiles contains the same statement once. Both preserved.
- Add Fee and Revenue Columns to Bookings is misleading: its SQL adds reauth_needed and reauth_at, not fee columns.
- Clear Push Subscriptions contains DELETE FROM push_subscriptions without a WHERE clause. Never run it as part of organization.
- Saved snippets do not prove which migrations are applied to the live database.
- Local api/migrations contains 95 SQL files, no exact SHA-256 duplicate files, and repeated numeric prefixes 011, 069, 091. No local migration file was edited.

## Renaming examples

Saved-query names, descriptions, and folder membership were changed. Original private visibility and SQL text were preserved. The positions below identify the original flat list for audit purposes; they are not current navigation positions.

| Original position | New saved name |
|---:|---|
| 1 | 075 - Booking Change Orders [DB CHANGE] |
| 2 | 067 - Rebooking Lineage [DB CHANGE] |
| 3 | 065-066 - Customer Consent and Contractor Agreement [DB CHANGE] |
| 4 | 064 - Review Request Counter [DB CHANGE] |
| 5 | 062-063 - Easer Tiers and Reliability [DB CHANGE] |
| 6 | Easer Tier Timestamps - Partial Setup [DB CHANGE] |
| 7 | 061 - Same-Day Fee and Easer Bonus [DB CHANGE] |
| 8 | Market Requests - Close Specific Spam Requests [DATA CHANGE] |
| 9 | Email Delivery - Recent History for One Recipient [CHECK] |
| 10 | 057 - Easer Announcements Setup [DB CHANGE] |
| 11 | 054-056 - Migration and Payment-Lock Verification [CHECK] |
| 12 | Database Triggers and Indexes [CHECK] |
| 13 | 056 - Booking Attribution and Authorization Lock [DB CHANGE] |
| 14 | 055 - Manual Discount Function Ambiguity Fix [DB CHANGE] |
| 15 | 054 - Market Demand and Damage Cases [DB CHANGE] |
| 16 | 052 - Manual Balance Discount Function [DB CHANGE] |
| 17 | 053 - Operations Cases Setup [DB CHANGE] |
| 18 | 052 - Manual Balance Discount [DUPLICATE - DB CHANGE] |
| 19 | 051 - Manual Payment and Completed Discount V5 [DB CHANGE] |
| 20 | 050 - Completed Booking Discount [DB CHANGE] |
| 21 | 049 - Manual Payment Gross-Amount Guard [DB CHANGE] |
| 22 | 048 - Easer Performance Counters [DB CHANGE] |
| 23 | 047 - Manual Booking Recovery and Evidence [DB CHANGE] |
| 24 | 048 - Easer Performance Counters [DUPLICATE - DB CHANGE] |
| 25 | 047 - Manual Recovery and Evidence [DUPLICATE 2 - DB CHANGE] |
| 26 | 047 - Manual Recovery and Evidence [DUPLICATE 3 - DB CHANGE] |
| 27 | 045 - Manual Stripe Refund Ledger [DB CHANGE] |
| 28 | 045 - Refund Migration Applied-State Lookup [CHECK] |
| 29 | 046 - Customer Broadcast Email Setup [DB CHANGE] |
| 30 | Owner-Easer Account Configuration [DATA CHANGE] |

Positions 16 (bcf9ca6d-96e2-4986-968a-d3f2cff47606) and 18 (1b19bf6b-cecd-40d4-a791-ae52855b0faa) are identical after normalizing CRLF to LF and trimming outer whitespace. Both saved copies remain. The duplicate description explains this classification.

## Full inventory review completed

All 169 distinct saved-query IDs were read without executing SQL. All 70 originally unnamed queries now have descriptive names. A total of 102 query titles were changed, including misleading pre-existing titles. The table above is a sample of verified renames, not the full inventory.

Exact duplicate groups, using original sidebar positions: 16/18, 22/24, 23/25/26, 32/35, 33/36, 52/55, 53/56, 68/69, 74/77, 85/87, and 114/115. These are 11 groups containing 12 extra copies. Every copy is preserved. Normalization only converts CRLF to LF and trims outer whitespace. Different migration versions and the repeated Persona statement are not classified as exact whole-query duplicates.

## Important findings in saved scripts

These findings describe stored script contents, not proof that the script ran or that live data has the described problem.

| Risk | Saved entry / corrected title | Finding |
|---|---|---|
| P0 if executed | Drop and Recreate Reviews | Previously named Fetch Latest Approved Reviews; begins with DROP TABLE reviews CASCADE. |
| P0 if executed | Drop and Recreate Profiles | Starts by dropping profiles and creating a minimal replacement. |
| P0 if executed | Recreate Application Status Column | Drops application_status before recreating it; can lose approval states. |
| P0 if executed | Clear All Push Subscriptions; Push Setup and Delete All Subscriptions | Both include an unfiltered deletion of push subscriptions. |
| P0 if executed | Replace Public Schema RLS Policies | Broadly replaces access-control policies; requires an independent security review. |
| P0 if executed | Agreement and Identity Backfill; Profile Identity and Tier Override | Can populate agreement/identity state without establishing genuine evidence. |
| P0 if executed | Review and Recalculate Easer Earnings | Previously called a report; also updates profile earnings totals. |
| Security warning | Operations Checklist - Sensitive Test Login | Contains a test-account credential. Kept private; credential values omitted from this report. Review account activity and rotate if still usable. |
| P1 | Financial Audit Setup | Apparent stray closing parenthesis in saved SQL; not syntax-validated by execution. |
| P1 | Booking Timeline Setup with JavaScript | Mixes executable JavaScript into SQL and repeats setup statements. |
| P1 | Manually Mark Migration Applied | Writes a registry entry without applying the associated schema changes. |
| P1 | Inspect Jobs and Recalculate Completion Counts | Previously called a schema inspection; also updates job counters. |
| P1 | Booking Payment Reauthorization Fields | Old fee/revenue title did not match reauth_needed and reauth_at columns. |

## Verified folder organization

Six private folders were created. The following membership was verified after a fresh server reload, expanding every folder and loading the second page of the setup folder:

| Folder | Queries |
|---|---:|
| 01 - Troubleshooting Checks | 27 |
| 02 - Database Setup - Review Before Running | 106 |
| 03 - Data Changes - Review First | 10 |
| 04 - High Risk - Do Not Run | 11 |
| 05 - Notes and Invalid SQL - Review | 3 |
| 99 - Exact Duplicates - Preserved | 12 |
| Total preserved | 169 |

All 169 queries are filed; zero queries remain loose at the root. No SQL execution, SQL-body edits, data deletion, permissions changes, deployment, commit, or push was performed.

## 1. What changed

- Renamed all 70 originally untitled queries and corrected misleading existing titles: 102 title changes in total.
- Added purpose/risk descriptions where blank and corrected descriptions introduced during this cleanup when a script proved to be a distinct version.
- Organized all 169 private queries into the six folders above.
- Preserved every exact duplicate, different version, repeated statement, and historical script.
- Left the editor on Recent Failed Scheduled Jobs [CHECK], without executing it.

## 2. Why it changed

The original flat list mixed read-only diagnostics, schema migrations, financial/account updates, destructive cleanup scripts, and non-SQL notes. Several harmless-sounding titles concealed writes or table deletion. Clear names and folders reduce the chance of selecting the wrong script during an incident; they do not disable execution or replace access controls.

## 3. Files and surfaces changed

- Supabase SQL Editor private saved-query metadata: names, descriptions, folders, and folder membership.
- This internal report: business-artifacts/supabase-sql-organization-2026-09-05.md.
- No application source, migration SQL file, website asset, or deployment configuration was changed by this cleanup.

## 4. What was not changed

No SQL was run. No saved query or database record was deleted. No SQL body, table, schema, RLS policy, customer record, booking, profile, payment, payout, agreement evidence, or credential was altered. Queries were not shared with the team or made public. No commit, push, or deployment was performed.

## 5. Validation performed

| Check | Result | Evidence |
|---|---|---|
| Saved-query inventory | PASS | 169 distinct query IDs inventoried before organization; final refreshed PRIVATE count is 169. |
| Names | PASS | 169 unique final names; zero Untitled query entries. |
| Folder membership | PASS | Every final name matched its planned folder; zero mismatches and zero root queries. |
| Preservation | PASS | All 11 duplicate groups retained, including all 12 extra copies. |
| SQL content spot-checks | PASS | 11 saved queries had exact before/after text matches and the same query URLs/IDs. Samples included large migrations, a duplicate, earnings updates, agreement backfill, the sensitive checklist, table deletion, unfiltered deletion, reauthorization, and the repeated Persona statement. |
| Live database health | WARNING | Not tested by executing SQL; organization does not establish which migrations are applied or whether live records/permissions are correct. |

Spot-check positions in the original inventory: 1, 18, 23, 61, 90, 111, 126, 129, 135, 149, and 169. These are representative checks, not a claim that every SQL body was re-read after organization.

## 6. Remaining warnings and how to use the folders

Start in **01 - Troubleshooting Checks** when investigating an issue. These saved scripts were reviewed as read-only. Results can still contain sensitive information, and some queries are limited to a particular recipient, profile, booking reference, or migration number. They are not continuous monitoring or proof of current system health.

| Investigating | Look for |
|---|---|
| Scheduled task failures | Recent Failed Scheduled Jobs [CHECK] |
| Email delivery history | Email Delivery - Recent History for One Recipient [CHECK] |
| A particular booking | Find Booking by Reference |
| Easer onboarding fields | Easer Onboarding Status by Profile ID [CHECK] |
| Missing tables, indexes, or triggers | Database Triggers and Indexes [CHECK]; Schema Introspection and RLS/Indexes Audit; the targeted table checks |

Do not run folders 02-05 or 99 as a general repair sequence. Migration numbers indicate saved script purpose, not confirmed applied state. Different versions may contain incompatible schema, status, or security assumptions. Folder 04 warnings are labels, not an execution lock.

The saved test-account credential requires a separate security decision: confirm whether the account or credential is still usable, review its privileges/activity, and rotate or revoke it through an approved account-security workflow. No credential value is reproduced in this report, and this cleanup did not change credentials.

The syntax issues, mixed-code note, consent/identity overrides, and destructive historical scripts remain intentionally unchanged. They require separate review before anyone considers execution. Finding them in saved SQL does not prove they ran against production.

## 7. Deployment status

No deployment is needed for saved-query organization. This cleanup does not certify launch readiness, financial correctness, or production security. Those require a separately scoped read-only database/application audit and approval before any repair affecting live data or schema.

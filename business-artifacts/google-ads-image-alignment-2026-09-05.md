# Google Ads image alignment - September 5, 2026

## Status

**Approved photo-coverage expansion completed live:** Austin, Houston, and San Antonio each have the same 15 eligible furniture/TV image versions available to their active furniture ad group. Added 34 associations total: Austin 13 and San Antonio 15 at 8:11 PM Central; Houston 6 at 8:12 PM Central on September 5, 2026, as displayed by Google Ads. A full browser reload and exact image-set comparison found no missing or unexpected images in the three eligible furniture pools.

**Three gym-image associations were paused live and verified after reloading Google Ads.** Saved September 5, 2026 at 6:56 PM Central, as displayed by Google Ads.

The user revised the earlier proposed cleanup: TV images and images containing furniture may remain; gym photos must not appear in furniture ads. This revision supersedes the earlier seven-association cleanup proposal. The initial change paused only the three gym associations. Subsequent explicit approvals authorized turning off automatic image selection and then publishing the 15-version furniture-photo set. **Account-level Dynamic images is Off**, verified again after the image additions. The computer-use skill was used to inspect the live UI, obtain action-time approval for the publishing batch, make these reversible changes, and verify saved state.

Account: 293-675-5780, assembleatease@gmail.com.

## Findings

P1: mismatched service photos can confuse customers and attract irrelevant clicks; inadequate manual coverage leaves fewer relevant photo choices available. No booking, payment, payout or Easer-readiness logic is involved. The initial table contained 39 enabled/paused image associations; the final verified table contains 73 after the 34 approved additions. No account-level image rows appeared.

- Austin | Furniture Assembly | Search is enabled. Its Furniture Assembly ad group is enabled; Fitness Equipment, Mounting & Hanging, Office Assembly, Outdoor & Playsets and Smart Home Setup are paused.
- Three gym/power-rack images were enabled at Austin campaign level, above all six service groups. All three are now Paused; none was deleted from the library. The Fitness Equipment ad group already has four relevant fitness images and remains paused. Those four image associations were preserved.
- Houston | Furniture Assembly | Search is enabled with one ad group. Its nine existing campaign-level photos remain Enabled and Eligible, including both TV/console photos. Six additional eligible versions are now assigned to Houston Furniture Assembly at ad-group level, for a combined pool of 15 unique image assets.
- Two identical brand-logo-as-image associations remain disapproved for Text or graphic overlays: one in Austin Furniture Assembly and one in Mounting & Hanging. These were deselected and left unchanged in the narrowed gym-only update. Legitimate Business logo assets were not altered.
- San Antonio | Furniture Assembly | Search is enabled with one ad group named Ad group 1. Its previous zero-manual-image gap is fixed: 15 eligible furniture/TV image versions are now assigned at ad-group level.
- Austin Furniture Assembly now has 15 eligible furniture/TV image versions, up from two crops of one dresser. Its separate disapproved logo-as-image row remains unchanged and is not counted in those 15.
- Account-level Dynamic images is **Off**. The user explicitly approved this safeguard after the gym-image pauses. The opt-out reason selected was "You want to retain more control"; no additional comments were submitted. All nine other automated asset controls remain On and unchanged.
- The removed legacy Furniture Assembly Services campaign was not changed.

## 1. What changed

Only the following three campaign-level associations were paused. Google Ads returned **3 assets paused**; a full browser reload confirmed all three as Paused, with September 5, 2026 at 6:56 PM shown as their update time.

The identifiers below are the observed image-serving URL suffixes, not Google Ads asset IDs. Prefix each with https://tpc.googlesyndication.com/pimgad/.

| Scope | Image suffix | Subject |
|---|---|---|
| Austin campaign | 18174301657759587510 | Gym/power rack |
| Austin campaign | 14778199923576367136 | Gym/power rack crop |
| Austin campaign | 9624942500065695400 | Gym/power rack crop |

After separate user approval, Dynamic images was changed from On to Off at account level. The saved settings page continued to show Off after reloading. Dynamic business logos and all other automated asset settings were not changed.

After the next explicit approval, 34 new ad-group image associations were published, reusing the existing approved furniture/TV set documented below. No new image files or crops were created during this publishing batch.

## 2. Why it changed

Gym imagery at the furniture campaign level was a P1 relevance/customer-confusion risk. Campaign-level placement could make those images available beyond fitness-specific ads. The three affected rows each reported zero impressions and zero cost for August 29-September 4; this audit does not claim proven wasted spend from them. No payment, payout, booking, legal-policy, or Easer-readiness behavior was changed.

Turning off Dynamic images removes automatic landing-page photo selection as a source of unreviewed image choices. Google displayed a generic warning that disabling this feature could reduce ad performance. The user's approved tradeoff was greater control over which photos appear. Manually assigned images are preserved.

## 3. Files changed

Only this local internal audit record was updated: `business-artifacts/google-ads-image-alignment-2026-09-05.md`. No website source files were changed.

## 4. What was not changed

- All TV and furniture photos were preserved. Houston TV/console serving suffixes 1341807331498527522 and 3023071985397619934 remain Enabled and Eligible.
- The two disapproved logo-as-image associations, both suffix 7486159612055437370, were not modified.
- Other service-specific image associations remain unchanged, including fitness images assigned only to the Fitness Equipment ad group.
- No image file was deleted, generated, or uploaded. The 34 new associations reuse existing image assets.
- The earlier incomplete sofa-addition draft was canceled without saving. It was superseded by the later approved and completed 15-version set, published through Add to > Ad group.
- Apart from Dynamic images, no automation settings were changed. Dynamic sitelinks, callouts, structured snippets, seller ratings, longer ad headlines, automated apps, automated locations, dynamic business names, and dynamic business logos remain On.
- No budgets, bids, ad copy, geography, campaign/ad-group statuses, website code, payments, payouts, deployment, Git commit, or Git push were changed.

## 5. Validation performed

| Check | Result | Evidence |
|---|---|---|
| Three campaign-wide gym images paused | PASS | Google success notice and all three Paused after reload |
| TV and furniture images preserved | PASS | Both Houston TV crops and all other Houston rows Enabled/Eligible; Austin dresser square/landscape Enabled/Eligible |
| Other image associations preserved | PASS | All 73 rows re-read after reload and scrolling; the original three gym campaign associations remain Paused |
| Existing gym images retained for fitness service | PASS | Four Fitness Equipment ad-group image associations unchanged |
| Approved furniture-image batch published | PASS | 34 additions; table increased from 39 to 73 rows; success notices followed by a full reload |
| Austin furniture coverage | PASS | 15 Eligible versions; exact approved set, no missing/unexpected assets |
| Houston furniture coverage | PASS | 9 campaign-level plus 6 ad-group-level Eligible versions; exact approved set |
| San Antonio furniture coverage | PASS | 15 Eligible ad-group versions; exact approved set |
| Automatic landing-page image selection disabled | PASS | Dynamic images Off after Save and full browser reload |
| Other automated asset settings preserved | PASS | Nine other controls remain On after reload |
| All image-policy issues resolved | WARNING | Two disapproved logo-as-image associations remain unchanged |
| Live serving appearance | WARNING | Eligible and assigned does not mean every Search format/impression will contain a photo; no live impression test claimed |

## 6. Remaining warnings

The three existing gym assignments that could serve with furniture ads are fixed, Dynamic images is Off, and all three cities now have the approved 15-version furniture-photo pool. The two disapproved image-type logos remain separate unchanged items; they are not counted as eligible furniture photos. Other automation types, including dynamic business logos, were not disabled. Google controls which eligible assets appear in each Search format. No ad-serving impression test, exact propagation time, or booking outcome was claimed.

## 7. Whether it is safe to deploy

No website deployment is needed. The three reversible Google Ads pauses, Dynamic images opt-out, and 34 approved image additions are saved live and verified. Source image files and existing associations were preserved. Reversal of the new batch would require pausing/removing only the 34 newly added associations with appropriate approval. Do not execute the superseded broader seven-association removal plan.

## Reference

[Google image assets guidance](https://support.google.com/google-ads/answer/9566341?hl=en-GB) recommends ad-group scope for the strictest relevance and campaign-level images only when they fit all ads in that campaign. [Dynamic image assets](https://support.google.com/google-ads/answer/10109688) can automatically select landing-page imagery.

## Follow-up: sparse ad previews and incomplete photo coverage

The user supplied mobile ad previews and objected that too few furniture photos appeared. The earlier cleanup fixed mismatches but did not fill the manual-image coverage gaps; it should not have been presented as complete photo coverage.

### Initial diagnosis before the approved expansion

- P1: Austin's active Furniture Assembly ad group has just two eligible images, both crops of the same dresser. Several usable furniture photos are assigned only to the paused Office Assembly ad group and are not available to the active furniture ad group.
- P1: San Antonio has no manually assigned image associations in the audited table.
- Houston has nine eligible campaign-level image versions and broader subject coverage. Its TV/console and furniture photos are preserved.
- The supplied screenshots show different Search/location ad formats. The gray bars below the ads are preview placeholders for surrounding results, not missing business content.
- Google states that image format selection is auction-dependent and recommends at least four unique relevant images with square and landscape coverage. More assigned assets improve available creative choices but do not force every Search preview or impression to contain a photo. See [Google image assets for Search](https://support.google.com/google-ads/answer/9566341?hl=en).

### Approved batch, now published and verified

The user explicitly approved the prepared batch. In Edge tab 995943916, Add to > Ad group > Done published the selected set to Austin > Furniture Assembly and San Antonio > Ad group 1. Google preserved the two existing Austin dresser associations, adding 28 new rows rather than duplicating them. A second six-version batch was published to Houston > Houston Furniture Assembly. Both batches returned "Selected assets added to the ad group level." The final table has 73 rows, all re-read after a full browser reload. No draft remains awaiting approval for this batch.

The saved common set uses these observed image-serving suffixes, with prefix `https://tpc.googlesyndication.com/pimgad/`:

| Subject | Existing image versions selected |
|---|---|
| White dresser | 1980932898975151317; 17859874497092024000 |
| Beige sectional sofa and ottoman | 18293936012699621476 |
| TV and console | 1341807331498527522; 3023071985397619934 |
| Light patio furniture | 15584297477121542344; 15386543451879410967; 9423093750525672495 |
| Dark patio seating | 15045996241307855417; 15425599644468668833 |
| Glass-door cabinets | 2654504359961620666 |
| Wood office desk | 1781071019342120182; 15311583332245074957 |
| Office workstations and chairs | 12038068306570402253; 2887169916429357832 |

Full-size reviews in this follow-up confirmed the cabinet square is 1500 x 1500; desk square is 1339 x 1333 and landscape 1999 x 1040; workstation landscape is 1280 x 665 and square 858 x 853. The tight landscape cabinet crop (954266447096226604) was inspected but not selected. Existing Houston photos and dresser were visually audited earlier. No gym, smart-home, playset, logo-as-photo, or technician-generated scene is selected for this batch.

Final validation:

| City | Newly added | Eligible furniture/TV versions now | Scope | Saved time (Central) |
|---|---:|---:|---|---|
| Austin | 13 | 15 | Furniture Assembly ad group | September 5, 2026, 8:11 PM |
| San Antonio | 15 | 15 | Ad group 1 | September 5, 2026, 8:11 PM |
| Houston | 6 | 15 | 9 existing campaign + 6 new Houston Furniture Assembly ad group | September 5, 2026, 8:12 PM |

Exact-set comparison after reload: missing images = 0 and unexpected eligible furniture images = 0 for each city. All 34 new assignments showed Eligible, not Pending or Disapproved, at verification. Gym campaign assignments remained Paused. A fresh settings page showed Dynamic images Off. Budgets, bids, ad copy, geography, campaign/ad-group statuses, and other automation settings were not changed. The verified outcome is saved eligible photo coverage, not a claim that every text-only preview now displays images.

No website code or deployment is involved. This record is local only.

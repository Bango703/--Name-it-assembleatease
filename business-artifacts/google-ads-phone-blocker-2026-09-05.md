# Google Ads public phone correction: blocked, not published

## 1. What changed

No live phone-asset change was saved. Corrected the three-campaign import with exact campaign IDs, uploaded it, and ran Preview only. Also prepared and previewed an exact-ID edit of the existing Austin call asset. Never clicked Apply on either failed preview.

## 2. Why

Approved destination: 979-232-5139 for Austin, Houston, and San Antonio furniture Search ads. 737-290-6129 must remain the private Telnyx forwarding destination. The visible call asset still advertises 737-290-6129, a P1 public-contact and attribution mismatch. No booking/payment/payout logic is involved.

## 3. Files involved

- google-ads-call-assets-2026-09-05.csv: three create rows, now includes campaign IDs.
- google-ads-call-asset-edit-2026-09-05.csv: one exact-ID edit row.
- This internal evidence record.
- Downloaded Google result: C:/Users/tgbiz/Downloads/google-ads-call-assets-2026-09-05_RESULTS.csv.

## 4. What was not changed

Budgets, bidding, campaign statuses, ads, images, Telnyx forwarding, website source, payment/payout behavior, and deployment. No asset was paused or deleted during these attempts. No support request has been submitted.

## 5. Validation performed

Account: 293-675-5780, assembleatease@gmail.com. Edge upload permission now works; missing upload permission is no longer the blocker.

| Target | Verified identifier | Preview result |
|---|---|---|
| Austin furniture Search | 23801977873 | Failed |
| Houston furniture Search | 24208421733 | Failed |
| San Antonio furniture Search | 24219606707 | Failed |
| Existing Austin call asset | 414074546163 | Failed |

Three-row corrected preview: September 5, 2026, 8:39:03-8:39:06 PM Central. Changes 3, Successful 0, Errors 3. Every row says "An error occurred. Please try again later.;Item not found" in Google's downloaded CSV. Execution ID 2233615699586750849.

One-row exact-ID edit preview: September 5, 2026, 8:41:13-8:41:18 PM Central. Changes 1, Successful 0, Errors 1. Error: "An error occurred. Please try again later." There is no Item not found error on this exact-ID edit. Execution ID 8166907318724315655. Visually verified the failure screenshot.

Fresh all-level Call association table: exactly one saved association, Austin, 737-290-6129, Enabled, Eligible, last updated August 27, 2026, 4:25 PM. The Use existing extension picker also contains exactly one call asset, 737-290-6129; no unattached 979 asset exists in that picker. Existing asset editor shows reporting on, recording off, conversion action Use account settings (Calls from ads).

Campaign table confirms all three furniture Search campaigns Enabled with $5/day each ($15/day total). Removed legacy Smart campaign is untouched.

## 6. Remaining warnings / next step

FAIL: public Google Ads call number correction remains unpublished. The repeated generic validation failure is unresolved; the evidence does not establish a specific backend cause. The same error occurs through standard UI edits/creation and official bulk previews. Do not keep repeating the same failed save or describe this as propagation delay.

Ask the user for authority to send account/campaign/asset IDs, intended phone, timestamps, and the error report to Google Ads support. External coordination has not yet been authorized. Support should investigate why valid call-asset creation and an exact existing-asset edit are rejected. After Google resolves it, preview the three-city correction again, apply only an error-free preview, and verify persisted associations after reload before announcing success. Preserve a working call route until replacement eligibility is confirmed.

The earlier furniture photo work is separately verified in google-ads-image-alignment-2026-09-05.md and is not undone by this phone failure.

## 7. Deployment

No website deployment is needed or authorized by this upload operation. Do not commit or push unrelated files. The failed previews are not safe to apply.

## Reference

Google's supported bulk-upload format: https://support.google.com/google-ads/answer/10702623?hl=en

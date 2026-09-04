import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const profile = await readFile(new URL('../assembler/profile.html', import.meta.url), 'utf8');
const tierStatus = await readFile(new URL('../api/assembler/tier-status.js', import.meta.url), 'utf8');

const initialReveal = profile.indexOf('if (APP.isPrivateSessionCurrent(currentUserId)) APP.revealPrivatePage();');
const initialWait = profile.indexOf('await waitForStableProfilePaint([');

assert.ok(initialWait > -1, 'Profile must wait for its first stable data paint');
assert.ok(initialReveal > initialWait, 'Profile must reveal only after its first stable data paint');
assert.match(profile, /var proPathPromise = renderProPath\(session\.access_token\)/);
assert.match(profile, /assets\/js\/app\.js\?v=20260818a/);
assert.match(profile, /performancePromise,[\s\S]*proPathPromise,[\s\S]*membershipPromise,[\s\S]*reviewsPromise/);
assert.doesNotMatch(profile, /scrubDerivedProfileUI/);
assert.match(profile, /window\.addEventListener\('pagehide',[\s\S]*event\.persisted[\s\S]*classList\.add\('easer-booting'\)/);
assert.match(profile, /window\.addEventListener\('pageshow', async function\(event\)[\s\S]*await refreshDerivedProfileData\(\)[\s\S]*APP\.revealPrivatePage\(\)/);

// Profile labels describe exactly what the canonical earnings summary returns.
assert.match(profile, />Completed<\/div>/);
assert.match(profile, />Earned<\/div>/);
assert.match(profile, /summary\.completed_jobs/);
assert.match(profile, /summary\.total_earned_cents/);
assert.doesNotMatch(profile, />Lifetime<\/div>/);

// Completion is profile-data completeness only; readiness and payout state are
// intentionally kept out of this percentage.
for (const profileField of ['Name', 'Phone', 'City', 'ZIP', 'Photo']) {
  assert.match(profile, new RegExp(`label: '${profileField}'`));
}
assert.doesNotMatch(profile, /const checks = \[[\s\S]{0,600}(identity|agreement|payout|availability)/i);

// The summary follows the field-worker scan order and reviews stay concise.
assert.ok(
  profile.indexOf('id="basic-summary-location"') < profile.indexOf('id="basic-summary-phone"'),
  'location must appear before phone in the collapsed Basic Information summary',
);
assert.match(profile, /reviewList\.slice\(0, 2\)\.map/);

// Pro Path shows one tier label, honest no-rating states, and no internal-role
// language. Account support and closure consequences remain directly visible.
assert.match(profile, /You’re at the highest tier/);
assert.match(profile, /Maintain strong performance and reliable service/);
assert.match(profile, /t\.rating == null \? '—'/);
assert.match(profile, /Acceptance: '[\s\S]*t\.acceptanceRate == null \? '—'/);
assert.match(profile, /Completion: '[\s\S]*t\.completionRate == null \? 'No scored misses'/);
assert.doesNotMatch(profile, /You’re at the top — Elite Pro/);
assert.match(profile, /id="profile-support"/);
assert.match(profile, /mailto:service@assembleatease\.com/);
assert.match(profile, /tel:\+19792325139/);
assert.match(profile, /Closure is not immediate/);
assert.match(profile, /Existing scheduled jobs must be completed or reassigned/);
assert.match(profile, /outstanding payouts must be resolved/);
assert.match(profile, /records may be retained as required/);
assert.doesNotMatch(tierStatus, /owner call|⭐/i);

console.log('Easer profile stable first-paint and back-navigation checks: PASS');

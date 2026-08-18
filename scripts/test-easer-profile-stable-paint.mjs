import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const profile = await readFile(new URL('../assembler/profile.html', import.meta.url), 'utf8');

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

console.log('Easer profile stable first-paint and back-navigation checks: PASS');

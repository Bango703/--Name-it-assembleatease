#!/usr/bin/env node
// Both iPhone apps in Spanish (owner, 2026-11-21: "yes spanish"). Swift is not
// compiled here; Codemagic does that. This guard holds what can drift silently:
//   - every phrase the apps show has Spanish, from one dictionary, with the same
//     placeholders as the English (a wrong placeholder crashes or garbles a screen)
//   - the catalogs are built into both apps, and iOS is told Spanish exists
//   - what must stay English does: messages a person sends to someone else, values
//     the server reads, and the signature lines on the English contract
//   - dates follow the app's language; money keeps the website's "$45.00"

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { IOS_APPS, requiredKeys, placeholders, keyFor } from './lib/ios-strings.mjs';
import { findCustomerLanguageViolations } from '../api/_customer-language.js';

const read = (f) => readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

// ── 1. The catalogs are current and complete ────────────────────────────────
execFileSync(process.execPath, ['scripts/build-ios-strings.mjs', '--check'], { stdio: 'pipe' });
const dictionary = JSON.parse(read('mobile/ios/Localization/es.json'));

// The key format is the one iOS uses (spot checks against Apple's rules).
assert.equal(keyFor([{ text: 'Booking ' }, { expr: 'done.ref' }]).key, 'Booking %@');
assert.equal(keyFor([{ text: 'Crew of ' }, { expr: 'job.crewSize' }]).key, 'Crew of %lld');
assert.equal(keyFor([{ text: 'Instant fee (' }, { expr: 'String(format: "%g", quote.feePct)' }, { text: '%)' }]).key, 'Instant fee (%@%%)', 'a literal % doubles once the phrase has an argument');
assert.equal(keyFor([{ text: '100% done' }]).key, '100% done', 'and stays single without one');
assert.ok(keyFor([{ text: 'x ' }, { expr: 'someNewValue' }]).error, 'an interpolation of unknown type fails instead of guessing');
assert.deepEqual(placeholders('%1$@ y %2$lld'), placeholders('%@ and %lld'), 'positional and plain placeholders compare equal');

for (const [app, spec] of Object.entries(IOS_APPS)) {
  const catalog = JSON.parse(read(spec.catalog));
  const { keys } = requiredKeys(app);
  for (const key of keys.keys()) {
    if (Object.hasOwn(dictionary.keepEnglish, key)) continue;
    assert.ok(catalog.strings[key]?.localizations?.es?.stringUnit?.state === 'translated', `${spec.name}: "${key}" is in the catalog`);
  }
  assert.ok(Object.keys(catalog.strings).length > 200, `${spec.name}: the catalog was not emptied`);
}

// ── 2. Built into both apps ─────────────────────────────────────────────────
{
  const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  for (const name of ['Localizable.xcstrings', 'InfoPlist.xcstrings']) {
    assert.match(pbx, new RegExp(`/\\* ${name.replace('.', '\\.')} \\*/ = \\{isa = PBXFileReference; lastKnownFileType = text\\.json\\.xcstrings; path = ${name.replace('.', '\\.')};`), `Easer: ${name} is in the project`);
    const resources = pbx.slice(pbx.indexOf('/* Begin PBXResourcesBuildPhase section */'), pbx.indexOf('/* End PBXResourcesBuildPhase section */'));
    assert.ok(resources.includes(`/* ${name} in Resources */`), `Easer: ${name} is copied into the app`);
  }
  assert.match(pbx, /knownRegions = \(\s*en,\s*es,\s*Base,\s*\);/, 'Easer: Spanish is a project language');
  // XcodeGen adds every file under Customer/ and reads the languages from the catalog itself.
  const project = read('mobile/ios/Customer/project.yml');
  assert.match(project, /sources:\s*\n\s*- path: Customer\n/, 'Customer: the catalogs sit in a folder XcodeGen compiles');
  assert.ok(IOS_APPS.customer.catalog.startsWith('mobile/ios/Customer/Customer/'));
  for (const plist of [IOS_APPS.easer.infoPlist, IOS_APPS.customer.infoPlist]) {
    assert.match(read(plist), /<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>en<\/string>\s*<string>es<\/string>\s*<\/array>/, `${plist}: English and Spanish declared`);
  }
}

// ── 3. What stays English ───────────────────────────────────────────────────
{
  const easerViews = read('mobile/ios/App/App/EaserViews.swift');
  const easerStore = read('mobile/ios/App/App/EaserStore.swift');
  const customerViews = read('mobile/ios/Customer/Customer/CustomerViews.swift');
  // Quick replies are the person's own message to someone who may not read Spanish.
  assert.match(easerViews, /\["On my way\.", "I'm outside\.", "Running about 10 minutes late\./, 'Easer quick replies are sent as written');
  assert.match(customerViews, /\["I'm home and ready\.", "Running a few minutes behind\./, 'customer quick replies are sent as written');
  assert.match(easerStore, /"body": "Running about \\\(minutes\) minutes late\. I'm on my way\."/, 'the running-late text reaches the customer in English');
  // The server and the owner read these in English; the screen shows them translated.
  assert.match(easerStore, /\("job_issue", "Problem with the job"\)/, 'help topics are sent in English');
  assert.match(easerStore, /\?\.title \?\? "Help request"/);
  assert.match(easerStore, /static let releaseReasons = \["Emergency", "Vehicle issue"/, 'drop-job reasons are sent in English');
  assert.match(easerViews, /Text\(item\.title\.localizedDisplay\)/, 'and shown in Spanish');
  assert.match(easerViews, /Text\(\$0\.localizedDisplay\)\.tag\(\$0\)/);
  assert.match(easerStore, /\$0 == "Availability enabled"/, 'server values are compared as the server sends them');
  // The signature on the English contract.
  for (const line of Object.keys(dictionary.keepEnglish)) assert.ok(easerViews.includes(`Text("${line}")`), `kept in English: ${line.slice(0, 50)}`);
  assert.ok(Object.keys(dictionary.keepEnglish).every((k) => /Contractor Agreement|Code of Conduct/.test(k)), 'only the contract signature stays English');
}

// ── 4. Dates follow the app's language; money does not ──────────────────────
{
  const foundation = read('mobile/ios/Shared/AppFoundation.swift');
  assert.match(foundation, /language\.hasPrefix\("es"\) \? "es_US" : "en_US"/);
  assert.equal((foundation.match(/f\.locale = AppLocale\.current/g) || []).length, 4, 'day, clock and both chat formats follow the app language');
  assert.match(foundation, /f\.currencyCode = "USD"\n\s*f\.locale = Locale\(identifier: "en_US"\)/, 'money stays $45.00 in both languages');
  assert.match(foundation, /var localizedDisplay: String \{\n\s*Bundle\.main\.localizedString\(forKey: self, value: self, table: nil\)/, 'a plain lookup: text with % is safe');
}

// ── 5. The Spanish is customer-safe and on-brand ────────────────────────────
{
  const customerKeys = requiredKeys('customer').keys;
  for (const key of customerKeys.keys()) {
    const es = dictionary.strings[key];
    if (!es) continue;
    const found = findCustomerLanguageViolations(es);
    assert.deepEqual(found, [], `customer Spanish "${es}" uses an internal term`);
  }
  for (const value of Object.values(dictionary.strings)) {
    assert.ok(!/\b(barato|baratísimo|descuento|ganga|oferta barata)\b/i.test(value), `premium positioning: "${value}"`);
    assert.ok(!/\bTravis\b/.test(value), 'business voice, never the founder');
  }
  // One thing, one name: the tabs and buttons other phrases point to are named the same way.
  assert.equal(dictionary.strings['Get help'], 'Pedir ayuda');
  assert.ok(dictionary.strings['Use Get help on this job.'].includes(dictionary.strings['Get help']));
  assert.ok(dictionary.strings['Use Forgot password on the sign-in screen.'].includes(dictionary.strings['Forgot password?']));
  assert.ok(dictionary.strings['Your setup steps are on Today.'].includes(dictionary.strings.Today));
  assert.ok(dictionary.strings['Change this any time in Account.'].includes(dictionary.strings.Account));
  assert.ok(dictionary.strings['The booking could not be confirmed. Check Bookings before trying again.'].includes(dictionary.strings.Activity), 'points at the tab that lists bookings');
  // STOP and HELP are the words the text-message service answers to.
  assert.match(dictionary.strings['Message and data rates may apply. Reply STOP to any text to turn texts off.'], /\bSTOP\b/);
  const sms = Object.entries(dictionary.strings).find(([k]) => k.startsWith('Optional: Text me appointment'))[1];
  assert.match(sms, /\bSTOP\b.*\bHELP\b/);
  assert.match(sms, /no es una condición de compra/, 'consent is not a condition of purchase, said in Spanish');
}

console.log(`PASS iOS Spanish: Easer ${Object.keys(JSON.parse(read(IOS_APPS.easer.catalog)).strings).length} and customer ${Object.keys(JSON.parse(read(IOS_APPS.customer.catalog)).strings).length} phrases translated from one dictionary, catalogs built into both apps, messages to others and the contract signature kept in English, dates in the app language.`);

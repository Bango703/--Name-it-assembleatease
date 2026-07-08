import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicCookieConsentBlock, buildPublicCookieScriptTag } from './lib/public-consent.mjs';
import { collectPageFacts, listHtmlPages, writeReportFile } from './lib/page-governance.mjs';
import { ROOT } from './lib/site-governance.mjs';

const HEAD_BOOTSTRAP_PATTERN = /<script>\(function\(\)\{if\(localStorage\.getItem\('cookie-consent'\)==='accepted'\)[\s\S]*?<\/script>\s*/i;
const SHARED_COOKIE_SCRIPT_PATTERN = /<script src="\/assets\/js\/cookie-consent\.js" defer><\/script>\s*/gi;
const STANDALONE_COOKIE_STYLE_PATTERN = /<style>\s*#cookie-banner[\s\S]*?<\/style>\s*/gi;
const INLINE_COOKIE_BLOCK_PATTERN = /<div id="cookie-banner"[\s\S]*?<\/div>\s*<script>[\s\S]*?function acceptCookies[\s\S]*?<\/script>\s*/i;
const INLINE_COOKIE_BANNER_PATTERN = /<div id="cookie-banner"[\s\S]*?<\/div>\s*/i;
const HOMEPAGE_BOOKING_HASH_SCRIPT = `<script>
window.addEventListener('DOMContentLoaded', function () {
  if (window.location.hash === '#booking' && window.AAE && typeof AAE.openBooking === 'function') {
    AAE.openBooking();
  }
});
</script>`;

function syncConsent(relativePath) {
  const absolutePath = join(ROOT, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  let next = original;

  next = next.replace(HEAD_BOOTSTRAP_PATTERN, '');
  next = next.replace(SHARED_COOKIE_SCRIPT_PATTERN, '');
  next = next.replace(STANDALONE_COOKIE_STYLE_PATTERN, '');

  if (relativePath === 'index.html') {
    next = next.replace(INLINE_COOKIE_BLOCK_PATTERN, '');
    if (!next.includes("window.location.hash === '#booking'") && !next.includes('window.location.hash==="#booking"')) {
      next = next.replace('</body>', `${HOMEPAGE_BOOKING_HASH_SCRIPT}\n</body>`);
    }
  } else {
    next = next.replace(INLINE_COOKIE_BLOCK_PATTERN, '');
  }

  next = next.replace(INLINE_COOKIE_BANNER_PATTERN, '');

  const consentBlock = buildPublicCookieConsentBlock();
  if (!next.includes(buildPublicCookieScriptTag())) {
    next = next.replace('</body>', `${consentBlock}\n</body>`);
  }

  if (next === original) return null;
  writeFileSync(absolutePath, next);
  return relativePath;
}

const publicPages = listHtmlPages().filter((pagePath) => collectPageFacts(pagePath).visibility.startsWith('public'));
const changedFiles = [];

for (const pagePath of publicPages) {
  const changed = syncConsent(pagePath);
  if (changed) changedFiles.push(changed);
}

const report = {
  generatedAt: new Date().toISOString(),
  changedFiles,
  changedFileCount: changedFiles.length,
};

writeReportFile('page-public-consent-sync-report.json', `${JSON.stringify(report, null, 2)}\n`);
writeReportFile(
  'page-public-consent-sync-report.md',
  ['# Public Consent Sync Report', '', `Changed ${changedFiles.length} file(s).`, '', ...changedFiles.map((path) => `- ${path}`)].join('\n') + '\n',
);

console.log(`Synced governed public consent blocks across ${changedFiles.length} file(s).`);

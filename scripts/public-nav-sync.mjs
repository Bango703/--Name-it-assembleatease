import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicNavBlock } from './lib/public-nav.mjs';
import { classifyPage, collectPageFacts, listHtmlPages, writeReportFile } from './lib/page-governance.mjs';
import { ROOT } from './lib/site-governance.mjs';

const NAV_BLOCK_PATTERN = /(?:<a href="#main-content" class="skip-nav"[\s\S]*?<\/a>\s*)?(?:<!-- NAV -->\s*)?<nav class="nav">[\s\S]*?<\/nav>\s*(?:<div class="nav-mobile" id="mobileNav">[\s\S]*?<\/div>\s*(?:<script src="\/assets\/js\/mobile-nav\.js" defer><\/script>|<script>document\.getElementById\('mobileNav'\)[\s\S]*?<\/script>)?\s*)?/i;

function resolveNavOptions(pagePath) {
  const pageType = classifyPage(pagePath);

  if (pagePath === 'index.html') return { variant: 'home', includeSkipNav: false };
  if (pageType === 'blog_index' || pageType === 'blog_article') {
    return { variant: 'blog', includeSkipNav: true, activeHref: pagePath === 'blog/index.html' ? '/blog/' : '' };
  }
  if (pageType === 'flagship_service' || pageType === 'city_service') {
    return { variant: 'service', includeSkipNav: true };
  }
  if (pageType === 'support' || pageType === 'policy' || pageType === 'utility') {
    return { variant: 'support', includeSkipNav: true, activeHref: pagePath === 'track.html' ? '/track' : '' };
  }
  if (pageType === 'pricing') {
    return { variant: 'core', includeSkipNav: true, activeHref: '/pricing' };
  }
  if (pageType === 'business') {
    return { variant: 'core', includeSkipNav: true, activeHref: '/business' };
  }
  if (pagePath === 'about.html') {
    return { variant: 'core', includeSkipNav: true, activeHref: '/about' };
  }
  if (pagePath === 'locations.html') {
    return { variant: 'core', includeSkipNav: true, activeHref: '/locations' };
  }
  return { variant: 'core', includeSkipNav: true };
}

function syncNav(relativePath, options) {
  const absolutePath = join(ROOT, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  if (!NAV_BLOCK_PATTERN.test(original)) {
    throw new Error(`Could not locate public nav block in ${relativePath}`);
  }
  const next = original.replace(NAV_BLOCK_PATTERN, buildPublicNavBlock(options));
  if (next === original) return null;
  writeFileSync(absolutePath, next);
  return relativePath;
}

const publicPages = listHtmlPages().filter((pagePath) => {
  const facts = collectPageFacts(pagePath);
  return facts.visibility.startsWith('public') && facts.path !== 'book.html' && facts.path !== 'assembler/apply.html';
});

const changedFiles = [];

for (const pagePath of publicPages) {
  const changed = syncNav(pagePath, resolveNavOptions(pagePath));
  if (changed) changedFiles.push(changed);
}

const report = {
  generatedAt: new Date().toISOString(),
  changedFiles,
  changedFileCount: changedFiles.length,
};

const shouldWriteReport = !process.argv.includes('--no-report');
if (shouldWriteReport) {
  writeReportFile('page-public-nav-sync-report.json', `${JSON.stringify(report, null, 2)}\n`);
  writeReportFile(
    'page-public-nav-sync-report.md',
    ['# Public Nav Sync Report', '', `Changed ${changedFiles.length} file(s).`, '', ...changedFiles.map((path) => `- ${path}`)].join('\n') + '\n',
  );
}

console.log(`Synced governed public nav blocks across ${changedFiles.length} file(s).`);

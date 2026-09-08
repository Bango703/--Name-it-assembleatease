import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicNavBlock } from './lib/public-nav.mjs';
import { findNavBlock } from './lib/public-nav-block.mjs';
import { classifyPage, collectPageFacts, listHtmlPages, writeReportFile } from './lib/page-governance.mjs';
import { ROOT } from './lib/site-governance.mjs';


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
  return { variant: 'core', includeSkipNav: true };
}

function syncNav(relativePath, options) {
  const absolutePath = join(ROOT, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  const span = findNavBlock(original);
  if (!span) {
    throw new Error(`Could not locate public nav block in ${relativePath}`);
  }
  const next = original.slice(0, span.start) + buildPublicNavBlock(options) + original.slice(span.end);
  if (next === original) return null;
  // A nav rewrite must never change how many elements the page closes. This is
  // the exact failure the old regex shipped, so it is checked every run.
  const divs = html => ((html.match(/<div\b/gi) || []).length - (html.match(/<\/div>/gi) || []).length);
  if (divs(next) !== divs(original)) {
    throw new Error(
      `Nav sync would unbalance <div> tags in ${relativePath} `
      + `(before ${divs(original)}, after ${divs(next)}). Refusing to write.`,
    );
  }
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
  const reportLines = ['# Public Nav Sync Report', '', `Changed ${changedFiles.length} file(s).`];
  if (changedFiles.length) reportLines.push('', ...changedFiles.map((path) => `- ${path}`));
  writeReportFile(
    'page-public-nav-sync-report.md',
    `${reportLines.join('\n')}\n`,
  );
}

console.log(`Synced governed public nav blocks across ${changedFiles.length} file(s).`);

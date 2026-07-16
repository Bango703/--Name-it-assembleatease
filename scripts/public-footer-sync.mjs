import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicFooterBlock } from './lib/public-footer.mjs';
import { classifyPage, collectPageFacts, listHtmlPages, writeReportFile } from './lib/page-governance.mjs';
import { ROOT } from './lib/site-governance.mjs';

const YEAR_SCRIPT_PATTERN = String.raw`<script>document\.getElementById\('year'\)[\s\S]*?<\/script>\s*`;
const FOOTER_BLOCK_PATTERN = new RegExp(
  String.raw`<footer class="footer">[\s\S]*?<\/footer>\s*(?:${YEAR_SCRIPT_PATTERN}){0,3}`,
  'i',
);

function resolveFooterOptions(pagePath) {
  const pageType = classifyPage(pagePath);

  if (pagePath === 'index.html') {
    return {
      variant: 'booking_resources',
      tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and custom setup services.',
    };
  }

  if (pageType === 'blog_index' || pageType === 'blog_article') {
    return {
      variant: 'blog_resources',
      tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services with clear pricing and careful work.',
    };
  }

  if (pageType === 'business') {
    return {
      variant: 'business_compact',
      tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services.',
    };
  }

  if (pagePath === 'bundles.html') {
    return {
      variant: 'service_support',
      tagline: 'Flat-price home setup &mdash; furniture, TV mounting, smart home, office, and whole-room bundles with reviewed local pros.',
    };
  }

  if (pageType === 'flagship_service') {
    return {
      variant: 'service_support',
      tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services across Austin and the surrounding metro.',
    };
  }

  if (pageType === 'city_service') {
    return {
      variant: 'service_support',
      tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, and outdoor assembly with online booking across Texas.',
    };
  }

  return {
    variant: 'booking_resources',
    tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services.',
  };
}

function updateFooter(relativePath, options) {
  const absolutePath = join(ROOT, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  if (!FOOTER_BLOCK_PATTERN.test(original)) {
    throw new Error(`Could not locate footer block in ${relativePath}`);
  }

  const next = original.replace(FOOTER_BLOCK_PATTERN, `${buildPublicFooterBlock(options)}\n`);
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
  const changed = updateFooter(pagePath, resolveFooterOptions(pagePath));
  if (changed) changedFiles.push(changed);
}

const report = {
  generatedAt: new Date().toISOString(),
  changedFiles,
  changedFileCount: changedFiles.length,
};

const shouldWriteReport = !process.argv.includes('--no-report');
if (shouldWriteReport) {
  writeReportFile('page-public-footer-sync-report.json', `${JSON.stringify(report, null, 2)}\n`);
  writeReportFile(
    'page-public-footer-sync-report.md',
    ['# Public Footer Sync Report', '', `Changed ${changedFiles.length} file(s).`, '', ...changedFiles.map((path) => `- ${path}`)].join('\n') + '\n',
  );
}

console.log(`Synced governed public footers across ${changedFiles.length} file(s).`);

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPORT_DIR, ROOT, escapeRegExp, governanceConfig, identityAliases } from './site-governance.mjs';

const EXCLUDED_DIRS = new Set([
  '.claude',
  '.git',
  '.github',
  '.vercel',
  '.vscode',
  '_local_artifacts',
  'api',
  'assets',
  'business-artifacts',
  'functions',
  'images',
  'node_modules',
  'output',
  'tmp',
]);

export const PAGE_TYPE_RULES = {
  home: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'localBusinessSchema', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['trackLink', 'businessLink', 'bookLink'],
  },
  booking: {
    visibility: 'public_conversion',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['trackLink'],
  },
  flagship_service: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'localBusinessSchema', 'currentFacebookLink', 'sitePromoScript', 'bookLink', 'sharedCookieConsent'],
    recommended: ['trackLink', 'businessLink'],
  },
  city_service: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'localBusinessSchema', 'currentFacebookLink', 'sitePromoScript', 'bookLink', 'sharedCookieConsent'],
    recommended: ['trackLink', 'businessLink'],
  },
  pricing: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'localBusinessSchema', 'currentFacebookLink', 'bookLink', 'sharedCookieConsent'],
    recommended: ['trackLink', 'businessLink'],
  },
  business: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'localBusinessSchema', 'currentFacebookLink', 'businessLink', 'sharedCookieConsent'],
    recommended: ['bookLink'],
  },
  blog_index: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['openGraphCore', 'bookLink', 'trackLink'],
  },
  blog_article: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['bookLink', 'trackLink', 'businessLink'],
  },
  core_marketing: {
    visibility: 'public_marketing',
    required: ['title', 'metaDescription', 'canonical', 'openGraphCore', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['bookLink', 'trackLink', 'businessLink'],
  },
  policy: {
    visibility: 'public_support',
    required: ['title', 'metaDescription', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['canonical', 'bookLink', 'trackLink'],
  },
  support: {
    visibility: 'public_support',
    required: ['title', 'metaDescription', 'currentFacebookLink', 'sharedCookieConsent'],
    recommended: ['canonical', 'bookLink', 'trackLink'],
  },
  auth: {
    visibility: 'private_customer',
    required: ['title'],
    recommended: ['metaDescription'],
  },
  assembler_public: {
    visibility: 'public_hiring',
    required: ['title', 'metaDescription', 'sharedCookieConsent'],
    recommended: ['canonical'],
  },
  assembler_portal: {
    visibility: 'private_assembler',
    required: ['title'],
    recommended: ['metaDescription'],
  },
  owner_portal: {
    visibility: 'private_owner',
    required: ['title'],
    recommended: [],
  },
  utility: {
    visibility: 'public_support',
    required: ['title', 'sharedCookieConsent'],
    recommended: ['metaDescription', 'currentFacebookLink'],
  },
  unknown: {
    visibility: 'unknown',
    required: ['title'],
    recommended: ['metaDescription', 'canonical'],
  },
};

const flagshipAustinPages = new Set(governanceConfig.services.flagshipAustinPages);
const locationServicePrefixes = governanceConfig.services.locationServicePrefixes;
const legacyGoogleMapsLinks = identityAliases.googleMaps.filter((value) => value !== governanceConfig.social.googleMaps);
const malformedFacebookLink = governanceConfig.social.facebook.replace(/\/$/, '//');

function toPosixPath(path) {
  return String(path).replace(/\\/g, '/');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractTagValue(html, pattern) {
  const match = html.match(pattern);
  return match ? compactWhitespace(match[1]) : '';
}

function extractJsonLdBlocks(html) {
  const matches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  const blocks = [];
  for (const match of matches) {
    const raw = compactWhitespace(match[1]);
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      blocks.push({ parseError: true, raw });
    }
  }
  return blocks;
}

function collectJsonLdTypes(value, output = new Set()) {
  if (!value || typeof value !== 'object') return output;
  const typeValue = value['@type'];
  if (Array.isArray(typeValue)) {
    for (const item of typeValue) output.add(String(item));
  } else if (typeValue) {
    output.add(String(typeValue));
  }
  if (Array.isArray(value.mainEntity)) {
    for (const item of value.mainEntity) collectJsonLdTypes(item, output);
  }
  return output;
}

export function listHtmlPages(dir = ROOT) {
  const pages = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      if (entry.name === '.well-known') continue;
      if (EXCLUDED_DIRS.has(entry.name)) continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      pages.push(...listHtmlPages(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.html')) {
      pages.push(toPosixPath(relative(ROOT, join(dir, entry.name))));
    }
  }
  return pages.sort();
}

export function classifyPage(pagePath) {
  const path = toPosixPath(pagePath);
  if (path === 'index.html') return 'home';
  if (path === 'book.html') return 'booking';
  if (path === 'pricing.html') return 'pricing';
  if (path === 'business.html') return 'business';
  if (path === '404.html') return 'utility';
  if (path === 'terms.html' || path === 'privacy.html') return 'policy';
  if (path === 'track.html' || path === 'review.html' || path === 'assemblecash.html' || path === 'setup-club.html') return 'support';
  if (path === 'about.html' || path === 'contact.html' || path === 'bundles.html') return 'core_marketing';
  if (path === 'owner/index.html') return 'owner_portal';
  if (path.startsWith('auth/')) return 'auth';
  if (path === 'assembler/apply.html') return 'assembler_public';
  if (path.startsWith('assembler/')) return 'assembler_portal';
  if (path === 'blog/index.html') return 'blog_index';
  if (path.startsWith('blog/')) return 'blog_article';

  const fileName = path.split('/').pop() || path;
  const matchedPrefix = locationServicePrefixes.find((prefix) => fileName.startsWith(`${prefix}-`) && fileName.endsWith('-tx.html'));
  if (matchedPrefix) {
    if (flagshipAustinPages.has(fileName)) return 'flagship_service';
    return 'city_service';
  }

  return 'unknown';
}

export function resolveGeneratorOwners(pagePath, pageType) {
  if (pageType === 'flagship_service') return ['scripts/build-flagship-service-pages.mjs'];
  if (pageType === 'city_service') return ['scripts/generate-location-pages.js', 'scripts/refresh-seo-and-promo-pages.mjs'];
  if (pageType === 'blog_article' || pageType === 'blog_index') return ['manual content', 'scripts/cleanup-blog-pages.mjs'];
  if (pageType === 'home' || pageType === 'pricing' || pageType === 'business' || pageType === 'booking') return ['manual core page'];
  if (pageType === 'core_marketing' || pageType === 'policy' || pageType === 'support') return ['manual marketing page'];
  if (pageType === 'auth') return ['manual auth page'];
  if (pageType === 'assembler_public' || pageType === 'assembler_portal') return ['manual assembler page'];
  if (pageType === 'owner_portal') return ['manual owner page'];
  return ['unmapped'];
}

export function collectPageFacts(pagePath) {
  const absolutePath = join(ROOT, pagePath);
  const html = stripBom(readFileSync(absolutePath, 'utf8'));
  const jsonLdBlocks = extractJsonLdBlocks(html);
  const jsonLdTypes = [...jsonLdBlocks.reduce((set, block) => collectJsonLdTypes(block, set), new Set())].sort();
  const pageType = classifyPage(pagePath);

  const facts = {
    path: toPosixPath(pagePath),
    pageType,
    visibility: PAGE_TYPE_RULES[pageType]?.visibility || 'unknown',
    generatorOwners: resolveGeneratorOwners(pagePath, pageType),
    title: extractTagValue(html, /<title>([\s\S]*?)<\/title>/i),
    h1: extractTagValue(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, ' '),
    metaDescription: extractTagValue(html, /<meta[^>]+name="description"[^>]+content="([^"]*)"/i),
    canonical: extractTagValue(html, /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i),
    ogTitle: extractTagValue(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i),
    ogDescription: extractTagValue(html, /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i),
    ogImage: extractTagValue(html, /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i),
    twitterCard: extractTagValue(html, /<meta[^>]+name="twitter:card"[^>]+content="([^"]*)"/i),
    currentFacebookLinkCount: (html.match(new RegExp(escapeRegExp(governanceConfig.social.facebook), 'g')) || []).length,
    oldFacebookLinkCount: (html.match(new RegExp(escapeRegExp(governanceConfig.social.facebookLegacy), 'g')) || []).length,
    malformedFacebookLinkCount: malformedFacebookLink === governanceConfig.social.facebook
      ? 0
      : (html.match(new RegExp(escapeRegExp(malformedFacebookLink), 'g')) || []).length,
    currentGoogleMapsLinkCount: (html.match(new RegExp(escapeRegExp(governanceConfig.social.googleMaps), 'g')) || []).length,
    oldGoogleMapsLinkCount: legacyGoogleMapsLinks.reduce(
      (count, legacyUrl) => count + ((html.match(new RegExp(escapeRegExp(legacyUrl), 'g')) || []).length),
      0,
    ),
    currentEmailCount: (html.match(new RegExp(escapeRegExp(governanceConfig.business.email), 'g')) || []).length,
    currentPhoneCount: (html.match(new RegExp(escapeRegExp(governanceConfig.business.phoneDisplay), 'g')) || []).length,
    bookLinkCount: (html.match(/href="\/book(?:[?#][^"]*)?"/g) || []).length,
    businessLinkCount: (html.match(/href="\/business(?:[?#][^"]*)?"/g) || []).length,
    trackLinkCount: (html.match(/href="\/track(?:[?#][^"]*)?"/g) || []).length,
    applyLinkCount: (html.match(/href="\/assembler\/apply(?:[?#][^"]*)?"/g) || []).length,
    usesSitePromoScript: html.includes('/assets/js/site-promo.js'),
    usesCookieConsent: html.includes('cookie-consent'),
    usesSharedCookieScript: html.includes('/assets/js/cookie-consent.js'),
    hasCookieBanner: /id="cookie-banner"/i.test(html),
    hasSkipNavLink: /class="skip-nav"/i.test(html),
    hasMainContentTarget: /id="main-content"/i.test(html),
    hasLocalBusinessSchema: jsonLdTypes.includes('LocalBusiness') || jsonLdTypes.includes('HomeAndConstructionBusiness'),
    jsonLdTypes,
  };

  return facts;
}

function addIssue(issues, severity, code, message) {
  issues.push({ severity, code, message });
}

function hasOpenGraphCore(facts) {
  return Boolean(facts.ogTitle && facts.ogDescription && facts.ogImage);
}

function evaluateRequiredRule(rule, facts, issues) {
  if (rule === 'title' && !facts.title) addIssue(issues, 'fail', 'missing_title', 'Title tag is missing.');
  if (rule === 'metaDescription' && !facts.metaDescription) addIssue(issues, 'fail', 'missing_meta_description', 'Meta description is missing.');
  if (rule === 'canonical' && !facts.canonical) addIssue(issues, 'fail', 'missing_canonical', 'Canonical link is missing.');
  if (rule === 'openGraphCore' && !hasOpenGraphCore(facts)) addIssue(issues, 'fail', 'missing_open_graph', 'One or more core Open Graph tags are missing.');
  if (rule === 'localBusinessSchema' && !facts.hasLocalBusinessSchema) addIssue(issues, 'fail', 'missing_localbusiness_schema', 'LocalBusiness/HomeAndConstructionBusiness schema is missing.');
  if (rule === 'currentFacebookLink' && !facts.currentFacebookLinkCount) addIssue(issues, 'fail', 'missing_current_facebook_link', 'Current Facebook Page link is missing.');
  if (rule === 'sitePromoScript' && !facts.usesSitePromoScript) addIssue(issues, 'fail', 'missing_site_promo_script', 'Shared promo script is missing.');
  if (rule === 'bookLink' && !facts.bookLinkCount) addIssue(issues, 'fail', 'missing_book_link', 'Book CTA link is missing.');
  if (rule === 'trackLink' && !facts.trackLinkCount) addIssue(issues, 'fail', 'missing_track_link', 'Track link is missing.');
  if (rule === 'businessLink' && !facts.businessLinkCount) addIssue(issues, 'fail', 'missing_business_link', 'Business link is missing.');
  if (rule === 'sharedCookieConsent' && (!facts.usesSharedCookieScript || !facts.hasCookieBanner)) {
    addIssue(issues, 'fail', 'missing_shared_cookie_consent', 'Shared cookie consent banner or script is missing.');
  }
}

function evaluateRecommendedRule(rule, facts, issues) {
  if (rule === 'metaDescription' && !facts.metaDescription) addIssue(issues, 'warning', 'recommended_meta_description', 'Meta description is recommended for this page type.');
  if (rule === 'canonical' && !facts.canonical) addIssue(issues, 'warning', 'recommended_canonical', 'Canonical link is recommended for this page type.');
  if (rule === 'openGraphCore' && !hasOpenGraphCore(facts)) addIssue(issues, 'warning', 'recommended_open_graph', 'Core Open Graph tags are recommended for this page type.');
  if (rule === 'bookLink' && !facts.bookLinkCount) addIssue(issues, 'warning', 'recommended_book_link', 'A book CTA is recommended for this page type.');
  if (rule === 'trackLink' && !facts.trackLinkCount) addIssue(issues, 'warning', 'recommended_track_link', 'Track link is recommended for this page type.');
  if (rule === 'businessLink' && !facts.businessLinkCount) addIssue(issues, 'warning', 'recommended_business_link', 'Business link is recommended for this page type.');
}

export function auditPageFacts(facts) {
  const rules = PAGE_TYPE_RULES[facts.pageType] || PAGE_TYPE_RULES.unknown;
  const issues = [];

  for (const rule of rules.required) evaluateRequiredRule(rule, facts, issues);
  for (const rule of rules.recommended) evaluateRecommendedRule(rule, facts, issues);

  if (facts.oldFacebookLinkCount) {
    addIssue(issues, 'fail', 'legacy_facebook_link', `Legacy Facebook link still appears ${facts.oldFacebookLinkCount} time(s).`);
  }

  if (facts.malformedFacebookLinkCount) {
    addIssue(issues, 'fail', 'malformed_facebook_link', `Malformed Facebook link still appears ${facts.malformedFacebookLinkCount} time(s).`);
  }

  if (facts.oldGoogleMapsLinkCount) {
    addIssue(issues, 'fail', 'legacy_google_maps_link', `Legacy Google Maps link still appears ${facts.oldGoogleMapsLinkCount} time(s).`);
  }

  if (!facts.currentEmailCount && rules.visibility.startsWith('public')) {
    addIssue(issues, 'warning', 'missing_current_email', 'Current business email is not visible on this public page.');
  }

  if (facts.hasSkipNavLink && !facts.hasMainContentTarget) {
    addIssue(issues, 'fail', 'missing_main_content_target', 'Skip navigation is present but no #main-content target exists.');
  }

  if (
    facts.path.includes('tv-mounting') &&
    /mounting\s*&\s*hanging/i.test(`${facts.title} ${facts.ogTitle} ${facts.h1}`)
  ) {
    addIssue(issues, 'fail', 'legacy_tv_display_label', 'TV Mounting pages should not use "Mounting & Hanging" in customer-facing headings or metadata.');
  }

  if (facts.pageType === 'unknown') {
    addIssue(issues, 'warning', 'unknown_page_type', 'Page type is not mapped yet.');
  }

  const failCount = issues.filter((issue) => issue.severity === 'fail').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    ...facts,
    status: failCount ? 'FAIL' : warningCount ? 'WARNING' : 'PASS',
    failCount,
    warningCount,
    issues,
  };
}

export function collectGovernanceData() {
  const pages = listHtmlPages().map((pagePath) => collectPageFacts(pagePath));
  return pages.map((facts) => auditPageFacts(facts));
}

export function summarizeGovernanceResults(results) {
  const byType = {};
  const byStatus = { PASS: 0, WARNING: 0, FAIL: 0 };
  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] || 0) + 1;
    byType[result.pageType] = (byType[result.pageType] || 0) + 1;
  }
  return {
    totalPages: results.length,
    statusCounts: byStatus,
    pageTypeCounts: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function writeReportFile(fileName, content) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, fileName), content);
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escapeCsv = (value) => {
    if (value == null) return '';
    const stringValue = Array.isArray(value) ? value.join('|') : String(value);
    return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(','))].join('\n');
}

export function buildManifestRows(results) {
  return results.map((result) => ({
    path: result.path,
    pageType: result.pageType,
    visibility: result.visibility,
    status: result.status,
    title: result.title,
    canonical: result.canonical,
    generatorOwners: result.generatorOwners,
    usesSitePromoScript: result.usesSitePromoScript,
    currentFacebookLinkCount: result.currentFacebookLinkCount,
    oldFacebookLinkCount: result.oldFacebookLinkCount,
    malformedFacebookLinkCount: result.malformedFacebookLinkCount,
    currentGoogleMapsLinkCount: result.currentGoogleMapsLinkCount,
    oldGoogleMapsLinkCount: result.oldGoogleMapsLinkCount,
    bookLinkCount: result.bookLinkCount,
    businessLinkCount: result.businessLinkCount,
    trackLinkCount: result.trackLinkCount,
    usesSharedCookieScript: result.usesSharedCookieScript,
    hasCookieBanner: result.hasCookieBanner,
    jsonLdTypes: result.jsonLdTypes,
  }));
}

export function buildReportMarkdown(results, summary) {
  const topFailures = results
    .filter((result) => result.status !== 'PASS')
    .slice()
    .sort((a, b) => b.failCount - a.failCount || b.warningCount - a.warningCount || a.path.localeCompare(b.path))
    .slice(0, 20);

  const lines = [
    '# Page Governance Report',
    '',
    `Generated from ${summary.totalPages} HTML pages.`,
    '',
    '## Status Counts',
    '',
    `- PASS: ${summary.statusCounts.PASS}`,
    `- WARNING: ${summary.statusCounts.WARNING}`,
    `- FAIL: ${summary.statusCounts.FAIL}`,
    '',
    '## Page Types',
    '',
    ...Object.entries(summary.pageTypeCounts).map(([pageType, count]) => `- ${pageType}: ${count}`),
    '',
    '## Highest-Risk Pages',
    '',
  ];

  if (!topFailures.length) {
    lines.push('- No current failures or warnings.');
  } else {
    for (const result of topFailures) {
      lines.push(`- ${result.path} — ${result.status} (${result.failCount} fail, ${result.warningCount} warning)`);
      for (const issue of result.issues.slice(0, 4)) {
        lines.push(`  - ${issue.severity.toUpperCase()}: ${issue.message}`);
      }
    }
  }

  lines.push('', '## Output Files', '', '- `page-manifest.json`', '- `page-manifest.csv`', '- `page-governance-report.md`', '- `page-governance-findings.json`', '- `page-governance-findings.md`');
  return `${lines.join('\n')}\n`;
}

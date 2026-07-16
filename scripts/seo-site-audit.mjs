import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const BASE_URL = 'https://www.assembleatease.com';
const SERVICE_PREFIXES = [
  'furniture-assembly',
  'tv-mounting',
  'smart-home-installation',
  'fitness-equipment-assembly',
  'office-furniture-assembly',
  'playset-assembly',
];
const SERVICE_CONTENT_RULES = {
  'furniture-assembly': { heading: 'Furniture assembly planning', terms: ['furniture assembly service', 'furniture installation', 'IKEA assembly', 'bed assembly', 'crib assembly', 'dresser assembly', 'wardrobe assembly', 'sofa assembly', 'desk assembly'] },
  'tv-mounting': { heading: 'TV mounting planning', terms: ['TV mounting service', 'TV wall mounting', 'TV installation', 'soundbar mounting', 'cord concealment'] },
  'smart-home-installation': { heading: 'Smart home installation planning', terms: ['smart home installation service', 'video doorbell installation', 'smart thermostat installation', 'security camera setup', 'smart lock installation'] },
  'fitness-equipment-assembly': { heading: 'Fitness equipment assembly planning', terms: ['fitness equipment assembly service', 'gym equipment assembly', 'treadmill assembly', 'elliptical assembly', 'squat rack assembly', 'home gyms'] },
  'office-furniture-assembly': { heading: 'Office furniture assembly planning', terms: ['office furniture assembly service', 'installation', 'standing desk assembly', 'conference table assembly', 'workstation setups'] },
  'playset-assembly': { heading: 'Playset and outdoor assembly planning', terms: ['playset assembly service', 'playset installation', 'swing set assembly', 'trampoline assembly', 'playground assembly', 'gazebo', 'shed assembly', 'outdoor furniture assembly'] },
};
const SERVICE_PAGE_RE = new RegExp(`^(${SERVICE_PREFIXES.join('|')})-([a-z-]+)-tx\\.html$`);
const EXCLUDED_DIRS = new Set(['.git', '.vercel', 'api', 'assets', 'business-artifacts', 'functions', 'images', 'node_modules', 'output', 'tmp']);
const RETIRED_ROUTES = ['/repairs', '/junk', '/blog/junk-removal-cost-austin', '/blog/home-repairs-diy-vs-hire-austin'];
const ENTITY_PROFILES = [
  'https://www.google.com/maps?cid=7847022131459448801',
  'https://www.facebook.com/people/Assembleatease/61572042722009/',
  'https://www.yelp.com/biz/assembleatease-austin',
  'https://local.yahoo.com/info-233982268-assembleatease-austin/',
];

function listHtmlFiles(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        files.push(...listHtmlFiles(join(dir, entry.name)));
      }
      continue;
    }
    if (entry.name.endsWith('.html')) files.push(join(dir, entry.name));
  }
  return files;
}

function extractOne(html, pattern) {
  return html.match(pattern)?.[1]?.replace(/\s+/g, ' ').trim() || '';
}

function visibleText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|ndash|mdash|rsquo|quot);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function routeForFile(file) {
  const path = relative(ROOT, file).replaceAll('\\', '/');
  if (path === 'index.html') return '/';
  if (path.endsWith('/index.html')) return `/${path.slice(0, -'/index.html'.length)}`;
  return `/${path.slice(0, -'.html'.length)}`;
}

function routeTargetExists(pathname, routes) {
  if (routes.has(pathname)) return true;
  const withoutSlash = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (routes.has(withoutSlash)) return true;
  const filePath = join(ROOT, decodeURIComponent(pathname).replace(/^\/+/, ''));
  return existsSync(filePath);
}

function collectJsonLd(html, page, issues) {
  const blocks = [];
  for (const match of html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch (error) {
      issues.push(`${page}: invalid JSON-LD (${error.message})`);
    }
  }
  return blocks;
}

function addDuplicateIssues(records, key, label, issues) {
  const values = new Map();
  for (const record of records) {
    const value = record[key];
    if (!value) continue;
    const pages = values.get(value) || [];
    pages.push(record.page);
    values.set(value, pages);
  }
  for (const [value, pages] of values) {
    if (pages.length > 1) issues.push(`Duplicate ${label} on ${pages.join(', ')}: ${value}`);
  }
}

const issues = [];
const htmlFiles = listHtmlFiles();
const routes = new Set(htmlFiles.map(routeForFile));
const serviceFiles = htmlFiles.filter((file) => SERVICE_PAGE_RE.test(relative(ROOT, file).replaceAll('\\', '/')));
const serviceRoutes = new Set(serviceFiles.map(routeForFile));
const sitemap = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
const robots = readFileSync(join(ROOT, 'robots.txt'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const sitemapUrls = [...sitemap.matchAll(/<loc>(https:\/\/www\.assembleatease\.com[^<]*)<\/loc>/g)].map((match) => match[1]);
const sitemapSet = new Set(sitemapUrls);
const sitemapLastmods = new Map(
  [...sitemap.matchAll(/<url>\s*<loc>(https:\/\/www\.assembleatease\.com[^<]*)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
    .map((match) => [match[1], match[2]]),
);
const inboundLinks = new Map([...serviceRoutes].map((route) => [route, new Set()]));
const records = [];
const cityServices = new Map();
const localContextsByService = new Map(SERVICE_PREFIXES.map((prefix) => [prefix, new Map()]));

if (sitemapUrls.length !== sitemapSet.size) issues.push('sitemap.xml contains duplicate URLs.');
if (!sitemap.trimEnd().endsWith('</urlset>')) issues.push('sitemap.xml does not end with </urlset>.');
if (/^\s*Disallow:\s*\/auth\//im.test(robots)) issues.push('robots.txt blocks /auth/, preventing crawlers from observing auth-page noindex directives.');

for (const file of htmlFiles.filter((candidate) => relative(ROOT, candidate).replaceAll('\\', '/').startsWith('auth/'))) {
  if (!/<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>/i.test(readFileSync(file, 'utf8'))) {
    issues.push(`${relative(ROOT, file)}: auth page must declare noindex, nofollow.`);
  }
}

for (const route of RETIRED_ROUTES) {
  if (routeTargetExists(route, routes)) issues.push(`${route}: retired service route still has a backing file.`);
  if ((vercelConfig.redirects || []).some((redirect) => redirect.source === route)) {
    issues.push(`${route}: retired service route must return 404 instead of redirecting to unrelated content.`);
  }
  if (sitemapSet.has(`${BASE_URL}${route}`)) issues.push(`${route}: retired service route remains in sitemap.xml.`);
}

for (const page of ['index.html', 'about.html']) {
  const jsonLd = collectJsonLd(readFileSync(join(ROOT, page), 'utf8'), page, issues);
  const organization = jsonLd.find((item) => item['@type'] === 'Organization');
  if (!organization) {
    issues.push(`${page}: missing Organization JSON-LD.`);
    continue;
  }
  if (ENTITY_PROFILES.some((profile) => !organization.sameAs?.includes(profile))) issues.push(`${page}: Organization schema is missing a verified entity profile.`);
  if (organization.areaServed?.name !== 'Texas') issues.push(`${page}: Organization schema is missing the Texas service area.`);
  if (organization.contactPoint?.hoursAvailable?.length !== 2) issues.push(`${page}: Organization schema is missing customer-service hours.`);
}

for (const file of htmlFiles) {
  const sourceRoute = routeForFile(file);
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = match[1];
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const pathname = new URL(href.replaceAll('&amp;', '&'), BASE_URL).pathname;
    if (serviceRoutes.has(pathname) && pathname !== sourceRoute) inboundLinks.get(pathname).add(sourceRoute);
  }
}

for (const file of serviceFiles) {
  const page = relative(ROOT, file).replaceAll('\\', '/');
  const route = routeForFile(file);
  const match = page.match(SERVICE_PAGE_RE);
  const servicePrefix = match[1];
  const citySlug = match[2];
  const html = readFileSync(file, 'utf8');
  const expectedUrl = `${BASE_URL}${route}`;
  const title = extractOne(html, /<title>([\s\S]*?)<\/title>/i);
  const description = extractOne(html, /<meta[^>]+name="description"[^>]+content="([^"]*)"/i);
  const canonical = extractOne(html, /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i);
  const ogUrl = extractOne(html, /<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i);
  const ogImage = extractOne(html, /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i);
  const twitterCard = extractOne(html, /<meta[^>]+name="twitter:card"[^>]+content="([^"]*)"/i);
  const h1Matches = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h1 = visibleText(h1Matches[0]?.[1]);
  const body = visibleText(html);
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const jsonLd = collectJsonLd(html, page, issues);
  const schemasByType = (type) => jsonLd.filter((block) => block?.['@type'] === type);
  const serviceSchemas = schemasByType('Service');
  const breadcrumbSchemas = schemasByType('BreadcrumbList');
  const faqSchemas = schemasByType('FAQPage');
  const serviceSchema = serviceSchemas[0];
  const cityName = serviceSchema?.areaServed?.name || '';
  const contextMarker = `Planning your ${cityName} appointment:`;
  const localContext = visibleText(extractOne(
    html,
    /<strong[^>]*>Planning your [^<]+ appointment:<\/strong>\s*([^<]+)<\/p>/i,
  ));
  const normalizedLocalContext = localContext.toLowerCase().replaceAll(cityName.toLowerCase(), '{city}');
  const contextPages = localContextsByService.get(servicePrefix).get(normalizedLocalContext) || [];
  contextPages.push(page);
  localContextsByService.get(servicePrefix).set(normalizedLocalContext, contextPages);
  const citySet = cityServices.get(citySlug) || new Set();
  citySet.add(servicePrefix);
  cityServices.set(citySlug, citySet);

  records.push({ page, title, description, canonical, h1, body });

  if (!title) issues.push(`${page}: missing title.`);
  if (!description) issues.push(`${page}: missing meta description.`);
  if (title.length < 45 || title.length > 85) issues.push(`${page}: title length is ${title.length}; expected 45-85 characters.`);
  if (description.length < 110 || description.length > 165) issues.push(`${page}: meta description length is ${description.length}; expected 110-165 characters.`);
  if (canonical !== expectedUrl) issues.push(`${page}: canonical is not self-referencing (${canonical || 'missing'}).`);
  if (ogUrl !== expectedUrl) issues.push(`${page}: og:url does not match its canonical.`);
  if (!ogImage || /\/images\/logo\.(?:jpg|webp|png)$/i.test(ogImage)) issues.push(`${page}: social preview must use a service image, not the logo.`);
  if (twitterCard !== 'summary_large_image') issues.push(`${page}: twitter card must use summary_large_image.`);
  if (h1Matches.length !== 1 || !h1) issues.push(`${page}: expected exactly one non-empty H1.`);
  if (wordCount < 575) issues.push(`${page}: visible content is thin (${wordCount} words).`);
  if (/name="robots"[^>]+noindex/i.test(html)) issues.push(`${page}: service page is marked noindex.`);
  if (!sitemapSet.has(expectedUrl)) issues.push(`${page}: missing from sitemap.xml.`);
  const lastmod = sitemapLastmods.get(expectedUrl) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod) || Number.isNaN(Date.parse(`${lastmod}T00:00:00Z`))) {
    issues.push(`${page}: sitemap entry has a missing or invalid lastmod date.`);
  }
  if (serviceSchemas.length !== 1) issues.push(`${page}: expected exactly one Service JSON-LD block.`);
  if (breadcrumbSchemas.length !== 1) issues.push(`${page}: expected exactly one BreadcrumbList JSON-LD block.`);
  if (faqSchemas.length !== 1) issues.push(`${page}: expected exactly one FAQPage JSON-LD block.`);
  if (!serviceSchema) {
    issues.push(`${page}: missing Service JSON-LD.`);
  } else {
    if (serviceSchema.url !== expectedUrl) issues.push(`${page}: Service schema URL does not match canonical.`);
    if (!cityName || serviceSchema.areaServed?.containedInPlace?.name !== 'Texas') {
      issues.push(`${page}: Service schema has incomplete city/Texas areaServed data.`);
    }
  }
  const breadcrumbItems = breadcrumbSchemas[0]?.itemListElement || [];
  if (breadcrumbItems.length !== 3 || breadcrumbItems.at(-1)?.item !== expectedUrl) {
    issues.push(`${page}: breadcrumb schema must end at the canonical service page.`);
  }
  const faqEntities = faqSchemas[0]?.mainEntity || [];
  if (faqEntities.length < 4) issues.push(`${page}: FAQ schema must contain at least four visible questions.`);
  if (!faqEntities.some((entity) => /\bcost\b/i.test(entity?.name || '') && (entity?.name || '').includes(cityName))) {
    issues.push(`${page}: FAQ schema is missing its city-specific cost question.`);
  }
  if (!h1.includes(cityName)) issues.push(`${page}: H1 does not include schema city ${cityName || '(missing)'}.`);
  if (!title.includes(cityName)) issues.push(`${page}: title does not include schema city ${cityName || '(missing)'}.`);
  if (!description.includes(cityName)) issues.push(`${page}: description does not include schema city ${cityName || '(missing)'}.`);
  if (!html.includes(contextMarker)) issues.push(`${page}: missing city-specific appointment guidance.`);
  if (localContext.split(/\s+/).filter(Boolean).length < 25) issues.push(`${page}: city appointment context is too thin.`);
  const contentRule = SERVICE_CONTENT_RULES[servicePrefix];
  if (!body.includes(`${contentRule.heading} in ${cityName}`)) issues.push(`${page}: missing researched service planning heading.`);
  for (const term of contentRule.terms) {
    if (!body.toLowerCase().includes(term.toLowerCase())) issues.push(`${page}: missing researched service intent "${term}".`);
  }
  if (citySlug !== 'austin' && new RegExp(`Done in ${cityName}`, 'i').test(html)) {
    issues.push(`${page}: claims the example project was completed in the target city.`);
  }

  const otherServiceLinks = SERVICE_PREFIXES
    .filter((prefix) => prefix !== servicePrefix)
    .filter((prefix) => html.includes(`href="/${prefix}-${citySlug}-tx"`));
  if (otherServiceLinks.length !== SERVICE_PREFIXES.length - 1) {
    issues.push(`${page}: same-city service cluster has ${otherServiceLinks.length}/5 cross-links.`);
  }

  for (const hrefMatch of html.matchAll(/href="([^"]+)"/gi)) {
    const href = hrefMatch[1];
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) continue;
    const pathname = new URL(href.replaceAll('&amp;', '&'), BASE_URL).pathname;
    if (!routeTargetExists(pathname, routes)) issues.push(`${page}: broken internal link ${href}.`);
  }
}

for (const [city, services] of cityServices) {
  const missing = SERVICE_PREFIXES.filter((prefix) => !services.has(prefix));
  if (missing.length) issues.push(`${city}: missing service pages for ${missing.join(', ')}.`);
}

for (const [service, contexts] of localContextsByService) {
  for (const [context, pages] of contexts) {
    if (!context || pages.length < 2) continue;
    issues.push(`${service}: duplicated normalized city appointment context on ${pages.join(', ')}.`);
  }
}

for (const [route, sources] of inboundLinks) {
  if (!sources.size) issues.push(`${route}: service page has no inbound internal link.`);
}

for (const url of sitemapUrls) {
  const pathname = new URL(url).pathname;
  if (SERVICE_PREFIXES.some((prefix) => pathname.startsWith(`/${prefix}-`)) && !serviceRoutes.has(pathname)) {
    issues.push(`sitemap.xml references missing service page ${url}.`);
  }
}

addDuplicateIssues(records, 'title', 'title', issues);
addDuplicateIssues(records, 'description', 'meta description', issues);
addDuplicateIssues(records, 'canonical', 'canonical', issues);
addDuplicateIssues(records, 'h1', 'H1', issues);
addDuplicateIssues(records, 'body', 'visible body', issues);

if (issues.length) {
  console.error(`SEO audit failed with ${issues.length} issue(s):`);
  for (const issue of [...new Set(issues)]) console.error(`- ${issue}`);
  process.exit(1);
}

const inboundCounts = [...inboundLinks.values()].map((sources) => sources.size);
console.log(`SEO audit passed: ${serviceFiles.length} service pages across ${cityServices.size} cities.`);
console.log(`Sitemap URLs: ${sitemapUrls.length}; service URLs: ${serviceRoutes.size}.`);
console.log(`Inbound links per service page: min ${Math.min(...inboundCounts)}, max ${Math.max(...inboundCounts)}.`);
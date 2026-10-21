// Which public URLs a set of changed files affects, for IndexNow. Only pages in
// the sitemap (now, or before the change for a removed page) are sent, so
// private pages and assets never reach a search engine.
export const ORIGIN = 'https://www.assembleatease.com';

export function sitemapUrlsFromXml(xml) {
  return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

// URLs whose <lastmod> differs between two versions of the sitemap.
export function lastmodChanges(xml, previousXml) {
  const entries = (s) => new Map([...String(s || '').matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => [
    ((m[1].match(/<loc>([^<]+)<\/loc>/) || [])[1] || '').trim(),
    ((m[1].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || '').trim(),
  ]));
  const now = entries(xml);
  const before = entries(previousXml);
  return [...now].filter(([url, mod]) => url && before.has(url) && before.get(url) !== mod).map(([url]) => url);
}

export function urlForFile(file) {
  const f = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!f.endsWith('.html')) return null;
  if (f === 'index.html') return `${ORIGIN}/`;
  const path = f.endsWith('/index.html') ? f.slice(0, -'/index.html'.length) : f.slice(0, -'.html'.length);
  return `${ORIGIN}/${path}`;
}

export function urlsForChangedFiles(files, sitemapUrls, previousSitemapUrls = []) {
  const known = new Set([...sitemapUrls, ...previousSitemapUrls]);
  const out = new Set();
  for (const file of files) {
    const url = urlForFile(file);
    if (url && known.has(url)) out.add(url);
  }
  // A page added to or dropped from the sitemap is a change even if its file is not.
  const now = new Set(sitemapUrls);
  const before = new Set(previousSitemapUrls);
  if (previousSitemapUrls.length) {
    for (const u of now) if (!before.has(u)) out.add(u);
    for (const u of before) if (!now.has(u)) out.add(u);
  }
  return [...out].sort();
}

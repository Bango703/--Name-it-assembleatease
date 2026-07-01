import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export const SITE = 'https://www.assembleatease.com';

function blogDir() {
  return join(process.cwd(), 'blog');
}

export function listBlogArticles() {
  const dir = blogDir();
  const files = readdirSync(dir).filter((file) => file.endsWith('.html') && file !== 'index.html');
  return files
    .map((file) => {
      const slug = file.replace(/\.html$/, '');
      const filePath = join(dir, file);
      const title = extractTitle(filePath);
      const stats = safeStat(filePath);
      return {
        slug,
        title,
        url: `${SITE}/blog/${slug}`,
        imageUrl: extractImageUrl(filePath, { slug, title }),
        filePath,
        updatedAt: stats?.mtime?.toISOString?.() || null,
      };
    })
    .sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return String(a.slug).localeCompare(String(b.slug));
    });
}

export function readBlogArticle(slug) {
  const clean = String(slug || '').replace(/[^a-z0-9-]/gi, '');
  if (!clean) return null;
  return listBlogArticles().find((article) => article.slug === clean) || null;
}

export function extractTitle(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = html.match(/<title>([^<]+)<\/title>/i);
  let raw = (h1?.[1] || title?.[1] || '').replace(/<[^>]+>/g, '');
  raw = raw.replace(/\s*[|\u2014\u2013]\s*AssembleAtEase.*$/i, '').replace(/&amp;/g, '&').trim();
  return raw || 'AssembleAtEase Blog';
}

export function extractImageUrl(filePath, article = {}) {
  try {
    const html = readFileSync(filePath, 'utf8');
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    const firstImg = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    const candidate = og?.[1] || firstImg?.[1] || '';
    const raw = isPlaceholderArticleImage(candidate) ? imageForArticle(article) : (candidate || imageForArticle(article));
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return SITE + raw;
    return SITE + '/' + raw.replace(/^\.?\//, '');
  } catch (_) {
    return SITE + imageForArticle(article);
  }
}

export function imageForArticle({ slug = '', title = '' } = {}) {
  const text = `${slug} ${title}`.toLowerCase();
  if (/(smart|camera|lock|doorbell|thermostat|security|ring|nest|ecobee)/.test(text)) return '/images/service-smart-home.jpg';
  if (/(tv|mount|wall|cord|outdoor-tv)/.test(text)) return '/images/service-tv-mounting.jpg';
  if (/(bed|ikea|wayfair|crate|barrel|furniture|pax|dresser|desk)/.test(text)) return '/images/service-furniture-assembly.jpg';
  if (/(garage|shelving|storage)/.test(text)) return '/images/work-office-assembly.jpg';
  if (/(fitness|treadmill|bike|gym|rack|bench)/.test(text)) return '/images/service-fitness-equipment.jpg';
  if (/(playset|outdoor|gazebo|patio|backyard)/.test(text)) return '/images/service-outdoor-playsets.jpg';
  if (/(office|workspace|cubicle)/.test(text)) return '/images/service-office-assembly.jpg';
  return '/images/people-service-calm.jpg';
}

function isPlaceholderArticleImage(raw) {
  const value = String(raw || '').toLowerCase();
  return !value || value.includes('/images/logo.jpg') || value.includes('/images/logo.webp') || value.endsWith('/images/favicon.svg');
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch (_) {
    return null;
  }
}

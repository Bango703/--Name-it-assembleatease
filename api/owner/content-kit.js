import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { verifyOwner, sendEmail, ownerEmail } from '../_email.js';
import { generateContentKit, renderContentKitEmailHtml } from '../_content-kit.js';
import { getSocialAutomationStatus, publishContentKit } from '../_social-publisher.js';

const SITE = 'https://www.assembleatease.com';

/**
 * GET /api/owner/content-kit  (owner only)
 *
 *   ?list=1              -> list every Guide article ({ slug, title })
 *   ?slug=<slug>         -> generate a social kit for that article
 *   ?slug=<slug>&email=1 -> also email the kit to the owner
 *
 * POST /api/owner/content-kit
 *   { slug, channels?, dryRun?, kit? } -> publish to configured social APIs
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const blogDir = join(process.cwd(), 'blog');

  if (req.method === 'POST') return handlePublish(req, res, blogDir);

  if (req.query.list === '1' || req.query.list === 'true') {
    try {
      const files = readdirSync(blogDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
      const articles = files.map((f) => ({ slug: f.replace(/\.html$/, ''), title: extractTitle(join(blogDir, f)) }));
      return res.status(200).json({ count: articles.length, articles, socialAutomation: getSocialAutomationStatus() });
    } catch (e) {
      return res.status(500).json({ error: 'Could not list articles', detail: e?.message || String(e) });
    }
  }

  const slug = cleanSlug(req.query.slug);
  if (!slug) return res.status(400).json({ error: 'Provide ?slug=<article-slug> (or ?list=1 to see them all).' });

  const article = readArticle(blogDir, slug);
  if (!article) return res.status(404).json({ error: 'Article not found: ' + slug });

  const hookStyle = cleanHookStyle(req.query.hookStyle);
  const kit = await generateContentKit({ title: article.title, url: article.url, hookStyle });
  if (!kit) return res.status(502).json({ error: 'Content kit generation failed (check ANTHROPIC_API_KEY).' });

  const wantsEmail = req.query.email === '1' || req.query.email === 'true';
  if (wantsEmail) {
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Social content kit - ${article.title}`,
        html: renderContentKitEmailHtml({ title: article.title, url: article.url, kit }),
      });
    } catch (e) {
      return res.status(200).json({
        success: true,
        emailed: false,
        emailError: e?.message || String(e),
        ...article,
        kit,
        hookStyle,
        socialAutomation: getSocialAutomationStatus({ imageUrl: article.imageUrl }),
      });
    }
    return res.status(200).json({
      success: true,
      emailed: ownerEmail(),
      ...article,
      kit,
      hookStyle,
      socialAutomation: getSocialAutomationStatus({ imageUrl: article.imageUrl }),
    });
  }

  return res.status(200).json({
    success: true,
    ...article,
    kit,
    hookStyle,
    socialAutomation: getSocialAutomationStatus({ imageUrl: article.imageUrl }),
  });
}

async function handlePublish(req, res, blogDir) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const slug = cleanSlug(body.slug);
  if (!slug) return res.status(400).json({ error: 'Provide slug in the request body.' });

  const article = readArticle(blogDir, slug);
  if (!article) return res.status(404).json({ error: 'Article not found: ' + slug });

  const kit = body.kit && typeof body.kit === 'object'
    ? body.kit
    : await generateContentKit({ title: article.title, url: article.url, hookStyle: cleanHookStyle(body.hookStyle) });
  if (!kit) return res.status(502).json({ error: 'Content kit generation failed (check ANTHROPIC_API_KEY).' });

  const publish = await publishContentKit({
    title: article.title,
    url: article.url,
    imageUrl: article.imageUrl,
    kit,
    channels: body.channels,
    dryRun: body.dryRun === true,
  });

  return res.status(200).json({
    success: true,
    ...article,
    kit,
    publish,
    socialAutomation: getSocialAutomationStatus({ imageUrl: article.imageUrl }),
  });
}

function cleanSlug(value) {
  return String(value || '').replace(/[^a-z0-9-]/gi, '');
}

function cleanHookStyle(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['security', 'cost', 'mistake', 'local', 'proof', 'direct-offer'].includes(v) ? v : '';
}

function readArticle(blogDir, slug) {
  const filePath = join(blogDir, slug + '.html');
  try {
    const title = extractTitle(filePath);
    return {
      slug,
      title,
      url: `${SITE}/blog/${slug}`,
      imageUrl: extractImageUrl(filePath, { slug, title }),
    };
  } catch (_) {
    return null;
  }
}

function extractTitle(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t = html.match(/<title>([^<]+)<\/title>/i);
  let raw = (h1?.[1] || t?.[1] || '').replace(/<[^>]+>/g, '');
  raw = raw.replace(/\s*[|\u2014\u2013]\s*AssembleAtEase.*$/i, '').replace(/&amp;/g, '&').trim();
  return raw || 'AssembleAtEase Guide';
}

function extractImageUrl(filePath, article = {}) {
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

function isPlaceholderArticleImage(raw) {
  const value = String(raw || '').toLowerCase();
  return !value || value.includes('/images/logo.jpg') || value.includes('/images/logo.webp') || value.endsWith('/images/favicon.svg');
}

function imageForArticle({ slug = '', title = '' } = {}) {
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

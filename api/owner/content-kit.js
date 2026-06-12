import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { verifyOwner, sendEmail, ownerEmail } from '../_email.js';
import { generateContentKit, renderContentKitEmailHtml } from '../_content-kit.js';

const SITE = 'https://www.assembleatease.com';

/**
 * GET /api/owner/content-kit  (owner only)
 *
 *   ?list=1            -> list every Guide article ({ slug, title })
 *   ?slug=<slug>       -> generate a ready-to-post content kit for that article
 *   ?slug=<slug>&email=1 -> also email the kit to the owner
 *
 * Lets the owner backfill social content for the existing articles. New articles
 * get their kit emailed automatically by the auto-blog cron.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const blogDir = join(process.cwd(), 'blog');

  if (req.query.list === '1' || req.query.list === 'true') {
    try {
      const files = readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
      const items = files.map(f => ({ slug: f.replace(/\.html$/, ''), title: extractTitle(join(blogDir, f)) }));
      return res.status(200).json({ count: items.length, articles: items });
    } catch (e) {
      return res.status(500).json({ error: 'Could not list articles', detail: e?.message || String(e) });
    }
  }

  const slug = String(req.query.slug || '').replace(/[^a-z0-9-]/gi, '');
  if (!slug) return res.status(400).json({ error: 'Provide ?slug=<article-slug> (or ?list=1 to see them all).' });

  let title;
  try {
    title = extractTitle(join(blogDir, slug + '.html'));
  } catch (e) {
    return res.status(404).json({ error: 'Article not found: ' + slug });
  }

  const url = `${SITE}/blog/${slug}`;
  const kit = await generateContentKit({ title, url });
  if (!kit) return res.status(502).json({ error: 'Content kit generation failed (check ANTHROPIC_API_KEY).' });

  const wantsEmail = req.query.email === '1' || req.query.email === 'true';
  if (wantsEmail) {
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Social content kit — ${title}`,
        html: renderContentKitEmailHtml({ title, url, kit }),
      });
    } catch (e) {
      return res.status(200).json({ success: true, emailed: false, emailError: e?.message || String(e), title, url, kit });
    }
    return res.status(200).json({ success: true, emailed: ownerEmail(), title, url, kit });
  }

  return res.status(200).json({ success: true, title, url, kit });
}

function extractTitle(filePath) {
  const html = readFileSync(filePath, 'utf8'); // throws if missing -> handled by caller
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t  = html.match(/<title>([^<]+)<\/title>/i);
  let raw = (h1?.[1] || t?.[1] || '').replace(/<[^>]+>/g, '');
  raw = raw.replace(/\s*[|—–]\s*AssembleAtEase.*$/i, '').replace(/&amp;/g, '&').trim();
  return raw || 'AssembleAtEase Guide';
}

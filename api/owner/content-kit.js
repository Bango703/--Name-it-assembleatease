import { verifyOwner, sendEmail, ownerEmail } from '../_email.js';
import { listBlogArticles, readBlogArticle } from '../_blog-articles.js';
import { generateContentKit, renderContentKitEmailHtml } from '../_content-kit.js';
import { getSocialAutomationStatus, publishContentKit } from '../_social-publisher.js';

/**
 * GET /api/owner/content-kit  (owner only)
 *
 *   ?list=1              -> list every Blog article ({ slug, title })
 *   ?slug=<slug>         -> generate a social kit for that article
 *   ?slug=<slug>&email=1 -> also email the kit to the owner
 *
 * POST /api/owner/content-kit
 *   { slug, channels?, dryRun?, kit? } -> publish to selected Buffer channels
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'POST') return handlePublish(req, res);

  if (req.query.list === '1' || req.query.list === 'true') {
    try {
      const articles = listBlogArticles().map(({ slug, title }) => ({ slug, title }));
      return res.status(200).json({ count: articles.length, articles, socialAutomation: getSocialAutomationStatus() });
    } catch (e) {
      return res.status(500).json({ error: 'Could not list articles', detail: e?.message || String(e) });
    }
  }

  const slug = cleanSlug(req.query.slug);
  if (!slug) return res.status(400).json({ error: 'Provide ?slug=<article-slug> (or ?list=1 to see them all).' });

  const article = readBlogArticle(slug);
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

async function handlePublish(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const slug = cleanSlug(body.slug);
  if (!slug) return res.status(400).json({ error: 'Provide slug in the request body.' });
  if (Array.isArray(body.channels) && body.channels.length === 0) {
    return res.status(400).json({ error: 'Choose at least one social channel.' });
  }

  const article = readBlogArticle(slug);
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

// Weekly blog article, delivered as a pull request the owner merges.
//
// The engine (api/_blog-engine.js) picks the next topic from the editorial
// calendar, writes it with the real catalog prices, checks it, gives it a photo
// no other article uses, renders it with the same renderer as every other
// article, and opens a pull request with the page, its data file, the index card
// and the sitemap entry. CI runs every guard on it; merging publishes it, and the
// IndexNow workflow and the social top-up take it from there.
//
// It never commits to main (branch protection blocks that, which is part of why
// the old pipeline published nothing after June). Off unless
// AUTO_BLOG_PUBLISH_ENABLED=true.

import Anthropic from '@anthropic-ai/sdk';
import { logCron } from './_cron-logger.js';
import { getSupabase } from '../_supabase.js';
import { WEBSITE_PHOTO_BUCKET } from '../_website-photos.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import {
  SITE, BLOG_MODEL, SERVICES, pickNextTopic, catalogFactsFor, buildArticlePrompt, validateArticleData,
  pickArticleImage, buildEngineArticle, relatedArticleFor, indexGroupId, addToBlogIndex, addToSitemap,
  readRepoFile, listRepoDir, openBlogPullRequest,
} from '../_blog-engine.js';

const MAX_ATTEMPTS = 2;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const startedAt = Date.now();
  const cronSecret = String(process.env.CRON_SECRET || '');
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });

  if (String(process.env.AUTO_BLOG_PUBLISH_ENABLED || '').toLowerCase() !== 'true') {
    await logCron('auto-blog', { status: 'ok', records: 0, duration: Date.now() - startedAt });
    return res.status(200).json({ success: true, disabled: true, reason: 'AUTO_BLOG_PUBLISH_ENABLED is not enabled.' });
  }

  const token = process.env.GITHUB_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!token || !anthropicKey) {
    const error = `Missing ${!token ? 'GITHUB_TOKEN' : 'ANTHROPIC_API_KEY'}; no article was written.`;
    await logCron('auto-blog', { status: 'error', records: 0, error, duration: Date.now() - startedAt });
    return res.status(500).json({ error });
  }

  try {
    const result = await writeNextArticle({ token, anthropicKey });
    await logCron('auto-blog', {
      status: result.ok ? 'ok' : 'error',
      records: result.ok ? 1 : 0,
      error: result.ok ? null : result.reason,
      duration: Date.now() - startedAt,
    });
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    await logCron('auto-blog', { status: 'error', records: 0, error: error?.message || String(error), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Blog run failed', detail: error?.message || String(error) });
  }
}

export async function writeNextArticle({ token, anthropicKey, now = new Date(), anthropic, fetchImpl = globalThis.fetch, jobPhotos, notify = true } = {}) {
  const writer = anthropic || new Anthropic({ apiKey: anthropicKey });
  const today = now.toISOString().slice(0, 10);
  const files = await listRepoDir(token, 'blog', { fetchImpl });
  const existingSlugs = files.filter((f) => f.name.endsWith('.html') && f.name !== 'index.html').map((f) => f.name.replace(/\.html$/, ''));
  const index = await readRepoFile(token, 'blog/index.html', { fetchImpl });
  const existingTitles = [...index.content.matchAll(/<span class="guide-title"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
  const usedImages = [...index.content.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);

  const topic = pickNextTopic({ existingSlugs, existingTitles, now });
  if (!topic) return { ok: false, reason: 'Every calendar topic is already published; add topics to BLOG_CALENDAR.' };

  const facts = catalogFactsFor(topic.service);
  const { system, user } = buildArticlePrompt(topic, facts);
  let checked = null;
  let lastReason = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !checked; attempt += 1) {
    const message = await writer.messages.create({
      model: BLOG_MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: attempt === 1 ? user : `${user}\n\nThe previous draft was rejected: ${lastReason} Fix that.` }],
    });
    const result = validateArticleData(message.content?.[0]?.text || '', { allowedPrices: facts.prices });
    if (result.ok) checked = result.article;
    else lastReason = result.reason;
  }
  if (!checked) return { ok: false, slug: topic.slug, reason: `Draft for "${topic.slug}" failed its checks twice: ${lastReason}` };

  const photos = jobPhotos || await publishedJobPhotos(SERVICES[topic.service].photo);
  const image = pickArticleImage({ service: topic.service, usedImages, jobPhotos: photos });
  const url = `${SITE}/blog/${topic.slug}`;
  const related = relatedArticleFor(index.content, topic);
  const built = buildEngineArticle({ topic, article: checked, image, today, related: related ? [related] : [] });
  const sitemap = await readRepoFile(token, 'sitemap.xml', { fetchImpl });
  const pr = await openBlogPullRequest({
    token,
    slug: topic.slug,
    title: checked.title,
    fetchImpl,
    files: [
      { path: `blog/data/${topic.slug}.json`, content: `${JSON.stringify({ post: built.post, content: built.content, source: { model: BLOG_MODEL, topic: topic.topic, generatedAt: now.toISOString() } }, null, 2)}\n` },
      { path: `blog/${topic.slug}.html`, content: built.html },
      { path: 'blog/index.html', content: addToBlogIndex(index.content, { card: built.card, groupId: indexGroupId(topic.service), title: checked.title, url }), sha: index.sha },
      { path: 'sitemap.xml', content: addToSitemap(sitemap.content, { url, today }), sha: sitemap.sha },
    ],
    body: [
      `New article from the blog engine: **${checked.title}**`,
      '',
      `- Topic: ${topic.topic}`,
      `- Service: ${topic.service}; every price checked against the catalog`,
      `- ${checked.wordCount} words, ${checked.sections.length} sections, ${checked.faq.length} FAQ questions`,
      `- Photo: ${image.source === 'job-photo' ? 'a published job photo' : 'a site photo'}${image.reused ? '. **Already used by another article; replace it before merging.**' : ', not used by any other article'}`,
      '',
      'Read it in the Vercel preview, edit anything on this branch, then merge to publish.',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n'),
  });

  if (notify) {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `New blog article ready to review: ${checked.title}`,
      html: `<p>A new article is ready to review: <strong>${esc(checked.title)}</strong>.</p><p>Read it in the preview and merge the pull request to publish it:<br/><a href="${esc(pr.url)}">${esc(pr.url)}</a></p>${image.reused ? '<p>The photo is already used by another article. Replace it before merging.</p>' : ''}`,
      meta: { notificationType: 'blog_article_ready', recipientType: 'owner' },
    }).catch((error) => console.error('Blog review email failed:', error?.message || error));
  }

  return { ok: true, slug: topic.slug, title: checked.title, pullRequest: pr.url, photoReused: image.reused };
}

async function publishedJobPhotos(serviceSlug) {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('booking_evidence')
      .select('website_public_path, website_alt')
      .eq('website_service', serviceSlug)
      .not('website_published_at', 'is', null)
      .order('website_published_at', { ascending: false })
      .limit(30);
    if (error) return [];
    return (data || []).filter((r) => r.website_public_path).map((r) => ({
      url: sb.storage.from(WEBSITE_PHOTO_BUCKET).getPublicUrl(r.website_public_path).data.publicUrl,
      alt: r.website_alt,
    }));
  } catch (_) {
    return [];
  }
}

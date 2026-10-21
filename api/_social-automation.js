import { listBlogArticles } from './_blog-articles.js';
import { generateContentKit } from './_content-kit.js';
import { getSocialAutomationSnapshot, publishContentKit } from './_social-publisher.js';
import { findClaimViolations } from './_social-claims.js';
import { facebookSlotKind, facebookCampaignPost } from './_social-campaigns.js';
import { loadMarketingSettings } from './_promotions.js';
import { getSupabase } from './_supabase.js';

const SAME_CHANNEL_REPEAT_DAYS = 60;
const CROSS_CHANNEL_REPEAT_DAYS = 7;
// A channel with a daily cap gets nothing new until this long after its last post.
const DAILY_CAP_HOURS = 20;

const CHANNEL_HOOK_STYLES = {
  // No 'cost' or 'mistake' on Facebook: they produced "can cost you thousands"
  // openings on almost every post (owner, 2026-10-21).
  facebook: ['local', 'proof', 'tip'],
  googleBusiness: ['local', 'direct-offer', 'proof'],
  linkedin: ['mistake', 'cost', 'proof', 'local'],
};

export async function runSocialQueueTopUp({ dryRun = false, channels } = {}) {
  const snapshot = await getSocialAutomationSnapshot();
  // Without Buffer's queue and history, every channel looks empty and never
  // posted: the top-up would repeat articles, overfill queues and ignore the
  // daily cap. Post nothing and report why (owner, 2026-10-21: Facebook got
  // yesterday's article again and Google Business had 4 queued against 2).
  if (snapshot?.error) {
    return {
      success: false,
      dryRun: dryRun === true,
      fetchedAt: new Date().toISOString(),
      error: `Buffer queue and history could not be read, so nothing was posted: ${snapshot.error}`,
      snapshot,
      summary: { eligibleChannels: 0, attemptedPosts: 0, queued: 0, dryRuns: 0, errors: 0, blocked: 0, skipped: 0, remainingDeficitEstimate: 0 },
      byChannel: {},
      posts: [],
    };
  }
  const requested = normalizeRequestedChannels(channels);
  const inventory = listBlogArticles();
  const usage = buildUsageMap(snapshot);
  const promoSettings = await loadPromoSettings();

  const eligibleChannels = (snapshot.channels || []).filter((channel) => {
    if (requested && !requested.has(channel.key)) return false;
    if (!channel.ready || channel.queuePaused) return false;
    if (!channel.targetQueued || !channel.maxPerRun) return false;
    if (postedWithinDailyCap(channel)) return false;
    return channel.deficit > 0;
  });

  const byChannel = {};
  const posts = [];
  const reservedSlugs = new Set();
  const kitCache = new Map();

  for (const channel of eligibleChannels) {
    const planned = [];
    const needed = Math.min(channel.deficit || 0, channel.maxPerRun || 0);

    for (let slotIndex = 0; slotIndex < needed; slotIndex += 1) {
      // Facebook runs a weekly mix; on a non-blog day the post comes from what is
      // true today (a service and its price, a live offer, AssembleCash).
      const slotKind = channel.key === 'facebook' ? facebookSlotKind({ promoSettings }) : 'blog';
      if (slotKind !== 'blog') {
        planned.push(await publishCampaign({ channel, kind: slotKind, promoSettings, dryRun }));
        continue;
      }

      const article = selectArticleForChannel({
        channel,
        inventory,
        usage,
        reservedSlugs,
      });

      if (!article) {
        // Every article ran here in the last 60 days: post a service instead of
        // repeating one.
        if (channel.key === 'facebook') {
          planned.push(await publishCampaign({ channel, kind: 'service', promoSettings, dryRun }));
          continue;
        }
        planned.push({
          status: 'skipped',
          reason: 'Every blog article went to this channel in the last 60 days.',
        });
        break;
      }

      reservedSlugs.add(article.slug);
      const hookStyle = pickHookStyle(channel.key, article.slug, slotIndex);
      const kitKey = `${article.slug}:${hookStyle}`;
      let kit = kitCache.get(kitKey);
      if (!kit) {
        kit = await generateContentKit({
          title: article.title,
          url: article.url,
          tag: channel.lane,
          hookStyle,
        });
        // The AI broke a content rule: ask once more, then give up on this slot.
        if (kit && findClaimViolations(kit[channel.kitKey || channel.key]).length) {
          kit = await generateContentKit({ title: article.title, url: article.url, tag: channel.lane, hookStyle });
        }
        if (kit) kitCache.set(kitKey, kit);
      }

      if (!kit) {
        planned.push({
          status: 'error',
          slug: article.slug,
          title: article.title,
          hookStyle,
          reason: 'Content kit generation failed.',
        });
        continue;
      }

      const publish = await publishContentKit({
        title: article.title,
        url: article.url,
        imageUrl: article.imageUrl,
        kit,
        channels: [channel.key],
        dryRun,
      });
      const result = publish?.[channel.key] || { status: 'error', error: 'Publish result missing' };

      planned.push({
        status: result.status,
        slug: article.slug,
        title: article.title,
        hookStyle,
        url: article.url,
        imageUrl: article.imageUrl,
        provider: result.provider || 'buffer',
        postId: result.id || null,
        error: result.error || null,
      });

      if (result.status === 'queued' || result.status === 'dry_run') {
        registerUsage(usage, channel.key, article.url, Date.now());
      }
    }

    byChannel[channel.key] = {
      key: channel.key,
      label: channel.label,
      lane: channel.lane,
      targetQueued: channel.targetQueued,
      queuedBefore: channel.queuedCount,
      deficitBefore: channel.deficit,
      queuePaused: channel.queuePaused,
      plannedCount: planned.length,
      queuedNow: planned.filter((item) => item.status === 'queued').length,
      dryRunCount: planned.filter((item) => item.status === 'dry_run').length,
      errorCount: planned.filter((item) => item.status === 'error').length,
      blockedCount: planned.filter((item) => item.status === 'blocked').length,
      skippedCount: planned.filter((item) => item.status === 'skipped').length,
      remainingDeficitEstimate: Math.max(
        0,
        (channel.deficit || 0) - planned.filter((item) => item.status === 'queued' || item.status === 'dry_run').length,
      ),
      posts: planned,
    };

    posts.push(...planned.map((item) => ({ channelKey: channel.key, channelLabel: channel.label, ...item })));
  }

  return {
    success: true,
    dryRun: dryRun === true,
    fetchedAt: new Date().toISOString(),
    snapshot,
    inventoryCount: inventory.length,
    channelCount: eligibleChannels.length,
    requestedChannels: requested ? [...requested] : [],
    summary: {
      eligibleChannels: eligibleChannels.length,
      attemptedPosts: posts.length,
      queued: posts.filter((item) => item.status === 'queued').length,
      dryRuns: posts.filter((item) => item.status === 'dry_run').length,
      errors: posts.filter((item) => item.status === 'error').length,
      blocked: posts.filter((item) => item.status === 'blocked').length,
      skipped: posts.filter((item) => item.status === 'skipped').length,
      remainingDeficitEstimate: Object.values(byChannel).reduce((sum, item) => sum + (item.remainingDeficitEstimate || 0), 0),
    },
    byChannel,
    posts,
  };
}

function normalizeRequestedChannels(channels) {
  const values = Array.isArray(channels)
    ? channels
    : String(channels || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  return values.length ? new Set(values) : null;
}

function pickHookStyle(channelKey, slug, slotIndex) {
  const options = CHANNEL_HOOK_STYLES[channelKey] || ['local', 'proof', 'mistake'];
  let total = Number(slotIndex || 0);
  for (const char of String(slug || '')) total += char.charCodeAt(0);
  return options[total % options.length];
}

function selectArticleForChannel({ channel, inventory, usage, reservedSlugs }) {
  const now = Date.now();
  const sameChannelCutoff = now - SAME_CHANNEL_REPEAT_DAYS * 24 * 60 * 60 * 1000;
  const crossChannelCutoff = now - CROSS_CHANNEL_REPEAT_DAYS * 24 * 60 * 60 * 1000;
  const channelUsage = usage.byChannel.get(channel.key) || new Map();

  const available = inventory.filter((article) => !reservedSlugs.has(article.slug));
  if (!available.length) return null;

  const scored = available.map((article) => {
    const channelLast = channelUsage.get(article.url) || 0;
    const globalLast = usage.global.get(article.url) || 0;
    const isFreshForChannel = !channelLast || channelLast < sameChannelCutoff;
    const isFreshGlobally = !globalLast || globalLast < crossChannelCutoff;
    const updatedAt = article.updatedAt ? new Date(article.updatedAt).getTime() : 0;
    return { article, channelLast, globalLast, isFreshForChannel, isFreshGlobally, updatedAt };
  });

  // Never repeat an article on the same channel inside the window. The old
  // fallback reused the oldest one, which is how Facebook got the same guide
  // three times in eighteen days.
  const preferred = scored.filter((item) => item.isFreshForChannel && item.isFreshGlobally);
  const fallback = preferred.length ? preferred : scored.filter((item) => item.isFreshForChannel);
  if (!fallback.length) return null;

  fallback.sort((a, b) => {
    if (a.channelLast !== b.channelLast) return a.channelLast - b.channelLast;
    if (a.globalLast !== b.globalLast) return a.globalLast - b.globalLast;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.article.slug).localeCompare(String(b.article.slug));
  });

  return fallback[0]?.article || null;
}

function buildUsageMap(snapshot) {
  const byChannel = new Map();
  const global = new Map();
  const posts = []
    .concat(Array.isArray(snapshot?.scheduledPosts) ? snapshot.scheduledPosts : [])
    .concat(Array.isArray(snapshot?.recentPosts) ? snapshot.recentPosts : []);

  for (const post of posts) {
    const urls = extractBlogUrls(post);
    const when = resolvePostTimestamp(post);
    if (!urls.length || !when) continue;
    for (const url of urls) registerUsage({ byChannel, global }, post.channelId || post.channelKey || '', url, when);
  }

  const channelIdToKey = new Map((snapshot?.channels || []).map((channel) => [channel.channelId, channel.key]));
  if (!channelIdToKey.size) return { byChannel, global };

  const normalizedByChannel = new Map();
  for (const [channelId, urlMap] of byChannel.entries()) {
    const key = channelIdToKey.get(channelId) || channelId;
    normalizedByChannel.set(key, urlMap);
  }
  return { byChannel: normalizedByChannel, global };
}

function registerUsage(usage, channelKey, url, when) {
  if (!url || !when) return;
  const ts = Number(when) || new Date(when).getTime();
  if (!ts) return;
  if (!usage.byChannel.has(channelKey)) usage.byChannel.set(channelKey, new Map());
  const channelUsage = usage.byChannel.get(channelKey);
  const currentChannel = channelUsage.get(url) || 0;
  if (ts > currentChannel) channelUsage.set(url, ts);
  const currentGlobal = usage.global.get(url) || 0;
  if (ts > currentGlobal) usage.global.set(url, ts);
}

function postedWithinDailyCap(channel, now = Date.now()) {
  if (!channel.dailyMax || !channel.lastSentAt) return false;
  const last = new Date(channel.lastSentAt).getTime();
  return Number.isFinite(last) && now - last < DAILY_CAP_HOURS * 60 * 60 * 1000;
}

async function loadPromoSettings() {
  try {
    return await loadMarketingSettings(getSupabase(), { allowFallback: false });
  } catch (error) {
    // No settings means no offer post, never an offer that may not work.
    console.warn('Social offer settings unavailable:', error?.message || error);
    return null;
  }
}

async function publishCampaign({ channel, kind, promoSettings, dryRun }) {
  const post = facebookCampaignPost({ kind, promoSettings });
  if (!post) return { status: 'skipped', kind, reason: `No ${kind} post could be built today.` };
  const publish = await publishContentKit({
    title: post.title,
    url: post.url,
    imageUrl: post.imageUrl,
    altText: post.altText,
    kit: { [channel.kitKey || channel.key]: post.text },
    channels: [channel.key],
    dryRun,
    aiAssisted: false,
    source: `assembleatease-campaign-${post.kind}`,
  });
  const result = publish?.[channel.key] || { status: 'error', error: 'Publish result missing' };
  return {
    status: result.status,
    kind: post.kind,
    title: post.title,
    url: post.url,
    imageUrl: post.imageUrl,
    provider: result.provider || 'buffer',
    postId: result.id || null,
    error: result.error || result.reason || null,
  };
}

export { postedWithinDailyCap, selectArticleForChannel };

function resolvePostTimestamp(post) {
  const value = post?.sentAt || post?.dueAt || post?.createdAt;
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function extractBlogUrls(post) {
  const urls = new Set();
  for (const value of [post?.text, post?.externalLink]) {
    const matches = String(value || '').match(/https?:\/\/www\.assembleatease\.com\/blog\/[a-z0-9-]+/gi) || [];
    matches.forEach((url) => urls.add(url.replace(/[)\],.!?]+$/, '')));
  }
  return [...urls];
}


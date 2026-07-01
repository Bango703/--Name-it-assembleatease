import { listBlogArticles } from './_blog-articles.js';
import { generateContentKit } from './_content-kit.js';
import { getSocialAutomationSnapshot, publishContentKit } from './_social-publisher.js';

const SAME_CHANNEL_REPEAT_DAYS = 60;
const CROSS_CHANNEL_REPEAT_DAYS = 7;

const CHANNEL_HOOK_STYLES = {
  facebook: ['local', 'proof', 'cost', 'mistake'],
  googleBusiness: ['local', 'direct-offer', 'proof'],
  linkedin: ['mistake', 'cost', 'proof', 'local'],
};

export async function runSocialQueueTopUp({ dryRun = false, channels } = {}) {
  const snapshot = await getSocialAutomationSnapshot();
  const requested = normalizeRequestedChannels(channels);
  const inventory = listBlogArticles();
  const usage = buildUsageMap(snapshot);

  const eligibleChannels = (snapshot.channels || []).filter((channel) => {
    if (requested && !requested.has(channel.key)) return false;
    if (!channel.ready || channel.queuePaused) return false;
    if (!channel.targetQueued || !channel.maxPerRun) return false;
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
      const article = selectArticleForChannel({
        channel,
        inventory,
        usage,
        reservedSlugs,
      });

      if (!article) {
        planned.push({
          status: 'skipped',
          reason: 'No eligible blog article found for this channel.',
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

  const preferred = scored.filter((item) => item.isFreshForChannel && item.isFreshGlobally);
  const pool = preferred.length ? preferred : scored.filter((item) => item.isFreshForChannel);
  const fallback = pool.length ? pool : scored;

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

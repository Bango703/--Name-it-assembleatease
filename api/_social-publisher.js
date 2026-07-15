const BUFFER_GRAPHQL_URL = 'https://api.buffer.com';
const BUFFER_DEFAULT_MODE = process.env.BUFFER_POST_MODE || 'addToQueue';
const BUFFER_DEFAULT_SCHEDULING_TYPE = process.env.BUFFER_SCHEDULING_TYPE || 'automatic';

const CHANNEL_POLICIES = {
  facebook: {
    targetQueued: 2,
    maxPerRun: 2,
    lane: 'Local trust and homeowner awareness',
    attachImage: true,
  },
  googleBusiness: {
    targetQueued: 2,
    maxPerRun: 2,
    lane: 'Local SEO freshness and booking intent',
    attachImage: true,
  },
  linkedin: {
    targetQueued: 1,
    maxPerRun: 1,
    lane: 'Founder voice and B2B credibility',
    attachImage: false,
  },
};

const CHANNELS = [
  { key: 'facebook', label: 'Facebook', env: ['BUFFER_FACEBOOK_CHANNEL_ID'], kitKey: 'facebook' },
  { key: 'linkedin', label: 'LinkedIn', env: ['BUFFER_LINKEDIN_CHANNEL_ID'], kitKey: 'linkedin' },
  { key: 'googleBusiness', label: 'Google Business', env: ['BUFFER_GOOGLE_BUSINESS_CHANNEL_ID', 'BUFFER_GBP_CHANNEL_ID'], kitKey: 'googleBusiness' },
];

export function getSocialChannelPolicies() {
  return CHANNELS.map((channel) => ({
    key: channel.key,
    label: channel.label,
    ...CHANNEL_POLICIES[channel.key],
  }));
}

export function getSocialAutomationStatus({ imageUrl } = {}) {
  const cfg = bufferConfig();
  return {
    provider: 'buffer',
    enabled: Boolean(cfg.apiKey && cfg.channels.some((channel) => channel.ready)),
    channels: Object.fromEntries(cfg.channels.map((channel) => {
      const missing = [...channel.missing];
      return [channel.key, {
        ready: channel.ready,
        provider: 'buffer',
        channelId: channel.channelId || null,
        targetQueued: channel.targetQueued,
        lane: channel.lane,
        missing,
      }];
    })),
  };
}

export async function publishContentKit({ title, url, kit, imageUrl, channels, dryRun = false, dueAt } = {}) {
  const cfg = bufferConfig();
  const selected = normalizeChannels(channels, cfg.channels);
  const results = {};

  for (const channel of selected) {
    const missing = [...channel.missing];
    if (missing.length) {
      results[channel.key] = { status: 'skipped', provider: 'buffer', reason: `Missing ${missing.join(', ')}` };
      continue;
    }

    const input = buildCreatePostInput(channel, { title, url, kit, imageUrl, dueAt });
    if (dryRun) {
      results[channel.key] = { status: 'dry_run', provider: 'buffer', payload: input };
      continue;
    }

    try {
      const post = await createBufferPost(cfg.apiKey, input);
      results[channel.key] = {
        status: 'queued',
        provider: 'buffer',
        id: post?.id || null,
        text: post?.text || null,
      };
    } catch (err) {
      results[channel.key] = { status: 'error', provider: 'buffer', error: err?.message || String(err) };
    }
  }

  return results;
}

function bufferConfig() {
  const apiKey = env('BUFFER_API_KEY');
  return {
    apiKey,
    channels: CHANNELS.map((channel) => {
      const channelId = env(...channel.env);
      const missing = [];
      if (!apiKey) missing.push('BUFFER_API_KEY');
      if (!channelId) missing.push(channel.env[0]);
      return {
        ...channel,
        ...CHANNEL_POLICIES[channel.key],
        channelId,
        ready: missing.length === 0,
        missing,
      };
    }),
  };
}

function normalizeChannels(channels, configured) {
  if (Array.isArray(channels)) {
    const raw = channels.map((value) => String(value || '').trim()).filter(Boolean);
    if (!raw.length) return [];
    const wanted = new Set(raw);
    return configured.filter((channel) => wanted.has(channel.key));
  }
  const raw = String(channels || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return configured;
  const wanted = new Set(raw);
  return configured.filter((channel) => wanted.has(channel.key));
}

function buildCreatePostInput(channel, { title, url, kit, imageUrl, dueAt }) {
  const text = textForChannel(channel, { title, url, kit });
  const input = {
    text,
    channelId: channel.channelId,
    schedulingType: BUFFER_DEFAULT_SCHEDULING_TYPE,
    mode: dueAt ? 'customScheduled' : BUFFER_DEFAULT_MODE,
    metadata: metadataForChannel(channel, { url }),
    assets: [],
    source: 'assembleatease-content-engine',
    aiAssisted: true,
  };

  if (dueAt) input.dueAt = dueAt;
  if (imageUrl && shouldAttachImageForChannel(channel)) input.assets = [{ image: { url: imageUrl } }];
  return input;
}

function metadataForChannel(channel, { url } = {}) {
  if (channel.key === 'facebook') {
    return { facebook: { type: 'post', linkAttachment: url ? { url } : undefined } };
  }
  if (channel.key === 'googleBusiness') {
    return {
      google: {
        type: 'whats_new',
        detailsWhatsNew: { button: 'book', link: url },
      },
    };
  }
  if (channel.key === 'linkedin') return { linkedin: url ? { linkAttachment: { url } } : {} };
  return undefined;
}

function textForChannel(channel, { title, url, kit }) {
  const byChannel = kit?.[channel.kitKey];
  if (byChannel) return byChannel;
  return `${title}\n${url}`;
}

async function createBufferPost(apiKey, input) {
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            text
            assets {
              id
              mimeType
            }
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;
  const json = await bufferRequest(apiKey, query, { input });
  const payload = json?.data?.createPost;
  if (payload?.message && !payload?.post) throw new Error(payload.message);
  if (!payload?.post) throw new Error('Buffer did not return a created post');
  return payload.post;
}

export async function getSocialAutomationSnapshot({ recentDays = 21, scheduledFirst = 50, recentFirst = 100 } = {}) {
  const cfg = bufferConfig();
  const status = getSocialAutomationStatus();
  const readyChannels = cfg.channels.filter((channel) => channel.ready);
  if (!cfg.apiKey || !readyChannels.length) {
    return {
      ...status,
      organizationId: '',
      fetchedAt: new Date().toISOString(),
      totals: { configured: cfg.channels.length, ready: readyChannels.length, queued: 0, targetQueued: 0, belowTarget: 0, paused: 0, recentErrors: 0 },
      channels: cfg.channels.map((channel) => ({
        key: channel.key,
        label: channel.label,
        lane: channel.lane,
        targetQueued: channel.targetQueued,
        maxPerRun: channel.maxPerRun,
        attachImage: channel.attachImage,
        provider: 'buffer',
        ready: channel.ready,
        channelId: channel.channelId || null,
        missing: [...channel.missing],
        queuePaused: false,
        queuedCount: 0,
        nextDueAt: null,
        recentSentCount: 0,
        recentErrorCount: 0,
        deficit: channel.ready ? channel.targetQueued : 0,
        descriptor: '',
        displayName: channel.label,
        service: channel.key,
        postingSlotsPerWeek: 0,
        externalLink: null,
      })),
      scheduledPosts: [],
      recentPosts: [],
    };
  }

  try {
    const organizationId = await resolveOrganizationId(cfg);
    if (!organizationId) {
      return buildFallbackSocialSnapshot(cfg, status, readyChannels, 'Buffer organization could not be resolved from the configured channel IDs.');
    }

    const recentStart = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();
    const channelIds = readyChannels.map((channel) => channel.channelId);
    const query = `
    query SocialAutomationSnapshot(
      $organizationId: OrganizationId!,
      $channelIds: [ChannelId!],
      $recentStart: DateTime!,
      $scheduledFirst: Int!,
      $recentFirst: Int!
    ) {
      channels(input: { organizationId: $organizationId }) {
        id
        name
        displayName
        descriptor
        service
        externalLink
        isQueuePaused
        postingSchedule { day times paused }
      }
      scheduled: posts(
        input: {
          organizationId: $organizationId,
          filter: { channelIds: $channelIds, status: [scheduled] },
          sort: [{ field: dueAt, direction: asc }]
        },
        first: $scheduledFirst
      ) {
        edges {
          node {
            id
            channelId
            status
            dueAt
            text
            externalLink
          }
        }
      }
      recent: posts(
        input: {
          organizationId: $organizationId,
          filter: {
            channelIds: $channelIds,
            status: [sent, error],
            createdAt: { start: $recentStart }
          },
          sort: [{ field: createdAt, direction: desc }]
        },
        first: $recentFirst
      ) {
        edges {
          node {
            id
            channelId
            status
            createdAt
            sentAt
            dueAt
            text
            externalLink
            error { message }
          }
        }
      }
    }
  `;

    const json = await bufferRequest(cfg.apiKey, query, {
      organizationId,
      channelIds,
      recentStart,
      scheduledFirst,
      recentFirst,
    });

    const liveChannels = Array.isArray(json?.data?.channels) ? json.data.channels : [];
    const scheduledPosts = ((json?.data?.scheduled?.edges) || []).map((edge) => edge.node).filter(Boolean);
    const recentPosts = ((json?.data?.recent?.edges) || []).map((edge) => edge.node).filter(Boolean);
    const liveById = new Map(liveChannels.map((channel) => [channel.id, channel]));

    const channels = cfg.channels.map((channel) => {
      const live = liveById.get(channel.channelId) || null;
      const queued = scheduledPosts.filter((post) => post.channelId === channel.channelId);
      const recent = recentPosts.filter((post) => post.channelId === channel.channelId);
      const recentErrors = recent.filter((post) => post.status === 'error');
      const nextDueAt = queued[0]?.dueAt || null;
      const postingSlotsPerWeek = Array.isArray(live?.postingSchedule)
        ? live.postingSchedule.reduce((sum, row) => sum + (row?.paused ? 0 : (Array.isArray(row?.times) ? row.times.length : 0)), 0)
        : 0;
      const deficit = channel.ready && !live?.isQueuePaused
        ? Math.max(0, (channel.targetQueued || 0) - queued.length)
        : 0;

      return {
        key: channel.key,
        label: channel.label,
        lane: channel.lane,
        targetQueued: channel.targetQueued,
        maxPerRun: channel.maxPerRun,
        attachImage: channel.attachImage,
        provider: 'buffer',
        ready: channel.ready,
        channelId: channel.channelId || null,
        missing: [...channel.missing],
        queuePaused: !!live?.isQueuePaused,
        queuedCount: queued.length,
        nextDueAt,
        recentSentCount: recent.filter((post) => post.status === 'sent').length,
        recentErrorCount: recentErrors.length,
        deficit,
        descriptor: live?.descriptor || '',
        displayName: live?.displayName || live?.name || channel.label,
        service: live?.service || channel.key,
        postingSlotsPerWeek,
        externalLink: live?.externalLink || null,
      };
    });

    return {
      ...status,
      organizationId,
      fetchedAt: new Date().toISOString(),
      totals: {
        configured: cfg.channels.length,
        ready: channels.filter((channel) => channel.ready).length,
        queued: channels.reduce((sum, channel) => sum + channel.queuedCount, 0),
        targetQueued: channels.filter((channel) => channel.ready).reduce((sum, channel) => sum + (channel.targetQueued || 0), 0),
        belowTarget: channels.filter((channel) => channel.ready && channel.deficit > 0).length,
        paused: channels.filter((channel) => channel.queuePaused).length,
        recentErrors: channels.reduce((sum, channel) => sum + channel.recentErrorCount, 0),
      },
      channels,
      scheduledPosts,
      recentPosts,
    };
  } catch (error) {
    return buildFallbackSocialSnapshot(cfg, status, readyChannels, error?.message || String(error));
  }
}

function buildFallbackSocialSnapshot(cfg, status, channels, errorMessage) {
  const nextChannels = cfg.channels.map((channel) => ({
    key: channel.key,
    label: channel.label,
    lane: channel.lane,
    targetQueued: channel.targetQueued,
    maxPerRun: channel.maxPerRun,
    attachImage: channel.attachImage,
    provider: 'buffer',
    ready: channel.ready,
    channelId: channel.channelId || null,
    missing: [...channel.missing],
    queuePaused: false,
    queuedCount: 0,
    nextDueAt: null,
    recentSentCount: 0,
    recentErrorCount: 0,
    deficit: channel.ready ? (channel.targetQueued || 0) : 0,
    descriptor: '',
    displayName: channel.label,
    service: channel.key,
    postingSlotsPerWeek: 0,
    externalLink: null,
  }));

  return {
    ...status,
    organizationId: '',
    fetchedAt: new Date().toISOString(),
    enabled: false,
    error: errorMessage || 'Social automation snapshot could not be loaded.',
    totals: {
      configured: cfg.channels.length,
      ready: nextChannels.filter((channel) => channel.ready).length,
      queued: 0,
      targetQueued: nextChannels.filter((channel) => channel.ready).reduce((sum, channel) => sum + (channel.targetQueued || 0), 0),
      belowTarget: nextChannels.filter((channel) => channel.ready).length,
      paused: 0,
      recentErrors: 0,
    },
    channels: nextChannels,
    scheduledPosts: [],
    recentPosts: [],
  };
}

async function bufferRequest(apiKey, query, variables = {}) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.map((e) => e.message).join('; ') || json.message || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function shouldAttachImage() {
  return String(process.env.BUFFER_ATTACH_IMAGE || 'true').toLowerCase() !== 'false';
}

function shouldAttachImageForChannel(channel) {
  return shouldAttachImage() && channel?.attachImage !== false;
}

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

async function resolveOrganizationId(cfg) {
  const direct = env('BUFFER_ORGANIZATION_ID');
  if (direct) return direct;

  const firstReady = (cfg?.channels || []).find((channel) => channel.ready && channel.channelId);
  if (!cfg?.apiKey || !firstReady?.channelId) return '';

  const query = `
    query ResolveBufferOrganization($id: ChannelId!) {
      channel(input: { id: $id }) {
        organizationId
      }
    }
  `;
  const json = await bufferRequest(cfg.apiKey, query, { id: firstReady.channelId });
  return String(json?.data?.channel?.organizationId || '').trim();
}

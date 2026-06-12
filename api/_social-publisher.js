const BUFFER_GRAPHQL_URL = 'https://api.buffer.com';
const BUFFER_DEFAULT_MODE = process.env.BUFFER_POST_MODE || 'addToQueue';
const BUFFER_DEFAULT_SCHEDULING_TYPE = process.env.BUFFER_SCHEDULING_TYPE || 'automatic';

const CHANNELS = [
  { key: 'facebook', label: 'Facebook', env: ['BUFFER_FACEBOOK_CHANNEL_ID'], kitKey: 'facebook' },
  { key: 'instagram', label: 'Instagram', env: ['BUFFER_INSTAGRAM_CHANNEL_ID'], kitKey: 'instagram' },
  { key: 'linkedin', label: 'LinkedIn', env: ['BUFFER_LINKEDIN_CHANNEL_ID'], kitKey: 'linkedin' },
  { key: 'googleBusiness', label: 'Google Business', env: ['BUFFER_GOOGLE_BUSINESS_CHANNEL_ID', 'BUFFER_GBP_CHANNEL_ID'], kitKey: 'googleBusiness' },
];

export function getSocialAutomationStatus({ imageUrl } = {}) {
  const cfg = bufferConfig();
  return {
    provider: 'buffer',
    enabled: Boolean(cfg.apiKey && cfg.channels.some((channel) => channel.ready)),
    channels: Object.fromEntries(cfg.channels.map((channel) => {
      const missing = [...channel.missing];
      if (channel.key === 'instagram' && !imageUrl && shouldAttachImage()) missing.push('public imageUrl');
      return [channel.key, {
        ready: channel.ready && (channel.key !== 'instagram' || !!imageUrl || !shouldAttachImage()),
        provider: 'buffer',
        channelId: channel.channelId || null,
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
    if (channel.key === 'instagram' && !imageUrl && shouldAttachImage()) missing.push('public imageUrl');
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
      return { ...channel, channelId, ready: missing.length === 0, missing };
    }),
  };
}

function normalizeChannels(channels, configured) {
  const raw = Array.isArray(channels)
    ? channels
    : String(channels || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = raw.length ? new Set(raw) : null;
  return configured.filter((channel) => !wanted || wanted.has(channel.key));
}

function buildCreatePostInput(channel, { title, url, kit, imageUrl, dueAt }) {
  const text = textForChannel(channel, { title, url, kit });
  const input = {
    text,
    channelId: channel.channelId,
    schedulingType: BUFFER_DEFAULT_SCHEDULING_TYPE,
    mode: dueAt ? 'customScheduled' : BUFFER_DEFAULT_MODE,
    source: 'assembleatease-content-engine',
    aiAssisted: true,
  };

  if (dueAt) input.dueAt = dueAt;
  if (imageUrl && shouldAttachImage()) input.assets = [{ image: { url: imageUrl } }];
  return input;
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

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

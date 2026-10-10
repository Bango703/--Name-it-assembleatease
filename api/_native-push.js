// Native push for the Easer iOS / Android app, through Firebase Cloud Messaging
// (FCM HTTP v1). Web push (api/_push.js, VAPID) is unchanged; this only adds a
// second delivery channel for devices that installed the app.
//
// Safe by construction:
//   - no FIREBASE_SERVICE_ACCOUNT configured  → skipped, nothing changes
//   - native_push_tokens table not created yet → skipped, nothing changes
//   - a token FCM reports as gone             → deleted, like a 410 web endpoint
// No new dependency: the OAuth token is a service-account JWT signed with
// node:crypto (RS256), exchanged at Google's token endpoint and cached.

import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cachedAccess = null; // { token, expiresAt }

export function loadFirebaseServiceAccount(env = process.env) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const account = JSON.parse(json);
    if (!account.client_email || !account.private_key || !account.project_id) return null;
    return { ...account, private_key: String(account.private_key).replace(/\\n/g, '\n') };
  } catch (_) {
    return null;
  }
}

/**
 * Why the configured key is unusable, in words that never include the key:
 * whether it is set, its length and first character, whether it parses, and
 * which required field names are missing. Null when the key is usable.
 */
export function firebaseServiceAccountProblem(env = process.env) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return 'FIREBASE_SERVICE_ACCOUNT is not set in this deployment';
  let parsed;
  try {
    parsed = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (_) {
    // Never echo the parser's message: it quotes part of the value.
    return `FIREBASE_SERVICE_ACCOUNT is not valid JSON (length ${raw.length}, starts with character code ${raw.charCodeAt(0)}, ends with ${raw.charCodeAt(raw.length - 1)})`;
  }
  if (!parsed || typeof parsed !== 'object') return 'FIREBASE_SERVICE_ACCOUNT is not a JSON object';
  const missing = ['client_email', 'private_key', 'project_id'].filter(k => !parsed[k]);
  return missing.length ? `FIREBASE_SERVICE_ACCOUNT is missing: ${missing.join(', ')}` : null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function buildServiceAccountJwt(account, nowSec = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
}

async function accessToken(account, fetchImpl) {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60000) return cachedAccess.token;
  const resp = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildServiceAccountJwt(account) }).toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(`Firebase auth failed (${resp.status})`);
  cachedAccess = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedAccess.token;
}

function isMissingTable(error) {
  if (!error) return false;
  return ['42P01', 'PGRST205', 'PGRST204'].includes(error.code) || /native_push_tokens|schema cache|does not exist/i.test(String(error.message || ''));
}

// FCM data values must be strings.
function stringData(payload) {
  const out = {};
  for (const [k, v] of Object.entries({ url: payload.url, jobId: payload.jobId, urgent: payload.urgent })) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

export function buildFcmMessage(token, payload) {
  return {
    message: {
      token,
      notification: { title: String(payload.title || 'AssembleAtEase'), body: String(payload.body || '') },
      data: stringData(payload),
      android: { priority: 'high', notification: { sound: 'default', channel_id: 'jobs' } },
      apns: { payload: { aps: { sound: 'default' } } },
    },
  };
}

// Send to every installed app for this user. Returns rows for notification_log.
export async function sendNativePushToUser(sb, userId, payload, meta = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const account = loadFirebaseServiceAccount(env);
  if (!account) return { skipped: true, reason: 'native_push_not_configured', error: firebaseServiceAccountProblem(env), sent: 0, failed: 0, logRows: [] };

  const { data: tokens, error } = await sb.from('native_push_tokens').select('token, platform').eq('user_id', userId);
  if (error) {
    if (isMissingTable(error)) return { skipped: true, reason: 'native_push_table_missing', sent: 0, failed: 0, logRows: [] };
    return { skipped: true, reason: 'native_push_tokens_unreadable', error: error.message, sent: 0, failed: 0, logRows: [] };
  }
  if (!tokens?.length) return { skipped: true, reason: 'no_native_devices', sent: 0, failed: 0, logRows: [] };

  let bearer;
  try {
    bearer = await accessToken(account, fetchImpl);
  } catch (e) {
    return { skipped: false, reason: 'native_push_auth_failed', error: e.message, sent: 0, failed: tokens.length, logRows: [] };
  }

  const dead = [];
  const logRows = [];
  await Promise.all(tokens.map(async ({ token, platform }) => {
    let status = 'sent';
    let errorText = null;
    try {
      const resp = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFcmMessage(token, payload)),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode || body?.error?.status || '';
        status = 'failed';
        errorText = `${resp.status} ${code}`.trim();
        // Only a device FCM says is gone is removed; INVALID_ARGUMENT can be our own payload.
        if (resp.status === 404 || code === 'UNREGISTERED') dead.push(token);
      }
    } catch (e) {
      status = 'failed';
      errorText = e.message || String(e);
    }
    logRows.push({
      channel: 'push',
      booking_id: meta.bookingId || null,
      notification_type: meta.notificationType || 'push',
      recipient_type: meta.recipientType || 'easer',
      recipient_user_id: userId,
      subject: payload.title || null,
      provider_id: `fcm:${platform}:${token.slice(-24)}`,
      status,
      error_text: errorText,
    });
  }));

  if (dead.length) await sb.from('native_push_tokens').delete().in('token', dead);
  const sent = logRows.filter((r) => r.status === 'sent').length;
  return { skipped: false, sent, failed: logRows.length - sent, logRows };
}

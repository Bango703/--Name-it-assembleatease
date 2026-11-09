import { chicagoTodayIso } from './booking/_appt-date.js';

// iPhone Easers take job offers in the Easer app (owner, 2026-11-08). Matches
// the dispatch-model platforms: TaskRabbit Taskers register and work in the
// Tasker app, DoorDash and Instacart require theirs. Everyone not on an iPhone
// keeps the website until there is an Android app. Strictly Easers: customers
// always book on the website.
//
// Off until the owner sets EASER_IPHONE_APP_REQUIRED_FROM (YYYY-MM-DD, Austin
// time). Before that date iPhone browsers see a banner naming the date; from
// it, offers and unaccepted assignments are left out of the web job list on an
// iPhone browser and cannot be accepted there. A job already accepted always
// stays workable on the web, so nobody is stopped mid-job.

export const EASER_IOS_APP_URL = 'https://apps.apple.com/us/app/easer-by-assembleatease/id6820654960';

export function easerAppPolicy({ env = process.env, now = new Date() } = {}) {
  const raw = String(env.EASER_IPHONE_APP_REQUIRED_FROM || '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw + 'T12:00:00Z')) ? raw : null;
  return {
    iosAppUrl: EASER_IOS_APP_URL,
    iphoneRequiredFrom: from,
    iphoneRequired: from != null && chicagoTodayIso(now) >= from,
  };
}

/**
 * A web browser on an iPhone. The Easer app's own requests come from iOS's
 * networking stack ("Easer/1 CFNetwork/... Darwin/..."), never a browser
 * string, so the app is never treated as a browser.
 */
export function isIPhoneBrowser(userAgent) {
  const ua = String(userAgent || '');
  return /^Mozilla\//.test(ua) && /\((iPhone|iPod)[;)]/.test(ua);
}

/**
 * A request from one of our native iPhone apps: iOS's networking stack, never
 * a browser. Only Easer routes call this, so on them it means the Easer app.
 */
export function isEaserNativeApp(userAgent) {
  const ua = String(userAgent || '');
  return !/^Mozilla\//.test(ua) && /\bCFNetwork\/[\d.]+ Darwin\//.test(ua);
}

/** True when this request must take offers in the app instead. */
export function offersBelongInApp(req, policy = easerAppPolicy()) {
  return policy.iphoneRequired && isIPhoneBrowser(req?.headers?.['user-agent']);
}

// Easers among `ids` known to use the Easer app: a push sign-in on a phone, or
// a completed delivery of the app announcement (written by markEaserAppSeen).
export async function easerIdsWithApp(sb, ids, announcementIds) {
  const tokens = await sb.from('native_push_tokens').select('user_id').in('user_id', ids);
  if (tokens.error) return { ids: null, error: tokens.error };
  const found = new Set((tokens.data || []).map((row) => row.user_id));
  const annIds = [].concat(announcementIds || []).filter(Boolean);
  if (annIds.length) {
    const seen = await sb.from('easer_announcement_deliveries')
      .select('easer_id').in('announcement_id', annIds).in('easer_id', ids).not('completed_at', 'is', null);
    if (seen.error) return { ids: null, error: seen.error };
    for (const row of seen.data || []) found.add(row.easer_id);
  }
  return { ids: found, error: null };
}

// For the owner's Easer panel: whether this Easer uses the Easer app, and
// whether they have been seen on an iPhone (the device they signed the
// contractor agreement on). Unreadable records say unknown, never "no"
// (Article 16).
export async function easerAppStatus(sb, profile = {}) {
  const iphoneSeen = isIPhoneBrowser(profile.contractor_agreement_user_agent);
  const device = iphoneSeen ? 'signed the agreement on an iPhone'
    : (profile.contractor_agreement_user_agent ? 'signed the agreement on another device' : 'agreement device not recorded');
  const anns = await sb.from('easer_announcements').select('id').eq('target_rule', 'easer_app_missing');
  const withApp = anns.error ? { ids: null, error: anns.error }
    : await easerIdsWithApp(sb, [profile.id], (anns.data || []).map((a) => a.id));
  if (withApp.error) return { known: false, installed: null, iphoneSeen, label: 'Unknown - the app record could not be read; ' + device };
  const installed = withApp.ids.has(profile.id);
  return { known: true, installed, iphoneSeen, label: (installed ? 'Uses the Easer app' : 'No Easer app use recorded') + '; ' + device };
}

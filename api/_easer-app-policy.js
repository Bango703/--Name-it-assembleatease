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

/** True when this request must take offers in the app instead. */
export function offersBelongInApp(req, policy = easerAppPolicy()) {
  return policy.iphoneRequired && isIPhoneBrowser(req?.headers?.['user-agent']);
}

// Whether the Easer app is signed in on a phone (native_push_tokens, written by
// api/assembler/native-push-register.js). An unreadable table is "unknown",
// never "no app" (Article 16).
export async function easerAppStatus(sb, userId) {
  const { data, error } = await sb.from('native_push_tokens').select('platform').eq('user_id', userId);
  if (error) return { known: false, installed: null, label: 'Unknown - the app sign-in record could not be read' };
  const platforms = [...new Set((data || []).map(row => row.platform).filter(Boolean))];
  if (!platforms.length) return { known: true, installed: false, platforms, label: 'No app sign-in recorded' };
  const names = platforms.map(p => (p === 'ios' ? 'iPhone' : p === 'android' ? 'Android' : p));
  return { known: true, installed: true, platforms, label: 'Signed in on ' + names.join(' and ') };
}

import { esc } from './_email.js';
import { normalizePersonName } from './_person-name.js';
import { loadCustomerFacingCompletionPhoto } from './booking/_completion-evidence.js';

// Single source of truth for the customer review-request email — used by BOTH the
// automatic cron (api/cron/review-request.js) and the owner's manual send
// (api/review-request.js), so the two can never drift apart again.

// Same Google profile link the /review page offers after a rating. Offered to every
// customer, never only to those who rate highly.
export const GOOGLE_REVIEW_URL = (process.env.GOOGLE_REVIEW_URL || '').trim()
  || 'https://g.page/r/CeHfRKINOeZsEBM/review';

// How it looks (owner, 2026-11-17). The request is a FRAGMENT, so sendEmail puts
// it in the one email frame every other AssembleAtEase email uses: logo header,
// white card, house footer. From Oct 23 to Nov 17 it was a hand-built bare page
// (no header, no card, the footer stapled under it), because the earlier
// designed version was thought to land in Gmail's Promotions tab. Neither
// version brought back a review, and opens were never measured, so that theory
// was never tested. See docs/incidents/2026-11-17-review-email-look.md.
//
// What it is now, from how marketplaces ask: the job (service, day, pro), one
// question, and the answer as five tappable stars. Each star opens /review with
// that rating already chosen (review.html reads ?rating=). The Google link sits
// under the stars for everyone, never only for high ratings (Google's policy and
// the FTC review rule both forbid selective asking). Still no photo, no offer
// and no button blocks: those read as an advert. The thank-you reward and its
// "any rating qualifies" terms stay on /review, shown before submitting.

// The same gold as the lit stars on /review, so the tap and the page match.
const STAR_GOLD = '#f59e0b';

// First request and one follow-up. Step is 1-based.
export const STEP_COPY = {
  1: {
    subject: (b, first) => (first ? `How did it go, ${first}?` : `How did your ${b.service} go?`),
    opening: (first) => `Hi ${esc(first || 'there')}, thanks for booking with AssembleAtEase. Tap a star to rate the job.`,
  },
  2: {
    subject: (b) => `Quick follow-up on your ${b.service} job`,
    opening: (first, b) => `Hi ${esc(first || 'there')}, following up once on your ${esc(b.service)} job. Tap a star to rate it.`,
  },
};

function firstNameOf(b) {
  const first = String(b?.customer_name || '').trim().split(/\s+/)[0] || '';
  return first ? normalizePersonName(first) : '';
}

// "Tue, Nov 11" in Texas time, or '' when the booking has no completion time.
export function finishedOn(b) {
  const at = b?.completed_at ? new Date(b.completed_at) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }).format(at);
}

// The review link with a rating already chosen.
export function ratingUrl(url, rating) {
  return `${url}${url.includes('?') ? '&' : '?'}rating=${rating}`;
}

function ratingStars(url) {
  const cells = [1, 2, 3, 4, 5].map(n => {
    const label = `${n} star${n === 1 ? '' : 's'}`;
    return `<td style="padding:0 3px"><a href="${ratingUrl(url, n)}" title="${label}" aria-label="${label}" style="display:block;font-size:40px;line-height:44px;color:${STAR_GOLD};text-decoration:none">&#9733;</a></td>`;
  }).join('');
  // The labels share the stars' table, so they sit under the first and last star
  // whatever width the client draws the glyph at.
  const label = 'padding-top:2px;font-size:12px;color:#71717a;white-space:nowrap';
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto"><tr>${cells}</tr>
<tr><td colspan="2" style="${label};text-align:left">Poor</td><td></td><td colspan="2" style="${label};text-align:right">Excellent</td></tr></table>`;
}

/**
 * The review request: { subject, html, preheader }. `html` is a fragment for
 * sendEmail to frame; the caller adds nothing but the unsubscribe block.
 */
export function buildReviewEmail(step, b, url, { proFirst } = {}) {
  const c = STEP_COPY[step] || STEP_COPY[1];
  const first = firstNameOf(b);
  const pro = String(proFirst || '').trim();
  const when = finishedOn(b);
  const html = `<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#0099CC">${esc(b.service)}${when ? ` &middot; ${esc(when)}` : ''}</p>
<p style="margin:0 0 12px;font-size:22px;font-weight:700;line-height:1.3;color:#1a1a1a">${pro ? `How did ${esc(pro)} do?` : 'How did it go?'}</p>
<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#3f3f46">${c.opening(first, b)}</p>
${ratingStars(url)}
<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#71717a;text-align:center"><a href="${url}" style="color:#0099CC">Open the review page</a> &nbsp;&middot;&nbsp; <a href="${GOOGLE_REVIEW_URL}" style="color:#0099CC">Review us on Google</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0;background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;font-size:13px;line-height:1.6;color:#52525b">
  <p style="margin:0 0 6px">If anything is not right, reply to this email and we will take care of it.</p>
  <p style="margin:0">Did your pro offer to work with you directly, outside AssembleAtEase? Reply to this email and tell us.</p>
</td></tr></table>
<p style="margin:22px 0 0;font-size:15px;line-height:1.6;color:#3f3f46">Thanks,<br/>The AssembleAtEase Team</p>`;
  const preheader = `Tap a star to rate your ${b.service} job.`;
  return { subject: c.subject(b, first), html, preheader };
}

// The Easer's completion photo as a signed URL (30-day), or null. Reuses the same
// evidence source of truth as the completion email so they never disagree.
export async function completionPhotoUrl(sb, b) {
  try {
    const { evidence } = await loadCustomerFacingCompletionPhoto(sb, b, { allowHistoricalOwnerManual: true });
    if (!evidence?.storage_path) return null;
    const { data: signed } = await sb.storage
      .from('booking-evidence')
      .createSignedUrl(evidence.storage_path, 60 * 60 * 24 * 30);
    return signed?.signedUrl || null;
  } catch {
    return null;
  }
}

// Booking IDs (from the given candidate set) that have an OPEN operations case —
// damage, dispute, payment, safety, quality, etc. The automatic review sequence
// skips these; the owner can still send manually. Returns a Set.
export async function bookingsWithOpenCase(sb, bookingIds) {
  const blocked = new Set();
  if (!bookingIds?.length) return blocked;
  try {
    const { data, error } = await sb
      .from('operations_cases')
      .select('booking_id')
      .in('booking_id', bookingIds)
      .not('status', 'in', '(resolved,closed)');
    if (error) {
      // Fail SAFE toward the customer-trust rule: if we can't confirm a booking is
      // clear of disputes, don't risk asking for a public review — skip the batch.
      console.error('open-case lookup failed; suppressing auto review this run:', error.message);
      return null;
    }
    for (const r of data || []) if (r.booking_id) blocked.add(r.booking_id);
  } catch (e) {
    console.error('open-case lookup exception:', e?.message || e);
    return null;
  }
  return blocked;
}

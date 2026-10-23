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

// Owner, 2026-10-23: no reviews came back, and the request was landing in
// Gmail's Promotions tab. It read like an advert: a star grid, a large photo, a
// discount box and button blocks. It now reads like a plain note from the business: a
// few plain lines, two text links and a signature. The thank-you reward and its
// "any rating qualifies" terms are shown on /review before submitting, and
// the opt-out footer still comes from the marketing path in api/_email.js.

// First request and one follow-up. Step is 1-based.
export const STEP_COPY = {
  1: {
    subject: (b, first) => (first ? `How did it go, ${first}?` : `How did your ${b.service} go?`),
    opening: (b, pro) => `Thanks for booking with AssembleAtEase. ${pro ? `${esc(pro)} finished your ${esc(b.service)} job` : `Your ${esc(b.service)} job is finished`}. How did it go?`,
  },
  2: {
    subject: (b) => `Quick follow-up on your ${b.service} job`,
    opening: (b) => `Following up once on your ${esc(b.service)} job. If you have a minute, we would love to hear how it went.`,
  },
};

function firstNameOf(b) {
  const first = String(b?.customer_name || '').trim().split(/\s+/)[0] || '';
  return first ? normalizePersonName(first) : '';
}

export function buildReviewEmail(step, b, url, { proFirst } = {}) {
  const c = STEP_COPY[step] || STEP_COPY[1];
  const first = firstNameOf(b);
  const p = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#1a1a1a';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px 18px">
  <p style="${p}">Hi ${esc(first || 'there')},</p>
  <p style="${p}">${c.opening(b, proFirst)}</p>
  <p style="${p}">If you have a minute, you can leave a quick review here: <a href="${url}" style="color:#0369a1">rate your ${esc(b.service)} job</a>. You can also leave one on Google: <a href="${GOOGLE_REVIEW_URL}" style="color:#0369a1">Review us on Google</a>.</p>
  <p style="${p}">If anything is not right, reply to this email and we will take care of it.</p>
  <p style="${p}">Did your pro offer to work with you directly, outside AssembleAtEase? Reply to this email and tell us.</p>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#1a1a1a">Thanks,<br/>The AssembleAtEase Team</p>
  <p style="margin:18px 0 0;font-size:12px;color:#71717a">Serving customers across Texas</p>
</div></body></html>`;
  return { subject: c.subject(b, first), html };
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

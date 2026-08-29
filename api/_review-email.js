import { esc } from './_email.js';
import { loadCustomerFacingCompletionPhoto } from './booking/_completion-evidence.js';

// Single source of truth for the customer review-request email — used by BOTH the
// automatic cron (api/cron/review-request.js) and the owner's manual send
// (api/review-request.js), so the two can never drift apart again.

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

// Three escalating-but-respectful variants. Step is 1-based. intro(b, pro).
export const STEP_COPY = {
  1: {
    subject: (b) => `How did your ${b.service} go? — ${b.ref}`,
    headline: 'How was your experience?',
    intro: (b, pro) => `Your <strong>${esc(b.service)}</strong>${pro ? ` with ${esc(pro)}` : ''} is complete. Tap a star below to rate it — your booking details are already filled in.`,
    note: `Not happy with something? Just reply to this email within 48 hours and we&rsquo;ll make it right.`,
  },
  2: {
    subject: (b) => `Quick favor — rate your ${b.service}?`,
    headline: 'Still have 30 seconds?',
    intro: (b, pro) => `We&rsquo;d still love to hear how your <strong>${esc(b.service)}</strong>${pro ? ` with ${esc(pro)}` : ''} went. It takes about 30 seconds — just tap a star below.`,
    note: `Something not right? Reply here and we&rsquo;ll take care of it.`,
  },
  3: {
    subject: (b) => `Last chance to rate your ${b.service}`,
    headline: 'One last ask',
    intro: (b, pro) => `This is the last time we&rsquo;ll ask &mdash; promise. A quick rating of your <strong>${esc(b.service)}</strong> helps ${pro ? esc(pro) : 'your pro'} and other Texas neighbors know what to expect. One tap is all it takes.`,
    note: `Prefer not to? No problem &mdash; you won&rsquo;t hear from us about this again.`,
  },
};

// Clickable in-email star rating — each star deep-links to the review page with the
// rating pre-selected, so a single tap from the inbox starts the review.
export function starRow(url) {
  let cells = '';
  for (let n = 1; n <= 5; n++) {
    cells += `<td style="padding:0 3px"><a href="${url}&rating=${n}" style="display:inline-block;font-size:40px;line-height:1;color:#f5b301;text-decoration:none" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</a></td>`;
  }
  return `<table cellpadding="0" cellspacing="0" align="center" style="margin:2px auto"><tr>${cells}</tr></table>`;
}

// The Easer's completion photo — visual proof of the finished work, so the customer
// sees exactly what they're rating right in the email.
export function photoBlock(url, service) {
  if (!url) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td>
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">Here&rsquo;s the ${esc(service)} your pro completed:</p>
    <img src="${url}" alt="Completed ${esc(service)}" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e4e4e7;display:block"/>
  </td></tr></table>`;
}

export function buildReviewEmail(step, b, url, { photoUrl, proFirst } = {}) {
  const c = STEP_COPY[step] || STEP_COPY[1];
  const headline = (step === 1 && proFirst) ? `How did ${esc(proFirst)} do?` : c.headline;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">${headline}</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">${c.intro(b, proFirst)}</p>
    ${photoBlock(photoUrl, b.service)}
    <p style="margin:0 0 2px;font-size:13px;font-weight:600;color:#374151;text-align:center">Tap a star to rate</p>
    ${starRow(url)}
    <p style="margin:14px 0 0;text-align:center"><a href="${url}" style="font-size:13px;color:#0369a1;text-decoration:underline">or write a full review &rsaquo;</a></p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;margin:20px 0 16px"><tr><td style="padding:12px 16px;font-size:13px;color:#0c4a6e;line-height:1.6">
      ${c.note}
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Thank you for choosing AssembleAtEase.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    Ref: ${esc(b.ref)} &bull; AssembleAtEase &bull; Serving customers across Texas
  </td></tr></table>
</div></body></html>`;
  return { subject: c.subject(b), html };
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

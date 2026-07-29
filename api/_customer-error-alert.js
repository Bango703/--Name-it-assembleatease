import { sendEmail, ownerEmail, esc } from './_email.js';

// Real-time owner alert when a customer-facing request fails with a server/config
// error (5xx) — the kind that silently costs a booking (the tax-config block was
// exactly this). Wrapping res.json means EVERY current and future 5xx on a
// guarded endpoint alerts the owner; no per-error hooks to forget. Deduped by
// reason code (one alert per error type per 30 min) so a broken config informs
// the owner without flooding the inbox. Alerting can never block or break the
// customer's response — it is fire-and-forget and fully wrapped in try/catch.
export function guardCustomerFacing(req, res, context) {
  if (!res || typeof res.json !== 'function') return;
  const originalJson = res.json.bind(res);
  let alerted = false;
  res.json = function patchedJson(body) {
    try {
      const statusCode = Number(res.statusCode) || 0;
      if (!alerted && statusCode >= 500) {
        alerted = true;
        const errText = body && typeof body === 'object' ? String(body.error || '') : '';
        const errCode = body && typeof body === 'object' ? String(body.code || '') : '';
        alertOwnerOfCustomerBlock({ context, statusCode, errText, errCode }).catch(() => {});
      }
    } catch { /* alerting must never break the response */ }
    return originalJson(body);
  };
}

async function alertOwnerOfCustomerBlock({ context, statusCode, errText, errCode }) {
  const dedupeKey = errCode || `status_${statusCode}`;
  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Action needed — a customer hit an error (${context})`,
    html: `<p style="font-size:15px;line-height:1.7"><strong>A customer just hit a server error and may not have finished their booking.</strong></p>
      <p style="font-size:14px;line-height:1.7;color:#52525b">Where: <strong>${esc(context)}</strong><br>Status: ${statusCode}${errCode ? ` &middot; <code>${esc(errCode)}</code>` : ''}<br>Message the customer saw: &ldquo;${esc(errText || 'Server error')}&rdquo;</p>
      <p style="font-size:14px;line-height:1.7">Check this now so you don't lose the job — if the customer reached out, follow up directly. Repeats of the same error are grouped for 30 minutes so this won't flood you.</p>`,
    replyTo: ownerEmail(),
    meta: { notificationType: `customer_block_${dedupeKey}`, recipientType: 'owner', dedupeWindowMin: 30 },
  });
}

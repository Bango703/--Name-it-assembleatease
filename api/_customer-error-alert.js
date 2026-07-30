import { sendEmail, ownerEmail, esc } from './_email.js';

// Real-time owner alert when a customer-facing request fails with a server/config
// error (5xx), including the safe contact context needed to recover the lead.
// The alert is deliberately limited to server failures so ordinary validation,
// card declines, and expected rate limits do not flood the owner.
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
        alertOwnerOfCustomerBlock({ req, context, statusCode, errText, errCode }).catch(error => {
          console.error('Customer-block owner alert failed:', error?.message || error);
        });
      }
    } catch {
      // Alerting must never alter the customer's response.
    }
    return originalJson(body);
  };
}

function parseRequestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    return {};
  }
}

function safeText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function customerRecoveryContext(req) {
  const body = parseRequestBody(req);
  const name = safeText(
    body.name || body.customerName || [body.firstName, body.lastName].filter(Boolean).join(' '),
    120,
  );
  const rawEmail = safeText(body.email || body.customerEmail, 254).toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawEmail) ? rawEmail : '';
  const ref = safeText(body.ref || body.bookingRef, 40);
  const bookingId = safeText(body.bookingId, 80);
  const route = safeText(req?.url || req?.originalUrl, 160);
  return { name, email, ref, bookingId, route };
}

async function alertOwnerOfCustomerBlock({ req, context, statusCode, errText, errCode }) {
  const recovery = customerRecoveryContext(req);
  const contextKey = safeText(context, 60).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'customer_flow';
  const reasonKey = (safeText(errCode, 80) || `status_${statusCode}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const dedupeKey = `${contextKey}_${reasonKey}`;
  const validBookingId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recovery.bookingId)
    ? recovery.bookingId
    : null;
  const recoveryLines = [
    recovery.name ? `Customer name: <strong>${esc(recovery.name)}</strong>` : '',
    recovery.email ? `Customer email: <a href="mailto:${esc(recovery.email)}">${esc(recovery.email)}</a>` : '',
    recovery.ref ? `Booking reference: <strong>${esc(recovery.ref)}</strong>` : '',
    recovery.bookingId ? `Booking ID: <code>${esc(recovery.bookingId)}</code>` : '',
    recovery.route ? `Route: <code>${esc(recovery.route)}</code>` : '',
  ].filter(Boolean);

  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Action needed — a customer hit an error (${context})`,
    html: `<p style="font-size:15px;line-height:1.7"><strong>A customer just hit a server error and may not have finished their booking.</strong></p>
      <p style="font-size:14px;line-height:1.7;color:#52525b">Where: <strong>${esc(context)}</strong><br>Status: ${statusCode}${errCode ? ` &middot; <code>${esc(errCode)}</code>` : ''}<br>Message the customer saw: &ldquo;${esc(errText || 'Server error')}&rdquo;</p>
      ${recoveryLines.length ? `<p style="font-size:14px;line-height:1.7;color:#52525b">${recoveryLines.join('<br>')}</p>` : ''}
      <p style="font-size:14px;line-height:1.7">Check this now so you do not lose the job. Use the customer details above when available; never request or send card details by email. Repeats of the same error in this exact step are grouped for 30 minutes.</p>`,
    replyTo: ownerEmail(),
    meta: {
      bookingId: validBookingId,
      notificationType: `customer_block_${dedupeKey}`,
      recipientType: 'owner',
      dedupeWindowMin: 30,
    },
  });
}

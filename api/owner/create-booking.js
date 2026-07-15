import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc, buildStatusEmail } from '../_email.js';
import { TX_TAX_RATE } from '../_pricing.js';
import { randomToken, guestMutationTokenHash } from '../_payment-security.js';
import { normalizeUsPhone } from '../_phone.js';
import { logActivity } from '../booking/_activity.js';

// Record-only owner-created bookings. These never receive an Easer assignment
// and never touch Stripe capture, so a distinct source + offline_recorded
// payment status keeps them out of the automated dispatch/capture/payout lanes.
const PAYMENT_METHODS = ['stripe_manual', 'cash', 'zelle', 'cashapp', 'card_on_site', 'invoice'];
const OVERRIDE_REASONS = ['price_match', 'repeat_customer', 'goodwill', 'bundle', 'other'];
const PAYMENT_METHOD_LABELS = {
  stripe_manual: 'card (charged directly with AssembleAtEase)',
  cash: 'cash on completion',
  zelle: 'Zelle on completion',
  cashapp: 'Cash App on completion',
  card_on_site: 'card on-site on completion',
  invoice: 'invoice',
};
const MAX_PRICE_CENTS = 2_500_000;

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const {
    service,
    firstName,
    lastName,
    phone: rawPhone,
    email,
    address,
    date,
    time,
    standardPriceCents,
    finalPriceCents,
    priceOverrideReason,
    paymentMethod,
    note,
    sendConfirmation,
  } = req.body || {};

  // ── Service (free text so the owner can log the exact job) ──
  const cleanService = String(service || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!cleanService) return res.status(400).json({ error: 'Service is required.' });

  // ── Customer name: first required, last optional (do not invent a last name) ──
  const cleanFirst = String(firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!cleanFirst) return res.status(400).json({ error: 'Customer first name is required.' });
  const cleanLast = String(lastName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const customerName = `${cleanFirst}${cleanLast ? ` ${cleanLast}` : ''}`;

  // ── Email optional but validated when present (drives reminders + reviews) ──
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address or leave it blank.', code: 'INVALID_EMAIL' });
  }

  // ── Phone optional ──
  const phone = rawPhone ? normalizeUsPhone(rawPhone) : null;
  if (rawPhone && !phone) {
    return res.status(400).json({ error: 'Enter a valid 10-digit US phone number or leave it blank.', code: 'INVALID_PHONE' });
  }

  // ── Address required. Owner intentionally bypasses the active-market ZIP gate. ──
  const cleanAddress = String(address || '').trim().replace(/\s+/g, ' ').slice(0, 240);
  if (!cleanAddress) return res.status(400).json({ error: 'Service address is required.' });

  // ── Appointment date required (YYYY-MM-DD); time optional. Owner sets freely. ──
  const cleanDate = String(date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    return res.status(400).json({ error: 'Enter the appointment date as YYYY-MM-DD.', code: 'INVALID_DATE' });
  }
  const cleanTime = String(time || '').trim().slice(0, 40) || null;

  // ── Pricing (tax-inclusive: the final price is all-in, back out Texas tax) ──
  const finalCents = Number.parseInt(finalPriceCents, 10);
  if (!Number.isInteger(finalCents) || finalCents < 100 || finalCents > MAX_PRICE_CENTS) {
    return res.status(400).json({ error: 'Final price must be between $1.00 and $25,000.00.' });
  }
  let standardCents = null;
  if (standardPriceCents != null && String(standardPriceCents) !== '') {
    standardCents = Number.parseInt(standardPriceCents, 10);
    if (!Number.isInteger(standardCents) || standardCents < 0 || standardCents > MAX_PRICE_CENTS) {
      return res.status(400).json({ error: 'Standard price is out of range.' });
    }
  }
  const subtotalCents = Math.round(finalCents / (1 + TX_TAX_RATE));
  const taxCents = finalCents - subtotalCents;

  const method = paymentMethod == null || paymentMethod === '' ? null : String(paymentMethod);
  if (method != null && !PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: 'Unsupported payment method.' });
  }
  const reason = priceOverrideReason == null || priceOverrideReason === '' ? null : String(priceOverrideReason);
  if (reason != null && !OVERRIDE_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'Unsupported price-override reason.' });
  }
  const cleanNote = String(note || '').trim().slice(0, 2000) || null;

  const sb = getSupabase();
  const ref = 'AAE-' + randomToken(8).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  const now = new Date().toISOString();

  const insertPayload = {
    ref,
    service: cleanService,
    customer_name: customerName,
    customer_phone: phone,
    customer_email: cleanEmail || null,
    address: cleanAddress,
    date: cleanDate,
    time: cleanTime,
    details: null,
    status: 'confirmed',
    payment_status: 'offline_recorded',
    confirmed_by: 'owner_manual',
    confirmed_at: now,
    total_price: finalCents,
    tax_amount: taxCents,
    source: 'owner_manual',
    payment_method: method,
    price_override_reason: reason,
    standard_price_cents: standardCents,
    owner_booking_note: cleanNote,
  };

  const { data: saved, error: insertErr } = await sb
    .from('bookings').insert(insertPayload).select('id').single();
  if (insertErr || !saved) {
    console.error('Owner create-booking insert error:', insertErr);
    if (insertErr && /column .* does not exist|source|payment_method|price_override_reason/i.test(String(insertErr.message || ''))) {
      return res.status(503).json({
        error: 'Owner-booking columns are missing. Apply migration 038_owner_manual_bookings.sql, then retry.',
        code: 'OWNER_BOOKING_MIGRATION_REQUIRED',
      });
    }
    return res.status(500).json({ error: 'Failed to save the booking. Please try again.' });
  }
  const bookingId = saved.id;

  // Guest tracking token so a customer with an email can view/cancel via /track.
  if (cleanEmail) {
    const { error: tokenErr } = await sb.from('bookings').update({
      guest_mutation_token_hash: guestMutationTokenHash({ id: bookingId, ref, customer_email: cleanEmail }),
    }).eq('id', bookingId);
    if (tokenErr) console.warn('Owner booking guest-token setup skipped:', tokenErr.message || tokenErr);
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'booking_created',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Owner-created booking for ${customerName} — ${cleanService}. ${standardCents != null ? `Standard ${money(standardCents)} → ` : ''}${money(finalCents)}${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}. Payment: ${method ? PAYMENT_METHOD_LABELS[method] : 'to be collected'}.`,
    metadata: {
      source: 'owner_manual',
      standardPriceCents: standardCents,
      finalPriceCents: finalCents,
      taxCents,
      subtotalCents,
      priceOverrideReason: reason,
      paymentMethod: method,
    },
  }).catch(e => console.warn('Owner booking activity log skipped:', e?.message || e));

  // Owner notice
  sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Owner booking created — ${ref} — ${money(finalCents)}`,
    html: `<p>You created a manual booking <strong>${esc(ref)}</strong> for <strong>${esc(customerName)}</strong>.</p>
      <p>${esc(cleanService)} · ${esc(cleanDate)}${cleanTime ? ` · ${esc(cleanTime)}` : ''}<br>${esc(cleanAddress)}</p>
      <p>Total ${money(finalCents)} (subtotal ${money(subtotalCents)} + tax ${money(taxCents)}). Payment: ${method ? esc(PAYMENT_METHOD_LABELS[method]) : 'to be collected'}.</p>
      ${cleanNote ? `<p><em>${esc(cleanNote)}</em></p>` : ''}
      <p>Mark it completed and payment collected from the booking record after the job.</p>`,
    meta: { bookingId, notificationType: 'owner_booking_created_notice', recipientType: 'owner', disableDedupe: true },
  }).catch(e => console.warn('Owner booking owner-notice email skipped:', e?.message || e));

  // Customer confirmation (only if we have an email and it wasn't opted out)
  let confirmationEmailed = false;
  if (cleanEmail && sendConfirmation !== false) {
    const paymentLine = method
      ? `Payment will be handled directly with AssembleAtEase — ${esc(PAYMENT_METHOD_LABELS[method])}. You will not be charged online.`
      : 'Payment will be arranged directly with AssembleAtEase after the job is completed.';
    const bodyHtml = `
      <p>Thanks for booking with AssembleAtEase. Your appointment is confirmed.</p>
      <table style="width:100%;font-size:14px;border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:6px 0;color:#52525b">Service</td><td style="padding:6px 0;text-align:right"><strong>${esc(cleanService)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#52525b">Date</td><td style="padding:6px 0;text-align:right">${esc(cleanDate)}${cleanTime ? ` · ${esc(cleanTime)}` : ''}</td></tr>
        <tr><td style="padding:6px 0;color:#52525b">Address</td><td style="padding:6px 0;text-align:right">${esc(cleanAddress)}</td></tr>
        <tr><td style="padding:8px 0;color:#52525b;border-top:1px solid #eee"><strong>Agreed total</strong></td><td style="padding:8px 0;text-align:right;border-top:1px solid #eee"><strong>${money(finalCents)}</strong> <span style="color:#52525b;font-weight:400">(tax included)</span></td></tr>
      </table>
      <p>${paymentLine}</p>
      <p><strong>What to expect:</strong> your pro arrives within the scheduled window, confirms the work, completes the assembly, and cleans up. We'll follow up if anything about the appointment changes.</p>
      <p>Questions? Reply to this email, call <a href="tel:+17372906129">737-290-6129</a>, or write <a href="mailto:service@assembleatease.com">service@assembleatease.com</a>.</p>`;
    const emailResult = await sendEmail({
      to: cleanEmail,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Booking confirmed — ${cleanService} — ${ref}`,
      html: buildStatusEmail({
        customerName,
        ref,
        status: 'Confirmed',
        statusColor: '#0369a1',
        statusBg: '#e0f2fe',
        headline: 'Your booking is confirmed',
        bodyHtml,
      }),
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: 'owner_booking_confirmation', recipientType: 'customer' },
    });
    confirmationEmailed = !!emailResult?.ok;
  }

  return res.status(200).json({
    ok: true,
    bookingId,
    ref,
    subtotalCents,
    taxCents,
    totalCents: finalCents,
    confirmationEmailed,
    warnings: (cleanEmail && sendConfirmation !== false && !confirmationEmailed) ? ['confirmation_email_failed'] : [],
  });
}

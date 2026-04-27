import Stripe from 'stripe';
import { getSupabase } from './_supabase.js';
import { upsertContact, createDeal } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';
import { sendEmail, ownerEmail, esc } from './_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

  const { services, items, service: serviceLegacy, name, phone, email, address, date, time, details, totalCents } = req.body;

  // Support both new multi-service payload (services=[]) and legacy single-service (service='')
  const serviceList = Array.isArray(services) && services.length > 0
    ? services
    : (serviceLegacy ? [serviceLegacy] : []);
  const service = serviceList.join(', ');

  if (!service || !name || !phone || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !address || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const KEY = process.env.RESEND_API_KEY;
  const TO  = ownerEmail();
  const ref = 'AAE-' + Date.now().toString(36).toUpperCase();
  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';

  // ── Supabase: save booking ──────────────────────────────────
  const sb = getSupabase();
  const TX_TAX_RATE = 0.0825; // Texas 6.25% + Austin 2%
  const amount = Math.max(parseInt(totalCents) || 0, 0); // tax-inclusive total in cents
  // Back-calculate subtotal and tax for record-keeping
  const subtotalCents = amount > 0 ? Math.round(amount / (1 + TX_TAX_RATE)) : 0;
  const taxCents = amount - subtotalCents;
  const isDeposit = amount >= 20000; // $200+ → deposit flow
  const depositAmountCents = isDeposit ? Math.round(amount * 0.25) : null;

  const { data: savedBooking, error: insertErr } = await sb.from('bookings').insert({
    ref,
    service,
    customer_name: name,
    customer_phone: phone,
    customer_email: email,
    address,
    date,
    time,
    details,
    status: 'pending',
    payment_status: amount > 0 ? 'pending' : 'not_required',
    total_price: amount,
    tax_amount: taxCents,
    is_deposit: isDeposit,
    deposit_amount: depositAmountCents,
  }).select('id').single();

  if (insertErr) {
    console.error('Booking insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to save booking. Please try again.' });
  }

  const bookingId = savedBooking.id;

  // ── Stripe: create customer + PaymentIntent (skip if no price) ──
  let clientSecret = null;

  if (amount > 0 && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      // Find or create Stripe customer
      const existing = await stripe.customers.list({ email, limit: 1 });
      const customer = existing.data[0] || await stripe.customers.create({
        email,
        name,
        metadata: { bookingRef: ref },
      });

      // Create PaymentIntent — authorize card now, capture manually after job completion
      const pi = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: customer.id,
        capture_method: 'manual',
        metadata: {
          bookingRef: ref,
          bookingId,
          type: 'customer_booking',
          isDeposit: isDeposit ? 'true' : 'false',
          depositAmountCents: depositAmountCents ? String(depositAmountCents) : '0',
        },
        description: `${service} — ${name}`,
      });

      // Save Stripe IDs to booking record
      await sb.from('bookings').update({
        stripe_customer_id: customer.id,
        stripe_payment_intent_id: pi.id,
      }).eq('id', bookingId);

      clientSecret = pi.client_secret;
    } catch (stripeErr) {
      console.error('Stripe setup error:', stripeErr);
      // Non-fatal: booking saved, payment setup failed — owner notified via email
    }
  }

  const sService = esc(service);
  const sName = esc(name);
  const sPhone = esc(phone);
  const sEmail = esc(email);
  const sAddress = esc(address);
  const sDate = esc(date);
  const sTime = esc(time);
  const sDetails = esc(details);

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">New Booking Request</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Ref: ${ref}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Services</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;line-height:1.5">${sService}</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px;vertical-align:top">Customer</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="tel:${sPhone}" style="color:#0097a7;text-decoration:none;font-weight:600">${sPhone}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${sEmail}" style="color:#0097a7;text-decoration:none">${sEmail}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Details</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None provided'}</td></tr>
      ${amount > 0 ? `<tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a;vertical-align:top">Est. Total</td><td style="padding:10px 0;border-top:1px solid #f0f0f0;font-weight:700;color:#065f46">$${(amount/100).toFixed(2)}${isDeposit ? ` <span style="font-weight:400;color:#71717a;font-size:12px">(25% deposit = $${(depositAmountCents/100).toFixed(2)} collected at booking)</span>` : ''}</td></tr>` : ''}
      ${clientSecret ? '<tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a">Payment</td><td style="padding:10px 0;border-top:1px solid #f0f0f0"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">CARD PENDING AUTHORIZATION</span></td></tr>' : ''}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Action Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Contact <strong>${sName}</strong> at <a href="tel:${sPhone}" style="color:#1e40af">${sPhone}</a> or <a href="mailto:${sEmail}" style="color:#1e40af">${sEmail}</a> to confirm this appointment.</p>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa;line-height:1.6">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a><br/>Licensed &bull; Insured &bull; Background Checked
  </td></tr></table>
</div></body></html>`;

  const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">We received your booking,&nbsp;${sName}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Thank you for choosing AssembleAtEase. A member of our team will email you within <strong>1 hour</strong> to confirm your appointment.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${ref}</td><td style="text-align:right"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">PENDING CONFIRMATION</span></td></tr>
      </table>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Services</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sService}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None'}</td></tr>
    </table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Email confirmation</strong> — We'll email you within 1 hour to confirm date, time, and scope.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Your technician arrives</strong> — On the scheduled date, a licensed, insured professional will arrive with all tools needed.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0097a7;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">${clientSecret ? 'Card authorized — charged after completion' : 'Pay after completion'}</strong> — ${clientSecret ? `Your card is securely held and will only be charged once the job is complete.${isDeposit ? ` A 25% deposit ($${(depositAmountCents/100).toFixed(2)}) will be collected now to confirm your appointment.` : ''}` : "No upfront payment. You pay only when you're 100% satisfied with the work."}</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Cancellation policy:</strong> Cancel at least 24 hours before your appointment for a full release of any hold. Cancellations within 24 hours may incur a 50% fee. No-shows will be charged the full amount.
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Contact Us</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Licensed &bull; Insured &bull; Background Checked</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a booking was submitted at assembleatease.com. If you did not make this request, please disregard this email.</p>
  </td></tr></table>
</div></body></html>`;

  try {
    // ── Owner notification email ──────────────────────────────
    // When payment is required (clientSecret present), the card hasn't been held yet.
    // Sending an owner email now would be premature — the customer might abandon the
    // card form or the auth might fail. Owner email is sent by /api/booking-confirmed
    // AFTER the frontend successfully calls stripe.confirmCardPayment().
    // When no payment is required (custom quote / free booking), send immediately.
    if (!clientSecret) {
      const ownerResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
          to: [TO],
          subject: 'New Booking - ' + service + ' from ' + name,
          html: ownerHtml,
          reply_to: email,
        }),
      });
      if (!ownerResp.ok) {
        const err = await ownerResp.text();
        console.error('Resend owner error:', err);
      }
      // Send customer email immediately too (no payment to wait for)
      const customerResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AssembleAtEase <booking@assembleatease.com>',
          to: [email],
          subject: 'Booking Confirmed - We received your request!',
          html: customerHtml,
          reply_to: TO,
        }),
      });
      if (!customerResp.ok) {
        console.error('Resend customer error:', await customerResp.text());
      }
    }
    // When clientSecret is present: both owner and customer emails are sent by
    // /api/booking-confirmed after the card authorization succeeds.
    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, phone, address, lifecycleStage: 'opportunity' });
        if (contactId) {
          await createDeal({ contactId, dealName: service + ' — ' + name, service, date, time, details });
        }
      } catch (err) { console.error('HubSpot booking error:', err); }
    }

    return res.status(200).json({
      success: true,
      ref,
      bookingId,
      clientSecret,
      isDeposit,
      depositAmountCents,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}





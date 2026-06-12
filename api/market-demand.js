import { getSupabase } from './_supabase.js';
import { upsertContact, addNote } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';
import { sendEmail, ownerEmail, esc } from './_email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP_RE = /^\d{5}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'market-demand')) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const payload = normalizeRequest(req.body || {});
  const validationError = validateRequest(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const sb = getSupabase();
  const requestRef = 'MR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  const row = {
    request_ref: requestRef,
    status: 'new',
    market_type: 'emerging',
    source: payload.source,
    customer_name: payload.name,
    customer_email: payload.email,
    customer_phone: payload.phone,
    city: payload.city,
    state: payload.state,
    zip_code: payload.zip,
    address: payload.address || null,
    requested_service: payload.requestedService,
    services: payload.services,
    requested_date: payload.date || null,
    desired_time: payload.time || null,
    details: payload.details || null,
    item_summary: payload.items || {},
    estimated_revenue: payload.estimatedRevenue,
  };

  const { data, error } = await sb
    .from('market_requests')
    .insert(row)
    .select('id, request_ref')
    .single();

  if (error) {
    console.error('Market demand insert error:', error);
    return res.status(500).json({ error: 'Failed to save your request. Please try again.' });
  }

  await Promise.allSettled([
    notifyOwner({ ...row, id: data.id }),
    notifyCustomer(row),
    recordHubSpot(row),
  ]);

  return res.status(200).json({
    success: true,
    requestRef: data.request_ref,
    marketType: 'emerging',
    message: 'Request received. We will contact you before scheduling or payment.',
  });
}

function normalizeRequest(body) {
  const services = Array.isArray(body.services) && body.services.length
    ? body.services.map(v => clean(v, 120)).filter(Boolean)
    : (body.service ? [clean(body.service, 120)] : []);

  const requestedService = services.length ? services.join(', ') : clean(body.requestedService, 180);
  const city = clean(body.city, 80);
  const state = clean(body.state, 2).toUpperCase();
  const zip = clean(body.zip || body.zipCode, 5);
  const name = clean(body.name, 120);
  const email = clean(body.email, 180).toLowerCase();
  const phone = clean(body.phone, 40);
  const totalCents = Math.max(parseInt(body.totalCents, 10) || 0, 0);

  return {
    name,
    email,
    phone,
    city,
    state,
    zip,
    address: clean(body.address, 260),
    date: clean(body.date, 20),
    time: clean(body.time, 60),
    details: clean(body.details, 2000),
    requestedService,
    services,
    items: body.items && typeof body.items === 'object' ? body.items : {},
    estimatedRevenue: totalCents,
    source: clean(body.source, 80) || 'booking_out_of_market',
  };
}

function validateRequest(payload) {
  if (!payload.name) return 'Name is required.';
  if (!EMAIL_RE.test(payload.email)) return 'Valid email is required.';
  if (!payload.phone) return 'Phone number is required.';
  if (!payload.city) return 'City is required.';
  if (!payload.state || payload.state.length !== 2) return 'Two-letter state is required.';
  if (!ZIP_RE.test(payload.zip)) return 'Valid 5-digit ZIP code is required.';
  if (!payload.requestedService) return 'Requested service is required.';
  return null;
}

async function notifyOwner(row) {
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase Market Demand <booking@assembleatease.com>',
      subject: `New market demand request — ${row.city}, ${row.state} — ${row.requested_service}`,
      replyTo: row.customer_email,
      meta: { notificationType: 'market_demand', recipientType: 'owner', disableDedupe: true },
      html: buildOwnerEmail(row),
    });
  } catch (err) {
    console.error('Market demand owner email error:', err.message || err);
  }
}

async function notifyCustomer(row) {
  try {
    await sendEmail({
      to: row.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `We received your AssembleAtEase request — ${row.request_ref}`,
      replyTo: ownerEmail(),
      meta: { notificationType: 'market_demand_confirmation', recipientType: 'customer', disableDedupe: true },
      html: buildCustomerEmail(row),
    });
  } catch (err) {
    console.error('Market demand customer email error:', err.message || err);
  }
}

async function recordHubSpot(row) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) return;
  try {
    const contactId = await upsertContact({
      email: row.customer_email,
      name: row.customer_name,
      phone: row.customer_phone,
      address: `${row.city}, ${row.state} ${row.zip_code}`,
      lifecycleStage: 'lead',
    });
    if (contactId) {
      await addNote({
        contactId,
        body: `<strong>Market Demand Request</strong><br>Ref: ${esc(row.request_ref)}<br>Market: ${esc(row.city)}, ${esc(row.state)} ${esc(row.zip_code)}<br>Service: ${esc(row.requested_service)}<br>Desired date: ${esc(row.requested_date || 'Not provided')}<br>No payment collected; emerging-market request only.`,
      });
    }
  } catch (err) {
    console.error('Market demand HubSpot error:', err.message || err);
  }
}

function buildOwnerEmail(row) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
    <div style="padding:22px 24px;border-bottom:3px solid #00BFFF">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#00BFFF">Market Demand</div>
      <div style="font-size:24px;font-weight:800;margin-top:6px">${esc(row.city)}, ${esc(row.state)} ${esc(row.zip_code)}</div>
      <div style="font-size:13px;color:#64748b;margin-top:4px">Ref ${esc(row.request_ref)} &bull; no payment collected &bull; no booking guarantee</div>
    </div>
    <div style="padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        ${emailRow('Customer', row.customer_name)}
        ${emailRow('Email', row.customer_email)}
        ${emailRow('Phone', row.customer_phone)}
        ${emailRow('Service', row.requested_service)}
        ${emailRow('Desired date', row.requested_date || 'Not provided')}
        ${emailRow('Desired time', row.desired_time || 'Not provided')}
        ${emailRow('Estimated revenue', row.estimated_revenue ? '$' + (row.estimated_revenue / 100).toFixed(2) : 'Unknown')}
        ${emailRow('Source', row.source)}
      </table>
      <div style="margin-top:18px;padding:14px 16px;border:1px solid #bae6fd;background:#f0f9ff;border-radius:8px;color:#075985;font-size:13px;line-height:1.6">
        Track this in Owner Dashboard &rarr; Market Demand. Activate a market only after demand and Easer supply are proven.
      </div>
    </div>
  </div>
</div></body></html>`;
}

function buildCustomerEmail(row) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
    <div style="padding:28px 24px;text-align:center;border-bottom:1px solid #e5e7eb">
      <div style="font-size:18px;font-weight:800">Assemble<span style="color:#00BFFF">AtEase</span></div>
      <div style="font-size:24px;font-weight:800;margin-top:18px">We received your request.</div>
      <div style="font-size:14px;color:#64748b;margin-top:8px;line-height:1.6">We are checking local coverage in ${esc(row.city)}, ${esc(row.state)}. No payment was collected. We will contact you before anything is scheduled.</div>
    </div>
    <div style="padding:24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:18px">
        ${emailRow('Reference', row.request_ref)}
        ${emailRow('Requested service', row.requested_service)}
        ${emailRow('ZIP', row.zip_code)}
        ${emailRow('Desired date', row.requested_date || 'Not provided')}
      </table>
      <div style="padding:14px 16px;border:1px solid #dbeafe;background:#eff6ff;border-radius:8px;color:#1e3a8a;font-size:13px;line-height:1.6">
        If service becomes available in your area, we will reach out with next steps before collecting payment or confirming an appointment.
      </div>
    </div>
  </div>
</div></body></html>`;
}

function emailRow(label, value) {
  return `<tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#64748b;width:150px;vertical-align:top">${esc(label)}</td><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;font-weight:700">${esc(value || '—')}</td></tr>`;
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

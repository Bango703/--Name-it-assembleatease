import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { getBookingCatalog, calculateBookingPricing } from '../_pricing.js';
import { priceChangeOrder, changeOrderEligibility, loadChangeOrders, summarizeChangeOrders } from './_change-orders.js';
import { createChangeOrderRequest } from './_change-order-request.js';

const SITE = 'https://www.assembleatease.com';
const BOOKING_COLUMNS = 'id, ref, service, status, payment_status, payment_method_type, total_price, tax_amount, customer_name, customer_email, assembler_id, assembler_name, assembler_accepted_at, address, stripe_customer_id, stripe_payment_method_id, stripe_dispute_id, financial_operation_key, financial_operation_type, financial_operation_started_at';

/**
 * GET/POST /api/booking/extra-work — the Easer on a live job adds work the
 * customer asked for ("while you're here, can you mount the TV?").
 *
 *   GET  ?bookingId   the catalog to choose from and whether the job can take it
 *   POST { bookingId, items: [{ service, name, qty }], note? }
 *
 * The Easer chooses catalog items; the server prices them from the catalog, and
 * the request goes to the customer through the one change-order path
 * (api/booking/_change-order-request.js). Nothing is charged until the customer
 * approves. The Easer never sends or sees a price (Rule 3, Rule 4).
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  const bookingId = req.method === 'GET' ? req.query?.bookingId : req.body?.bookingId;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const user = access.user;

  const { data: booking, error } = await sb.from('bookings').select(BOOKING_COLUMNS).eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The job could not be loaded. Try again.' });
  if (!booking || booking.assembler_id !== user.id || !booking.assembler_accepted_at) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const eligibility = changeOrderEligibility(booking);
  const pending = await pendingCount(sb, booking.id);

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      canAdd: eligibility.ok && pending === 0 && Boolean(booking.customer_email),
      reason: !eligibility.ok ? easerReason(eligibility.reason)
        : pending > 0 ? 'The customer has extra work waiting to approve.'
        : !booking.customer_email ? 'Contact AssembleAtEase to add work to this job.'
        : null,
      services: catalogForEaser(booking.service),
    });
  }

  if (!eligibility.ok) return res.status(409).json({ error: easerReason(eligibility.reason), code: 'CHANGE_ORDER_NOT_ELIGIBLE' });
  if (!booking.customer_email) return res.status(409).json({ error: 'Contact AssembleAtEase to add work to this job.', code: 'NO_CUSTOMER_EMAIL' });

  const requested = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
  if (!requested.length) return res.status(400).json({ error: 'Choose at least one item.' });
  const itemsByService = {};
  for (const item of requested) {
    const service = String(item?.service || '').trim();
    if (!service) continue;
    (itemsByService[service] ||= []).push({ name: item?.name, qty: item?.qty });
  }
  const services = Object.keys(itemsByService);
  if (!services.length) return res.status(400).json({ error: 'Choose at least one item.' });

  const pricing = calculateBookingPricing({ services, itemsByService, zip: null });
  if (pricing.invalidItems.length) return res.status(400).json({ error: `Not in the catalog: ${pricing.invalidItems[0]}` });
  if (pricing.hasCustomQuote) return res.status(400).json({ error: 'A custom-quote item needs AssembleAtEase. Use Get help on this job.' });

  const lines = services.flatMap(service => (pricing.normalizedItems[service] || []).map(i => `${i.qty} × ${i.name}`));
  const note = String(req.body?.note || '').trim().slice(0, 300);
  const description = `Added on site: ${lines.join(', ')}${note ? `. ${note}` : ''}`.slice(0, 500);
  const priced = priceChangeOrder(pricing.itemSubtotalCents);
  if (!priced.ok) return res.status(400).json({ error: priced.error });

  const easerName = booking.assembler_name || 'Your pro';
  const request = await createChangeOrderRequest(sb, {
    booking,
    description,
    itemName: lines[0] || null,
    priced,
    createdBy: 'easer',
    requestedByEaserId: user.id,
    actor: 'easer',
    activityDescription: `${easerName} asked the customer to approve extra work: ${lines.join(', ')}`,
  });
  if (!request.ok) return res.status(request.status).json({ error: request.error, ...(request.code ? { code: request.code } : {}) });

  // The owner sees every request an Easer raises (Rule 8).
  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
    subject: `Extra work requested on site — ${booking.ref}`,
    html: `<p style="font-family:Arial,sans-serif">${esc(easerName)} asked the customer on <strong>${esc(booking.ref)}</strong> to approve extra work: ${esc(lines.join(', '))}.</p>
      <p style="font-family:Arial,sans-serif">Customer price $${(priced.totalCents / 100).toFixed(2)} including tax. ${request.emailResult?.ok === true ? 'The approval email was sent.' : '<strong>The approval email did not send.</strong> Contact the customer.'}</p>
      <p><a href="${SITE}/owner/">Open the dashboard</a></p>`,
    meta: { bookingId: booking.id, notificationType: 'easer_extra_work_requested', recipientType: 'owner', disableDedupe: true },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    changeOrderId: request.created.id,
    customerNotified: request.emailResult?.ok === true,
    message: request.emailResult?.ok === true
      ? `Sent to ${String(booking.customer_name || 'the customer').split(' ')[0]} to approve. Start the extra work once it shows Approved.`
      : 'Saved, but the customer was not reached. AssembleAtEase will contact them.',
  });
}

async function pendingCount(sb, bookingId) {
  try {
    const rows = await loadChangeOrders(bookingId, { sb });
    return summarizeChangeOrders(rows.get(bookingId) || []).pendingCount;
  } catch {
    return 0;
  }
}

/** The eligibility reasons are written for the owner; the Easer gets the action. */
function easerReason(reason) {
  if (/payment method|Klarna|dispute|operation/i.test(String(reason || ''))) {
    return 'Extra work cannot be added to this job here. Use Get help on this job.';
  }
  return reason || 'Extra work cannot be added to this job right now.';
}

/** Catalog item names by service, the job's own service first. No prices. */
function catalogForEaser(jobService) {
  let subcategories = {};
  try {
    subcategories = getBookingCatalog()?.subcategories || {};
  } catch {
    return [];
  }
  const services = Object.entries(subcategories).map(([name, groups]) => ({
    name,
    items: (groups || []).flatMap(group => (group.items || [])
      .filter(item => !item.customQuote)
      .map(item => ({ name: item.name, group: group.group, addOn: item.addon === true }))),
  })).filter(s => s.items.length);
  const text = String(jobService || '');
  return services.sort((a, b) => Number(text.includes(b.name)) - Number(text.includes(a.name)));
}

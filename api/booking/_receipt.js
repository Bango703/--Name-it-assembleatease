// THE customer receipt (owner, 2026-11-12: "it needs to look like a real
// receipt, black and white"). One builder for both completion paths
// (api/booking/complete.js and api/booking/assembler-complete.js), which each
// carried their own green card and had already drifted apart.
//
// Truth rules:
//   - Every amount comes from the booking record and the amount actually
//     charged. Nothing is estimated.
//   - Line-item prices are shown only when they add up exactly to what was
//     charged. When they do not (approved extra work, a manual adjustment),
//     the items are listed without prices and the receipt shows the total,
//     so it never prints numbers that disagree with each other.
//   - Credits used (AssembleCash, gift card) appear as payments, the way a
//     real receipt shows a gift card, not as a mystery discount.

import { loadBookingItems } from './_booking-items.js';
import { esc } from '../_email.js';

const MONO = "'Courier New',Courier,monospace";
const BUSINESS = Object.freeze({
  name: 'ASSEMBLEATEASE',
  legal: 'AssembleAtEase LLC',
  place: 'Austin, Texas',
  web: 'assembleatease.com',
  phone: '(979) 232-5139',
});

function money(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

function chicagoDate(value, withTime = false) {
  const d = value ? new Date(value) : new Date();
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

function appointmentDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Flatten loadBookingItems groups into receipt lines. */
export function receiptLinesFromGroups(groups = []) {
  const lines = [];
  (groups || []).forEach(group => (group.items || []).forEach(item => {
    // Add-ons are their own rows (api/booking.js buildBookingItemRows); line_total
    // is unit price x quantity for every row.
    const name = item.isAddOn ? `+ ${item.name}` : item.name;
    const cents = Number(item.lineTotalCents || 0);
    lines.push({ name: String(name || '').slice(0, 80), quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1, cents: Math.max(0, Math.round(cents)) });
  }));
  return lines.filter(l => l.name);
}

/**
 * The receipt's numbers, decided once.
 * total      = what the customer paid for the job, all payments together
 * subtotal   = total - tax
 * itemized   = true only when items, fees and discounts add up to subtotal
 */
export function receiptFigures(booking = {}, lines = [], amountChargedCents = 0) {
  const card = Math.max(0, Math.round(Number(amountChargedCents) || 0));
  const assemblecash = Math.max(0, Math.round(Number(booking.assemblecash_redeemed_cents) || 0));
  const giftCard = Math.max(0, Math.round(Number(booking.gift_card_applied_cents) || 0));
  const total = card + assemblecash + giftCard;
  const tax = Math.min(total, Math.max(0, Math.round(Number(booking.tax_amount) || 0)));
  const subtotal = total - tax;
  const serviceCall = Math.max(0, Math.round(Number(booking.service_call_fee) || 0));
  const sameDay = Math.max(0, Math.round(Number(booking.same_day_fee_cents) || 0));
  const promo = Math.max(0, Math.round(Number(booking.promo_discount_cents) || 0));
  const itemsTotal = lines.reduce((sum, l) => sum + l.cents, 0);
  const itemized = lines.length > 0 && itemsTotal + serviceCall + sameDay - promo === subtotal;
  return { card, assemblecash, giftCard, total, tax, subtotal, serviceCall, sameDay, promo, itemsTotal, itemized };
}

function row(left, right, { bold = false, size = 13, pad = '2px 0' } = {}) {
  const weight = bold ? 'font-weight:700;' : '';
  return `<tr><td style="padding:${pad};font-family:${MONO};font-size:${size}px;color:#000;${weight}">${left}</td>`
    + `<td style="padding:${pad};font-family:${MONO};font-size:${size}px;color:#000;text-align:right;white-space:nowrap;${weight}">${right}</td></tr>`;
}
const RULE = `<tr><td colspan="2" style="padding:8px 0"><div style="border-top:1px dashed #000;height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>`;
const RULE_SOLID = `<tr><td colspan="2" style="padding:8px 0"><div style="border-top:2px solid #000;height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>`;

/** The receipt as an email fragment. Pure: give it the booking, lines and amount. */
export function renderReceipt({ booking = {}, lines = [], amountChargedCents = 0, chargedAt = null } = {}) {
  const f = receiptFigures(booking, lines, amountChargedCents);
  if (f.total <= 0) return '';
  const center = (text, style = '') => `<tr><td colspan="2" style="padding:1px 0;text-align:center;font-family:${MONO};font-size:12px;color:#000;${style}">${text}</td></tr>`;
  const paidBy = booking.payment_method_type === 'card' || booking.stripe_payment_intent_id ? 'Card' : 'Paid';
  let body = '';
  body += center(BUSINESS.name, 'font-size:18px;font-weight:700;letter-spacing:3px;padding-bottom:4px');
  body += center(esc(BUSINESS.legal));
  body += center(esc(BUSINESS.place));
  body += center(`${esc(BUSINESS.web)} &nbsp; ${esc(BUSINESS.phone)}`);
  body += RULE;
  body += center('RECEIPT', 'font-size:14px;font-weight:700;letter-spacing:2px;padding:2px 0 6px');
  body += row('Receipt no.', esc(booking.ref || ''));
  body += row('Paid', esc(chicagoDate(chargedAt, true)));
  if (booking.date) body += row('Service date', esc(appointmentDate(booking.date)));
  body += RULE;
  if (lines.length) {
    lines.forEach(l => {
      const label = `${esc(l.name)}${l.quantity > 1 ? ` x${l.quantity}` : ''}`;
      body += row(label, f.itemized ? money(l.cents) : '');
    });
  } else {
    body += row(esc(booking.service || 'Service'), '');
  }
  body += RULE;
  if (f.itemized) {
    body += row('Items', money(f.itemsTotal));
    if (f.serviceCall) body += row('Service call', money(f.serviceCall));
    if (f.sameDay) body += row('Same-day service', money(f.sameDay));
    if (f.promo) body += row(`Discount${booking.promo_code ? ' (' + esc(booking.promo_code) + ')' : ''}`, money(-f.promo));
  }
  body += row('Subtotal', money(f.subtotal));
  body += row('Texas sales tax', money(f.tax));
  body += RULE_SOLID;
  body += row('TOTAL', money(f.total), { bold: true, size: 17, pad: '2px 0 6px' });
  if (f.assemblecash) body += row('AssembleCash', money(f.assemblecash));
  if (f.giftCard) body += row('Gift card', money(f.giftCard));
  if (f.card) body += row(paidBy, money(f.card));
  body += row('Balance due', money(0));
  body += RULE;
  body += center('Thank you.', 'font-size:13px;padding-top:2px');
  body += center('Questions about this receipt? Reply to this email.', 'font-size:11px;padding-top:4px');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:380px;background:#ffffff;border:1px solid #000;border-collapse:separate">
      <tr><td style="padding:22px 22px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
      </td></tr>
    </table>
  </td></tr></table>`;
}

/** Load the booking's priced items and render the receipt. Never throws. */
export async function buildReceiptHtml(sb, booking, { amountChargedCents, chargedAt = null } = {}) {
  let lines = [];
  try {
    const groups = (await loadBookingItems([booking.id], { sb, includePricing: true })).get(booking.id) || [];
    lines = receiptLinesFromGroups(groups);
  } catch (error) {
    console.error('receipt items could not be loaded; listing the service only:', error?.message || error);
  }
  return renderReceipt({ booking, lines, amountChargedCents, chargedAt: chargedAt || booking.captured_at || new Date().toISOString() });
}

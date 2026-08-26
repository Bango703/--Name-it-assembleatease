import { getSupabase } from '../_supabase.js';

/**
 * THE booking line-item / add-on loader. One shape, one query, every consumer.
 *
 * Why this exists: api/booking/my-assignments.js loaded booking_items and gave
 * the EASER the full itemised scope including add-ons, while api/booking/list.js
 * never queried the table at all — so the OWNER dashboard showed no line items
 * anywhere. The owner priced a custom quote without ever seeing that the customer
 * had selected floor levelling, placement support, and safety anchoring, and
 * quoted below the real scope. The Easer then arrived expecting work the quote
 * did not cover. That is money lost and a job set up to go wrong, caused purely
 * by two roles reading different sources.
 *
 * Owner and Easer now read the SAME rows through this module. If the item list
 * changes shape it changes here, once.
 *
 * Money note: item_price / line_total are returned only when the caller asks
 * (`includePricing`). The Easer must never be shown customer pricing — Rule 3 —
 * so their path takes the default and gets scope without customer money.
 */
export async function loadBookingItems(bookingIds, { sb: injected, includePricing = false } = {}) {
  const sb = injected || getSupabase();
  const ids = (Array.isArray(bookingIds) ? bookingIds : [bookingIds]).filter(Boolean);
  if (!ids.length) return new Map();

  const columns = 'booking_id, service_category, service_name, item_name, quantity, is_add_on, add_on_name'
    + (includePricing ? ', item_price, add_on_price, line_total' : '');

  const { data, error } = await sb.from('booking_items').select(columns).in('booking_id', ids);
  if (error) throw error;

  const byBooking = new Map();
  (data || []).forEach(row => {
    const itemName = String(row.item_name || '').trim();
    if (!itemName) return;
    const category = String(row.service_category || row.service_name || 'Other').trim() || 'Other';
    const subgroup = String(row.service_name || '').trim();

    if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, new Map());
    const categoryMap = byBooking.get(row.booking_id);
    if (!categoryMap.has(category)) categoryMap.set(category, []);

    const item = {
      name: itemName,
      quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
      isAddOn: row.is_add_on === true,
      addOnName: row.add_on_name || null,
      subgroup: subgroup && subgroup !== category ? subgroup : null,
    };
    if (includePricing) {
      item.itemPriceCents = Number(row.item_price || 0);
      item.addOnPriceCents = Number(row.add_on_price || 0);
      item.lineTotalCents = Number(row.line_total || 0);
    }
    categoryMap.get(category).push(item);
  });

  const grouped = new Map();
  byBooking.forEach((categoryMap, bookingId) => {
    grouped.set(bookingId, Array.from(categoryMap.entries()).map(([label, items]) => ({ label, items })));
  });
  return grouped;
}

/** Flat count of add-ons, for the owner's "did I price all of this?" check. */
export function countAddOns(groups) {
  return (groups || []).reduce(
    (total, group) => total + group.items.filter(item => item.isAddOn).length,
    0,
  );
}

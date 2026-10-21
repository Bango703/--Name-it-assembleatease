import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { normalizeUsPhone } from '../_phone.js';
import { isLikelySpamQuote } from './_quote-spam.js';

/**
 * POST /api/booking/quote-lead
 *
 * Saves a custom quote the moment its last step opens, before it is sent.
 * Owner, 2026-10-21: 12 of 15 quote requests were abandoned at a card form, and
 * the only trace of them was a Stripe customer. A started quote is now a lead
 * in market_requests (source quote_started, status new); sending the quote marks
 * it converted (api/booking.js), so what stays "new" is exactly the people who
 * started and did not send. The owner sees them under Unbooked Requests.
 *
 * Never blocks the page: every refusal answers 200 with nothing stored, so a
 * bot learns nothing and a person is never stopped.
 */
export const QUOTE_LEAD_SOURCE = 'quote_started';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizeQuoteLead(body = {}) {
  const services = (Array.isArray(body.services) ? body.services : []).map((s) => clean(s, 120)).filter(Boolean).slice(0, 10);
  return {
    name: clean(body.name, 120),
    email: clean(body.email, 180).toLowerCase(),
    phone: normalizeUsPhone(clean(body.phone, 40)) || null,
    address: clean(body.address, 260) || null,
    city: clean(body.city, 80),
    state: clean(body.state, 2).toUpperCase() || 'TX',
    zip: clean(body.zip, 5),
    date: clean(body.date, 20) || null,
    time: clean(body.time, 60) || null,
    details: clean(body.details, 2000) || null,
    services,
    items: body.items && typeof body.items === 'object' && !Array.isArray(body.items) ? body.items : {},
  };
}

export function createQuoteLeadHandler({ getSb = getSupabase, limit = rateLimit, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const ok = () => res.status(200).json({ ok: true });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!await limit(ip, 'quote_lead')) return ok();
    const body = req.body || {};
    const lead = normalizeQuoteLead(body);
    if (!lead.name || !EMAIL_RE.test(lead.email) || !/^\d{5}$/.test(lead.zip)) return ok();
    if (isLikelySpamQuote({ company: body.company, formStartedAt: body.formStartedAt, details: lead.details, name: lead.name, now: now() })) return ok();

    try {
      const sb = getSb();
      const since = new Date(now() - 24 * 3600 * 1000).toISOString();
      const row = {
        status: 'new',
        market_type: 'active',
        source: QUOTE_LEAD_SOURCE,
        customer_name: lead.name,
        customer_email: lead.email,
        customer_phone: lead.phone,
        city: lead.city || null,
        state: lead.state,
        zip_code: lead.zip,
        address: lead.address,
        requested_service: lead.services.join(', ') || 'Custom quote',
        services: lead.services,
        requested_date: lead.date,
        desired_time: lead.time,
        details: lead.details,
        item_summary: lead.items,
        estimated_revenue: 0,
      };
      // One open lead per person per day: update it instead of adding another.
      const { data: open } = await sb.from('market_requests').select('id')
        .eq('source', QUOTE_LEAD_SOURCE).eq('status', 'new').eq('customer_email', lead.email)
        .gte('created_at', since).limit(1);
      if (open?.length) {
        await sb.from('market_requests').update(row).eq('id', open[0].id);
      } else {
        row.request_ref = 'QL-' + now().toString(36).toUpperCase();
        await sb.from('market_requests').insert(row);
      }
    } catch (error) {
      console.error('Quote lead not saved:', error?.message || error);
    }
    return ok();
  };
}

export default createQuoteLeadHandler();

/** The person sent their quote: their started-quote lead is converted. */
export async function markQuoteLeadConverted(sb, email) {
  try {
    await sb.from('market_requests').update({ status: 'converted' })
      .eq('source', QUOTE_LEAD_SOURCE).eq('status', 'new').eq('customer_email', String(email || '').trim().toLowerCase());
  } catch (error) {
    console.error('Quote lead conversion not recorded:', error?.message || error);
  }
}

import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  PARTNER_STAGES, PARTNER_KINDS, newRefCode, validateNewPartner, applyPartnerUpdate,
  countPartnerBookings, summarizePartners, projectPartner, seedRow, isMissingPartnerTable, PARTNER_UTM_SOURCE,
  validateAccountUpdate, summarizeAccountBookings, newAccountCode, commercialAccountsEnabled, ACCOUNT_MAX_DISCOUNT_PCT,
} from '../_partners.js';
import { PARTNER_SEED_LEADS } from './_partner-leads-seed.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROW_LIMIT = 2000;
const MIGRATION_MESSAGE = 'The partner list is not set up yet. Run migration 104 in Supabase, then refresh.';

async function readPartners(sb) {
  const { data, error } = await sb.from('partner_leads').select('*')
    .order('rank', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(ROW_LIMIT);
  if (error) return { error };
  return { rows: data || [] };
}

// Bookings that arrived through any partner link. Unknown is not zero: when
// this read fails, every partner's booking count is reported as unavailable.
async function readPartnerBookings(sb) {
  const { data, error } = await sb.from('bookings').select('ref,status,is_test_booking,booking_attribution')
    .ilike('booking_attribution->>utmSource', PARTNER_UTM_SOURCE).limit(5000);
  if (error) return null;
  return countPartnerBookings(data || []);
}

// Jobs booked under each partner account (bookings.commercial_partner_id).
// Unknown is not zero: a failed read reports the accounts as unavailable.
async function readAccountReports(sb, accountIds, month) {
  if (!accountIds.length) return new Map();
  const data = [];
  for (let offset = 0; ; offset += 500) {
    const page = await sb.from('bookings')
      .select('id, ref, commercial_partner_id, status, payment_status, source, payment_collected, payment_collected_at, payment_collected_by, is_test_booking, created_at, total_price, amount_charged, tax_amount, refund_amount, stripe_fee, cancellation_easer_due_cents, assembler_due, payout_amount, easer_bonus_cents, easer_reimbursement_cents, easer_fee_pct_snapshot, assemblecash_redeemed_cents, review_reward_discount_cents, gift_card_applied_cents')
      .in('commercial_partner_id', accountIds).order('id').range(offset, offset + 499);
    if (page.error) return null;
    data.push(...(page.data || []));
    if ((page.data || []).length < 500) break;
  }
  const byAccount = new Map(accountIds.map(id => [id, []]));
  (data || []).forEach(row => byAccount.get(row.commercial_partner_id)?.push(row));
  return new Map([...byAccount].map(([id, rows]) => [id, summarizeAccountBookings(rows, { month })]));
}

// Easers an account can prefer: active and approved.
async function readEaserRoster(sb) {
  const { data, error } = await sb.from('profiles').select('id, full_name, city, rating')
    .eq('role', 'assembler').eq('status', 'active').order('full_name', { ascending: true }).limit(200);
  if (error) return [];
  return (data || []).map(e => ({ id: e.id, name: e.full_name || 'Easer', city: e.city || null, rating: e.rating == null ? null : Number(e.rating) }));
}

async function insertWithFreshCodes(sb, rows, { ignoreDuplicates = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const withCodes = rows.map(r => ({ ...r, ref_code: newRefCode() }));
    const query = ignoreDuplicates
      ? sb.from('partner_leads').upsert(withCodes, { onConflict: 'place_id', ignoreDuplicates: true }).select('id')
      : sb.from('partner_leads').insert(withCodes).select('*');
    const { data, error } = await query;
    if (!error) return { data: data || [] };
    // A ref code collided. Draw new codes and try again; anything else is a real failure.
    if (error.code === '23505' && /ref_code/i.test(String(error.message || error.details || ''))) continue;
    return { error };
  }
  return { error: { message: 'Could not create unique partner codes' } };
}

export function createPartnersHandler({ supabase = getSupabase, authorize = verifyOwner, now = () => new Date(), seed = PARTNER_SEED_LEADS } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
    const sb = supabase();
    const base = { stages: PARTNER_STAGES, kinds: PARTNER_KINDS, seedAvailable: seed.length };

    if (req.method === 'GET') {
      const { rows, error } = await readPartners(sb);
      if (error) {
        if (isMissingPartnerTable(error)) return res.status(200).json({ ...base, tableMissing: true, message: MIGRATION_MESSAGE, partners: [] });
        return res.status(503).json({ error: 'The partner list could not be read. Refresh to try again.' });
      }
      const counts = await readPartnerBookings(sb);
      const partners = rows.map(r => {
        const p = projectPartner(r, counts);
        if (!counts) { p.bookings = null; p.completedJobs = null; p.bookingRefs = []; }
        return p;
      });
      const seeded = rows.filter(r => r.source === 'google_maps').length;
      const accountIds = rows.filter(r => r.account_status != null).map(r => r.id);
      const month = req.query?.month || null;
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Choose a valid report month.' });
      const reports = await readAccountReports(sb, accountIds, month);
      partners.forEach(p => { if (p.account) p.account.report = reports ? (reports.get(p.id) || null) : null; });
      return res.status(200).json({
        ...base, tableMissing: false, partners, summary: summarizePartners(rows, now()),
        bookingCountsAvailable: Boolean(counts), seedImported: seeded,
        accounts: {
          enabled: commercialAccountsEnabled(),
          columnsReady: rows.length === 0 || Object.prototype.hasOwnProperty.call(rows[0], 'account_status'),
          reportsAvailable: Boolean(reports),
          maxDiscountPct: ACCOUNT_MAX_DISCOUNT_PCT,
          easers: accountIds.length || commercialAccountsEnabled() ? await readEaserRoster(sb) : [],
        },
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (body.action === 'create') {
      const { value, error } = validateNewPartner(body);
      if (error) return res.status(400).json({ error });
      const result = await insertWithFreshCodes(sb, [{ ...value, history: [{ at: now().toISOString(), event: 'added' }] }]);
      if (result.error) {
        if (isMissingPartnerTable(result.error)) return res.status(409).json({ error: MIGRATION_MESSAGE });
        return res.status(503).json({ error: 'The partner was not saved. Try again.' });
      }
      return res.status(201).json({ partner: projectPartner(result.data[0], new Map()) });
    }

    if (body.action === 'update') {
      if (!UUID.test(String(body.id || ''))) return res.status(400).json({ error: 'Choose a partner to update.' });
      const { data: current, error: readError } = await sb.from('partner_leads').select('*').eq('id', body.id).maybeSingle();
      if (readError) return res.status(503).json({ error: 'The partner could not be read. Try again.' });
      if (!current) return res.status(404).json({ error: 'That partner no longer exists. Refresh the list.' });
      const { patch, error } = applyPartnerUpdate(current, body, now());
      if (error) return res.status(400).json({ error });
      // Only apply over the version the owner was looking at, so a second open
      // tab cannot silently overwrite a newer note.
      const { data, error: writeError } = await sb.from('partner_leads').update(patch)
        .eq('id', body.id).eq('updated_at', current.updated_at).select('*');
      if (writeError) return res.status(503).json({ error: 'The change was not saved. Try again.' });
      if (!data?.length) return res.status(409).json({ error: 'This partner changed in another window. Refresh, then make your change again.' });
      return res.status(200).json({ partner: projectPartner(data[0], new Map()), summary: null });
    }

    if (body.action === 'account' || body.action === 'account_code') {
      if (!UUID.test(String(body.id || ''))) return res.status(400).json({ error: 'Choose a partner.' });
      const { data: current, error: readError } = await sb.from('partner_leads').select('*').eq('id', body.id).maybeSingle();
      if (readError) return res.status(503).json({ error: 'The partner could not be read. Try again.' });
      if (!current) return res.status(404).json({ error: 'That partner no longer exists. Refresh the list.' });
      if (!Object.prototype.hasOwnProperty.call(current, 'account_status')) return res.status(409).json({ error: 'Run migration 129 before opening partner accounts.' });
      let patch;
      if (body.action === 'account_code') {
        if (current.account_status == null) return res.status(409).json({ error: 'Open the account first.' });
        patch = { account_code: newAccountCode(), updated_at: now().toISOString(),
          history: [...(Array.isArray(current.history) ? current.history : []), { at: now().toISOString(), event: 'account_code_replaced' }].slice(-50) };
      } else {
        const checked = validateAccountUpdate(current, body, now());
        if (checked.error) return res.status(400).json({ error: checked.error });
        patch = checked.patch;
        if (patch.account_preferred_easer_ids.length) {
          const { data: roster, error: rosterError } = await sb.from('profiles').select('id')
            .in('id', patch.account_preferred_easer_ids).eq('role', 'assembler');
          if (rosterError) return res.status(503).json({ error: 'Preferred Easers could not be verified. Try again.' });
          if (roster.length !== patch.account_preferred_easer_ids.length) return res.status(400).json({ error: 'Choose only existing Easer accounts.' });
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error: writeError } = await sb.from('partner_leads').update(patch)
          .eq('id', body.id).eq('updated_at', current.updated_at).select('*');
        if (writeError && writeError.code === '23505' && /account_code/i.test(String(writeError.message || writeError.details || ''))) {
          patch = { ...patch, account_code: newAccountCode() };
          continue;
        }
        if (writeError) return res.status(503).json({ error: 'The account was not saved. Try again.' });
        if (!data?.length) return res.status(409).json({ error: 'This partner changed in another window. Refresh, then make your change again.' });
        return res.status(200).json({ partner: projectPartner(data[0], new Map()) });
      }
      return res.status(503).json({ error: 'A unique account code could not be made. Try again.' });
    }

    if (body.action === 'import_seed') {
      const rows = seed.map(lead => seedRow(lead, 'xxxxxx')).filter(r => r.name && r.kind && r.place_id);
      if (!rows.length) return res.status(400).json({ error: 'There is no lead list to import.' });
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const result = await insertWithFreshCodes(sb, rows.slice(i, i + 200).map(({ ref_code, ...r }) => r), { ignoreDuplicates: true });
        if (result.error) {
          if (isMissingPartnerTable(result.error)) return res.status(409).json({ error: MIGRATION_MESSAGE });
          return res.status(503).json({ error: `Imported ${inserted} partners, then the import stopped. Run it again to finish; partners already imported are kept as they are.`, inserted });
        }
        inserted += result.data.length;
      }
      return res.status(200).json({ inserted, alreadyPresent: rows.length - inserted });
    }

    return res.status(400).json({ error: 'Unknown action' });
  };
}

export default createPartnersHandler();

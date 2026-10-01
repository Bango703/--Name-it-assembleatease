import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  PARTNER_STAGES, PARTNER_KINDS, newRefCode, validateNewPartner, applyPartnerUpdate,
  countPartnerBookings, summarizePartners, projectPartner, seedRow, isMissingPartnerTable, PARTNER_UTM_SOURCE,
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
      return res.status(200).json({
        ...base, tableMissing: false, partners, summary: summarizePartners(rows, now()),
        bookingCountsAvailable: Boolean(counts), seedImported: seeded,
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

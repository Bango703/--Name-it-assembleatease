// An Easer's acceptance rate: of the jobs they were asked to take in the last
// 30 days, how many they took. Every way a job reaches an Easer counts (owner,
// 2026-10-28: "all jobs must be counted regardless of how he gets it"):
//   - a dispatch offer: its dispatch_offers row is accepted, declined or expired
//   - a job the owner assigned (assignment_token) or a legacy inline dispatch
//     token: these have no dispatch_offers row, so the decision is read from
//     activity_logs — easer_accepted (with the Easer as actor) or
//     assignment_declined
// Accepts made through a dispatch offer are also logged as easer_accepted; those
// carry metadata.decision 'dispatch_offer' (or, before it was tagged, an offer
// attempt number) and are skipped there so no decision is counted twice.
//
// One module, read by the nightly tier job (which stores acceptance_rate) and
// the owner roster (which shows the counts behind it), so the two never differ
// in what they count.
import { DISPATCH_OFFER_STATUS } from './_source-of-truth.js';

export const ACCEPTANCE_WINDOW_DAYS = 30;
export const ACCEPTANCE_MIN_DECISIONS = 3;
const PAGE = 1000;

export function acceptanceWindowStart(nowMs = Date.now()) {
  return new Date(nowMs - ACCEPTANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** True when an easer_accepted log row is a decision not already in dispatch_offers. */
export function isNonOfferAcceptLog(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  if (meta.decision) return meta.decision !== 'dispatch_offer';
  return meta.attempt == null;
}

/** Pure tally: easerId -> { accepted, declined, expired, total }. */
export function tallyAcceptance({ offers = [], acceptLogs = [], declineLogs = [] } = {}) {
  const tallies = new Map();
  const bump = (easerId, key) => {
    if (!easerId) return;
    const t = tallies.get(easerId) || { accepted: 0, declined: 0, expired: 0, total: 0 };
    t[key] += 1;
    t.total += 1;
    tallies.set(easerId, t);
  };
  for (const offer of offers) {
    if (offer.offer_status === DISPATCH_OFFER_STATUS.ACCEPTED) bump(offer.easer_id, 'accepted');
    else if (offer.offer_status === DISPATCH_OFFER_STATUS.DECLINED) bump(offer.easer_id, 'declined');
    else if (offer.offer_status === DISPATCH_OFFER_STATUS.EXPIRED) bump(offer.easer_id, 'expired');
  }
  for (const row of acceptLogs) if (isNonOfferAcceptLog(row)) bump(row.actor_id, 'accepted');
  for (const row of declineLogs) bump(row.actor_id, 'declined');
  return tallies;
}

/** Percent with two decimals, or null until there are enough decisions to judge. */
export function acceptanceRateFor(tally) {
  if (!tally || tally.total < ACCEPTANCE_MIN_DECISIONS) return null;
  return parseFloat((tally.accepted / tally.total * 100).toFixed(2));
}

async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < PAGE) return { data: rows, error: null };
  }
}

/** Reads the window's decisions from both sources. Returns { tallies, error }. */
export async function loadAcceptanceTallies(sb, sinceIso = acceptanceWindowStart()) {
  const [offers, accepts, declines] = await Promise.all([
    readAll(() => sb.from('dispatch_offers')
      .select('easer_id, offer_status')
      .gte('created_at', sinceIso)
      .in('offer_status', [DISPATCH_OFFER_STATUS.ACCEPTED, DISPATCH_OFFER_STATUS.DECLINED, DISPATCH_OFFER_STATUS.EXPIRED])
      .order('id', { ascending: true })),
    readAll(() => sb.from('activity_logs')
      .select('actor_id, metadata')
      .eq('event_type', 'easer_accepted')
      .not('actor_id', 'is', null)
      .gte('created_at', sinceIso)
      .order('id', { ascending: true })),
    readAll(() => sb.from('activity_logs')
      .select('actor_id')
      .eq('event_type', 'assignment_declined')
      .not('actor_id', 'is', null)
      .gte('created_at', sinceIso)
      .order('id', { ascending: true })),
  ]);
  const error = offers.error || accepts.error || declines.error;
  if (error) return { tallies: null, error };
  return {
    tallies: tallyAcceptance({ offers: offers.data, acceptLogs: accepts.data, declineLogs: declines.data }),
    error: null,
  };
}

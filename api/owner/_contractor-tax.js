/**
 * Contractor tax (1099-NEC) totals per Easer for a calendar year. One owner for
 * the numbers the owner dashboard shows and the Stripe adjustment file exports.
 *
 * Two payout rails:
 *   manual          payout_ledger rows (record_booking_payout); the ledger stores
 *                   the reimbursed part (reimbursement_cents, migration 112).
 *   Stripe Connect  bookings with a Stripe transfer (release-payouts.js). No
 *                   ledger row is written, so these are read from the booking:
 *                   payout_amount, and easer_reimbursement_cents for its
 *                   reimbursed part.
 *
 * Referral rewards (migration 134, api/_easer-referrals.js) are contractor
 * income: a reward paid outside Stripe is added to the year's total and to
 * the Delta file (Stripe never saw it); one sent through Stripe Connect is
 * already in Stripe's own total, so it is counted here but not added again.
 *
 * Reimbursements repay a cost and are left out of every total here. Stripe's
 * own 1099 for a connected account sums its transfers, reimbursements
 * included, so stripeAdjustmentCsv() produces the Delta import that subtracts
 * them (Stripe: "Can there be negative values as deltas (for example,
 * reimbursements made to reduce the total on 1099)? Yes."). Deltas overwrite
 * rather than add, so each row carries the account's full-year amount.
 */
import { BOOKING_STATUS } from '../_source-of-truth.js';

export const NEC_THRESHOLD_CENTS = 200000; // payments made after 2025-12-31

/** The tax year to show: in January and February, the year just ended. */
export function defaultTaxYear(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() <= 1 ? year - 1 : year;
}

function yearBounds(year) {
  return {
    start: new Date(Date.UTC(year, 0, 1)).toISOString(),
    end: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
  };
}

export async function loadContractorTaxYear(sb, year = defaultTaxYear()) {
  const { start, end } = yearBounds(year);
  const empty = { year, thresholdCents: NEC_THRESHOLD_CENTS, available: false, easers: [], countNeeding1099: 0 };
  try {
    const ledgerQuery = columns => sb.from('payout_ledger').select(columns).gte('recorded_at', start).lt('recorded_at', end);
    let { data: ledger, error } = await ledgerQuery('assembler_id, assembler_name, payout_amount, reimbursement_cents, recorded_at');
    if (error && /reimbursement_cents|42703|PGRST204/i.test(String(error.message || error.code || ''))) {
      ({ data: ledger, error } = await ledgerQuery('assembler_id, assembler_name, payout_amount, recorded_at'));
    }
    if (error) {
      console.warn('Contractor tax payout_ledger unavailable:', error.message || error);
      return empty;
    }

    const transferQuery = columns => sb.from('bookings').select(columns)
      .not('stripe_transfer_id', 'is', null)
      .gte('stripe_transfer_created_at', start).lt('stripe_transfer_created_at', end);
    let { data: transfers, error: transferErr } = await transferQuery(
      'id, status, assembler_id, assembler_name, payout_amount, easer_reimbursement_cents, stripe_destination_account_id, is_test_booking');
    if (transferErr && /easer_reimbursement_cents|42703|PGRST204/i.test(String(transferErr.message || transferErr.code || ''))) {
      ({ data: transfers, error: transferErr } = await transferQuery(
        'id, status, assembler_id, assembler_name, payout_amount, stripe_destination_account_id, is_test_booking'));
    }
    if (transferErr) {
      console.warn('Contractor tax Stripe transfers unavailable:', transferErr.message || transferErr);
      return empty;
    }

    const byEaser = new Map();
    const easer = (id, name) => {
      if (!byEaser.has(id)) {
        byEaser.set(id, {
          assemblerId: id, name: name || 'Easer',
          ytdPaidCents: 0, manualPaidCents: 0, stripePaidCents: 0, ytdReimbursedCents: 0, stripeReimbursedCents: 0,
          payoutCount: 0, stripeAccountIds: [],
        });
      }
      return byEaser.get(id);
    };

    for (const row of ledger || []) {
      if (!row.assembler_id) continue;
      const e = easer(row.assembler_id, row.assembler_name);
      const reimbursed = Math.max(0, Number(row.reimbursement_cents || 0));
      const pay = Math.max(0, Number(row.payout_amount || 0) - reimbursed);
      e.manualPaidCents += pay;
      e.ytdPaidCents += pay;
      e.ytdReimbursedCents += reimbursed;
      e.payoutCount += 1;
    }
    for (const row of transfers || []) {
      if (!row.assembler_id || row.is_test_booking === true) continue;
      const e = easer(row.assembler_id, row.assembler_name);
      // A cancellation payout carries no reimbursement (no job ran).
      const reimbursed = row.status === BOOKING_STATUS.CANCELLED ? 0 : Math.max(0, Number(row.easer_reimbursement_cents || 0));
      const pay = Math.max(0, Number(row.payout_amount || 0) - reimbursed);
      e.stripePaidCents += pay;
      e.ytdPaidCents += pay;
      e.ytdReimbursedCents += reimbursed;
      e.stripeReimbursedCents += reimbursed;
      e.payoutCount += 1;
      if (row.stripe_destination_account_id && !e.stripeAccountIds.includes(row.stripe_destination_account_id)) {
        e.stripeAccountIds.push(row.stripe_destination_account_id);
      }
      e.stripeReimbursedByAccount = e.stripeReimbursedByAccount || {};
      if (row.stripe_destination_account_id && reimbursed) {
        e.stripeReimbursedByAccount[row.stripe_destination_account_id] =
          (e.stripeReimbursedByAccount[row.stripe_destination_account_id] || 0) + reimbursed;
      }
    }

    // Referral rewards paid this year, read on their own so a database
    // without migration 134 still shows every payout above.
    try {
      const { data: rewards, error: rewardErr } = await sb.from('easer_referral_rewards')
        .select('referrer_id, status, amount_cents, paid_at, paid_method')
        .gte('paid_at', start).lt('paid_at', end);
      if (!rewardErr) {
        for (const row of rewards || []) {
          if (row.status !== 'paid' || !row.referrer_id) continue;
          const e = easer(row.referrer_id, null);
          const cents = Math.max(0, Number(row.amount_cents || 0));
          e.referralPaidCents = (e.referralPaidCents || 0) + cents;
          e.ytdPaidCents += cents;
          if (row.paid_method === 'outside_stripe') {
            e.manualPaidCents += cents;
            e.referralOutsideStripeCents = (e.referralOutsideStripeCents || 0) + cents;
          } else {
            e.stripePaidCents += cents;
          }
        }
      }
    } catch { /* referral rewards unavailable: payouts above still stand */ }

    const easers = Array.from(byEaser.values())
      .map(e => ({ ...e, needs1099: e.ytdPaidCents >= NEC_THRESHOLD_CENTS }))
      .sort((a, b) => b.ytdPaidCents - a.ytdPaidCents);
    return {
      year,
      thresholdCents: NEC_THRESHOLD_CENTS,
      available: true,
      easers,
      countNeeding1099: easers.filter(e => e.needs1099).length,
      stripeAdjustmentRows: stripeAdjustmentRows(easers).length,
    };
  } catch (error) {
    console.warn('Contractor tax year load skipped:', error?.message || error);
    return empty;
  }
}

/**
 * One row per connected account whose Stripe total needs correcting: minus
 * reimbursements, plus referral rewards paid outside Stripe (put on the
 * Easer's first connected account). deltaCents is what the Delta file adds.
 */
export function stripeAdjustmentRows(easers = []) {
  const rows = [];
  for (const e of easers) {
    const byAccount = new Map();
    for (const [accountId, cents] of Object.entries(e.stripeReimbursedByAccount || {})) {
      if (cents > 0) byAccount.set(accountId, { reimbursedCents: cents, referralCents: 0 });
    }
    const outside = Number(e.referralOutsideStripeCents || 0);
    const firstAccount = (e.stripeAccountIds || [])[0];
    if (outside > 0 && firstAccount) {
      const row = byAccount.get(firstAccount) || { reimbursedCents: 0, referralCents: 0 };
      row.referralCents += outside;
      byAccount.set(firstAccount, row);
    }
    for (const [accountId, row] of byAccount) {
      const deltaCents = row.referralCents - row.reimbursedCents;
      if (deltaCents !== 0) rows.push({ stripeAccountId: accountId, name: e.name, ...row, deltaCents });
    }
  }
  return rows.sort((a, b) => a.stripeAccountId.localeCompare(b.stripeAccountId));
}

/**
 * Stripe Tax reporting > Import > 1099-NEC > Delta. Columns per Stripe's Delta
 * schema: stripe_account_id identifies the form; nonemployee_compensation_delta
 * is added to Stripe's calculated total, so a reimbursement is negative and a
 * referral reward paid outside Stripe is positive.
 */
export function stripeAdjustmentCsv(easers = []) {
  const lines = ['stripe_account_id,nonemployee_compensation_delta'];
  for (const row of stripeAdjustmentRows(easers)) {
    const sign = row.deltaCents < 0 ? '-' : '';
    lines.push(`${row.stripeAccountId},${sign}${(Math.abs(row.deltaCents) / 100).toFixed(2)}`);
  }
  return lines.join('\n') + '\n';
}

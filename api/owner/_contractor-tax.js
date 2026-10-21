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

/** One row per connected account that received reimbursements in the year. */
export function stripeAdjustmentRows(easers = []) {
  const rows = [];
  for (const e of easers) {
    for (const [accountId, cents] of Object.entries(e.stripeReimbursedByAccount || {})) {
      if (cents > 0) rows.push({ stripeAccountId: accountId, name: e.name, reimbursedCents: cents });
    }
  }
  return rows.sort((a, b) => a.stripeAccountId.localeCompare(b.stripeAccountId));
}

/**
 * Stripe Tax reporting > Import > 1099-NEC > Delta. Columns per Stripe's Delta
 * schema: stripe_account_id identifies the form; nonemployee_compensation_delta
 * is added to Stripe's calculated total, so a reimbursement is negative.
 */
export function stripeAdjustmentCsv(easers = []) {
  const lines = ['stripe_account_id,nonemployee_compensation_delta'];
  for (const row of stripeAdjustmentRows(easers)) {
    lines.push(`${row.stripeAccountId},-${(row.reimbursedCents / 100).toFixed(2)}`);
  }
  return lines.join('\n') + '\n';
}

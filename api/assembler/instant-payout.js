import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { logActivity } from '../booking/_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';

/**
 * POST /api/assembler/instant-payout — the Easer moves their own settled
 * earnings to their bank in about thirty minutes instead of waiting for the
 * standard schedule.
 *
 * WHY THIS EXISTS
 * The standard path is: capture, wait for the charge to settle, transfer, then
 * wait again for the connected account's daily payout, then wait for ACH. That
 * is most of a week for work already done. Instant Payouts bypass the last two
 * waits entirely and land any day of the week, including weekends and holidays,
 * which is exactly when a pro who worked Saturday wants paying.
 *
 * WHOSE MONEY, WHOSE CHOICE
 * This pays out the EASER'S OWN Stripe balance to the EASER'S OWN bank. The
 * platform is not fronting anything and cannot initiate it — only the Easer can,
 * for themselves, and only when they choose speed over free.
 *
 * THE FEE IS THE EASER'S, AND IT IS SHOWN BEFORE THEY AGREE
 * Stripe charges 1.5% for an instant payout. The platform adds nothing. A pro
 * must never discover a deduction after the fact, so the exact fee and the exact
 * net are quoted by `action: 'quote'` first and the amount is re-derived here
 * server-side — a posted fee is never trusted (Rule 4).
 */

const INSTANT_FEE_PCT = 1.5;        // Stripe's US rate, June 2024 onward
const INSTANT_FEE_MIN_CENTS = 50;
// Below $33.34 the $0.50 floor bites and instant stops costing 1.5% — at $1.00
// it would take HALF the payout. A pro in a hurry is exactly the person least
// likely to do that arithmetic, so the offer is withdrawn rather than dressed up:
// no instant option is shown when the fee would exceed a tenth of the money.
const MIN_PAYOUT_CENTS = 500;
const MAX_FEE_SHARE_PCT = 10;

export function instantPayoutFeeCents(amountCents) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (amount <= 0) return 0;
  return Math.max(INSTANT_FEE_MIN_CENTS, Math.round((amount * INSTANT_FEE_PCT) / 100));
}

export function quoteInstantPayout(amountCents) {
  const gross = Math.max(0, Math.round(Number(amountCents) || 0));
  const fee = instantPayoutFeeCents(gross);
  return {
    grossCents: gross,
    feeCents: fee,
    netCents: Math.max(0, gross - fee),
    feePct: INSTANT_FEE_PCT,
    eligible: gross >= MIN_PAYOUT_CENTS
      && gross > fee
      && (fee * 100) / gross <= MAX_FEE_SHARE_PCT,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);
  const { user } = authenticated;

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payouts are temporarily unavailable. Your earnings are safe — try again shortly.' });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = getSupabase();
  const action = String(req.body?.action || 'quote');

  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('id, full_name, stripe_connect_account_id, stripe_connect_payouts_enabled')
    .eq('id', user.id)
    .maybeSingle();
  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });

  const accountId = profile.stripe_connect_account_id;
  if (!accountId || profile.stripe_connect_payouts_enabled !== true) {
    return res.status(409).json({
      error: 'Finish your payout setup before using instant payout.',
      code: 'CONNECT_NOT_READY',
    });
  }

  // The balance is read from Stripe, never from our own tables. What is
  // genuinely withdrawable is Stripe's fact, and a stale mirror here would offer
  // a pro money that is not there yet.
  let available = 0;
  let instantCapable = false;
  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: accountId });
    available = (balance.available || [])
      .filter(b => b.currency === 'usd')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const externals = await stripe.accounts.listExternalAccounts(accountId, { limit: 10 });
    instantCapable = (externals.data || []).some(e =>
      Array.isArray(e.available_payout_methods) && e.available_payout_methods.includes('instant'));
  } catch (err) {
    console.error('[instant-payout] balance read failed:', err?.message || err);
    return res.status(502).json({ error: 'Could not read your Stripe balance. Your earnings are safe — try again shortly.' });
  }

  const quote = quoteInstantPayout(available);

  if (!instantCapable) {
    return res.status(200).json({
      ok: true, action: 'quote', instantAvailable: false, ...quote,
      // The server's real reason, not a generic refusal (Article 16).
      reason: 'Your bank account does not support instant payouts. Add a debit card in your payout settings to use it.',
    });
  }

  if (action === 'quote') {
    return res.status(200).json({
      ok: true,
      action: 'quote',
      instantAvailable: true,
      ...quote,
      // What they get for free if they wait instead. Never sell speed without
      // showing the free alternative beside it.
      standard: { feeCents: 0, netCents: available, note: 'Free on the standard schedule' },
    });
  }

  if (action !== 'payout') return res.status(400).json({ error: `Unknown action: ${action}` });

  if (!quote.eligible) {
    return res.status(409).json({
      error: available <= 0
        ? 'You have no settled earnings to pay out yet. Earnings become available once the customer payment clears.'
        : `Instant payout isn't worth it on $${(available / 100).toFixed(2)} — the $${(INSTANT_FEE_MIN_CENTS / 100).toFixed(2)} minimum fee would take too big a share. It's free on the standard schedule.`,
      code: 'NOT_ELIGIBLE',
      ...quote,
    });
  }

  // The Easer must confirm the exact fee they were quoted. Re-derived from the
  // live balance rather than read from the request, so a posted number can never
  // change what is charged.
  const acknowledgedFee = Math.round(Number(req.body?.acknowledgedFeeCents));
  if (!Number.isFinite(acknowledgedFee) || acknowledgedFee !== quote.feeCents) {
    return res.status(409).json({
      error: 'Your balance changed since the fee was quoted. Check the new amount and confirm again.',
      code: 'QUOTE_STALE',
      ...quote,
    });
  }

  let payout;
  try {
    payout = await stripe.payouts.create({
      amount: quote.grossCents,
      currency: 'usd',
      method: 'instant',
      metadata: { easerId: user.id, initiatedBy: 'easer_self_service' },
    }, {
      stripeAccount: accountId,
      // One payout per easer per balance per minute. A double-tap on a slow
      // phone must not withdraw twice.
      idempotencyKey: `instant-${user.id}-${quote.grossCents}-${Math.floor(Date.now() / 60000)}`,
    });
  } catch (err) {
    console.error('[instant-payout] payout failed:', err?.message || err);
    return res.status(402).json({
      // Stripe's own words: it explains declines far better than we could guess.
      error: err?.message || 'Instant payout was declined. Your earnings are safe and still available.',
      code: 'PAYOUT_FAILED',
    });
  }

  await writeFinancialAudit(sb, {
    eventType: 'easer_instant_payout',
    idempotencyKey: payout.id,
    metadata: {
      payoutId: payout.id,
      easerId: user.id,
      accountId,
      grossCents: quote.grossCents,
      feeCents: quote.feeCents,
      netCents: quote.netCents,
      arrivalDate: payout.arrival_date || null,
    },
  }).catch(err => console.error('[instant-payout] audit write failed:', err?.message || err));

  await logActivity(sb, {
    eventType: 'easer_instant_payout',
    actorType: 'easer',
    actorId: user.id,
    actorName: profile.full_name || 'Easer',
    description: `Instant payout of $${(quote.netCents / 100).toFixed(2)} requested (fee $${(quote.feeCents / 100).toFixed(2)})`,
    metadata: { payoutId: payout.id, grossCents: quote.grossCents, feeCents: quote.feeCents },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    action: 'payout',
    payoutId: payout.id,
    ...quote,
    status: payout.status,
    // Stripe's own estimate. Never promise a time the provider did not give.
    arrivalDate: payout.arrival_date || null,
    message: `$${(quote.netCents / 100).toFixed(2)} is on its way — instant payouts usually arrive within 30 minutes.`,
  });
}

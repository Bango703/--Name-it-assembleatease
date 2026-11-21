import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { EASER_BONUS_POLICY, computeBookingSplitFromSnapshot, maxEaserBonusCents } from '../_source-of-truth.js';

/**
 * POST /api/owner/easer-bonus — the owner pays an Easer more than the split.
 *
 * Body: { bookingId, amountCents, reason }
 *   amountCents 0 clears a bonus that has not been paid out yet.
 *
 * JOB BOOST (owner, 2026-11-21). Allowed on any confirmed, active or completed
 * job (EASER_BONUS_POLICY.statuses), with or without an Easer, so it can be set
 * BEFORE anyone accepts and is shown on the offer. It belongs to the job, not to
 * one Easer, and it is capped at maxEaserBonusCents so the job never loses money.
 *
 * WHERE THE MONEY COMES FROM
 * The platform. The customer has already paid by the time a bonus is decided,
 * so it can only come out of margin — nobody gets re-charged for a decision the
 * owner made afterwards. Customer-funded scope growth is the change-order path
 * and requires the customer to authorise it; this is not that.
 *
 * WHAT IT DOES NOT TOUCH
 * computeBookingSplit. That function is the canonical answer to how a job's
 * money divides and must stay a pure function of what the customer paid. The
 * bonus is an additive layer applied at payout, exactly like the same-day rush
 * bonus. Platform gross needs no adjustment: it is derived as
 * revenue - tax - processing - easerCost, so the margin absorbs the bonus on
 * its own.
 *
 * ONCE PAID, IT IS FIXED. A bonus can be changed or removed only while the
 * payout is still pending — after money has moved, editing the figure would
 * make the books disagree with the bank.
 */

const MAX_BONUS_CENTS = EASER_BONUS_POLICY.maxCents;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, amountCents, reason } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_BONUS_CENTS) {
    return res.status(400).json({
      error: `A bonus must be between $0.00 and $${(MAX_BONUS_CENTS / 100).toFixed(0)}.`,
      code: 'BONUS_OUT_OF_RANGE',
    });
  }
  const bonusReason = String(reason || '').trim().slice(0, 500);
  // Money given without a stated reason is unauditable six months later, when
  // the only question that matters is "why did we pay this?".
  if (amount > 0 && bonusReason.length < 3) {
    return res.status(400).json({ error: 'Say why this bonus is being paid.', code: 'BONUS_REASON_REQUIRED' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, service, status, assembler_id, assembler_name, assembler_accepted_at, assembler_due, payout_status, payout_amount, easer_bonus_cents, easer_bonus_reason, total_price, amount_charged, tax_amount, refund_amount, stripe_fee, easer_fee_pct_snapshot, assemblecash_redeemed_cents, review_reward_discount_cents, gift_card_applied_cents, easer_reimbursement_cents')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (!EASER_BONUS_POLICY.statuses.includes(booking.status)) {
    return res.status(409).json({
      error: 'A bonus can be set on a confirmed, active or completed job, not on one that is ' + (booking.status || 'unknown') + '.',
      code: 'NOT_ELIGIBLE',
    });
  }
  // A finished job pays someone; before then the bonus waits on the job for
  // whoever takes it.
  if (booking.status === 'completed' && !booking.assembler_id) {
    return res.status(409).json({ error: 'This job has no Easer to pay a bonus to.', code: 'NO_EASER' });
  }
  const maxCents = maxEaserBonusCents(booking);
  if (amount > maxCents) {
    return res.status(409).json({
      error: `The most this job can carry is $${(maxCents / 100).toFixed(2)}. More would lose money on it.`,
      code: 'BONUS_ABOVE_MARGIN',
      maxBonusCents: maxCents,
    });
  }
  // After the money has moved, changing the figure would make the books
  // disagree with the bank. Pay a second bonus on a future job instead.
  if (['paid', 'transferred'].includes(String(booking.payout_status || '').toLowerCase())) {
    return res.status(409).json({
      error: 'This payout has already gone out, so its bonus can no longer be changed.',
      code: 'PAYOUT_ALREADY_SENT',
    });
  }

  const previous = Number(booking.easer_bonus_cents || 0);
  const { error: updateErr } = await sb
    .from('bookings')
    .update({
      easer_bonus_cents: amount,
      easer_bonus_reason: amount > 0 ? bonusReason : null,
      easer_bonus_added_at: amount > 0 ? new Date().toISOString() : null,
    })
    .eq('id', booking.id)
    // Re-checked at write time: a payout that completed between the read above
    // and here must not have a bonus quietly attached to it.
    .not('payout_status', 'in', '("paid","transferred")');
  if (updateErr) {
    console.error('[easer-bonus] update failed:', updateErr.message);
    const columnMissing = /easer_bonus_cents/i.test(String(updateErr.message || ''));
    return res.status(columnMissing ? 503 : 500).json({
      error: columnMissing
        ? 'Bonus pay needs migration 085. Apply it and retry.'
        : 'The bonus could not be saved.',
      code: columnMissing ? 'MIGRATION_085_REQUIRED' : 'BONUS_SAVE_FAILED',
    });
  }

  // Before assignment the job has no recorded split yet; show the one it pays.
  const baseDue = Number(booking.assembler_due || 0) > 0
    ? Number(booking.assembler_due)
    : computeBookingSplitFromSnapshot({
      amountChargedCents: booking.amount_charged ?? null,
      totalPriceCents: booking.total_price ?? null,
      taxCents: booking.tax_amount || 0,
      feePct: booking.easer_fee_pct_snapshot ?? null,
      assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
      reviewRewardDiscountCents: booking.review_reward_discount_cents || 0,
      giftCardAppliedCents: booking.gift_card_applied_cents || 0,
    }).assemblerDueCents;
  const stage = booking.status === 'completed' ? 'after_job'
    : booking.assembler_accepted_at ? 'accepted' : 'before_acceptance';
  const money = c => `$${(c / 100).toFixed(2)}`;

  // Every movement of money leaves a trail, including the ones that are gifts.
  await writeFinancialAudit(sb, {
    eventType: 'easer_bonus_set',
    eventSource: 'owner_dashboard',
    bookingId: booking.id,
    status: 'processed',
    metadata: {
      ref: booking.ref,
      easerId: booking.assembler_id,
      previousBonusCents: previous,
      bonusCents: amount,
      reason: bonusReason || null,
      fundedBy: 'platform_margin',
      stage,
      maxBonusCents: maxCents,
      platformNetAfterCents: maxCents - amount + EASER_BONUS_POLICY.minPlatformNetCents,
    },
  }).catch(err => console.error('[easer-bonus] audit failed:', err?.message || err));

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'easer_bonus_set',
    actorType: 'owner',
    actorName: 'Owner',
    description: amount > 0
      ? `Owner added a ${money(amount)} bonus for ${booking.assembler_name || 'the Easer'} — ${bonusReason}`
      : `Owner removed the bonus for ${booking.assembler_name || 'the Easer'}`,
    metadata: { bonusCents: amount, previousBonusCents: previous },
  }).catch(() => {});

  // Rule 10: an Easer must always know what they will be paid. A bonus they
  // only discover in a bank statement is a missed thank-you.
  let notified = false;
  if (amount > 0 && amount !== previous && booking.assembler_id) {
    const { data: easer } = await sb
      .from('profiles').select('email, full_name').eq('id', booking.assembler_id).maybeSingle();
    if (easer?.email) {
      const first = esc((easer.full_name || booking.assembler_name || 'there').split(' ')[0]);
      const r = await sendEmail({
        to: easer.email,
        subject: `A ${money(amount)} bonus has been added to your ${booking.service || 'job'}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
          <h2 style="color:#00BFFF;margin:0 0 10px;font-size:22px">Extra pay on this one, ${first}.</h2>
          <p style="font-size:15px;color:#52525b;line-height:1.7">We have added a bonus of <strong>${esc(money(amount))}</strong> to your ${esc(booking.service || 'job')} (${esc(booking.ref)}).</p>
          <p style="font-size:15px;color:#52525b;line-height:1.7">${esc(bonusReason)}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:18px 0"><tr><td style="padding:16px 18px;font-size:14px;color:#52525b">
            Job earnings <strong style="color:#1a1a1a;float:right">${esc(money(baseDue))}</strong><br/>
            <span style="display:inline-block;margin-top:6px">Bonus <strong style="color:#00BFFF;float:right">${esc(money(amount))}</strong></span><br/>
            <span style="display:inline-block;margin-top:10px;padding-top:10px;border-top:1px solid #e4e4e7;width:100%">Total for this job <strong style="color:#1a1a1a;float:right">${esc(money(baseDue + amount))}</strong></span>
          </td></tr></table>
          <p style="font-size:14px;color:#52525b;line-height:1.7">It is included in your payout for this job — you do not need to do anything.</p>
          <p style="font-size:13px;color:#71717a;margin-top:20px">AssembleAtEase</p>
        </div>`,
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'easer_bonus_added',
          recipientType: 'easer',
          recipientUserId: booking.assembler_id,
          disableDedupe: true,
        },
      }).catch(() => ({ ok: false }));
      notified = r?.ok === true;
    }
  }

  return res.status(200).json({
    ok: true,
    bonusCents: amount,
    baseDueCents: baseDue,
    totalDueCents: baseDue + amount,
    fundedBy: 'platform_margin',
    stage,
    maxBonusCents: maxCents,
    platformNetAfterCents: maxCents - amount + EASER_BONUS_POLICY.minPlatformNetCents,
    easerNotified: notified,
    hasEaser: Boolean(booking.assembler_id),
  });
}

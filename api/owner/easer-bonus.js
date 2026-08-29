import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';

/**
 * POST /api/owner/easer-bonus — the owner pays an Easer more than the split.
 *
 * Body: { bookingId, amountCents, reason }
 *   amountCents 0 clears a bonus that has not been paid out yet.
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

const MAX_BONUS_CENTS = 50000;

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
    .select('id, ref, service, status, assembler_id, assembler_name, assembler_due, payout_status, payout_amount, easer_bonus_cents, easer_bonus_reason')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.status !== 'completed') {
    return res.status(409).json({
      error: 'A bonus can only be added to a completed job.',
      code: 'NOT_COMPLETED',
    });
  }
  if (!booking.assembler_id) {
    return res.status(409).json({ error: 'This job has no Easer to pay a bonus to.', code: 'NO_EASER' });
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

  const baseDue = Number(booking.assembler_due || 0);
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
  if (amount > 0 && amount !== previous) {
    const { data: easer } = await sb
      .from('profiles').select('email, full_name').eq('id', booking.assembler_id).maybeSingle();
    if (easer?.email) {
      const first = esc((easer.full_name || booking.assembler_name || 'there').split(' ')[0]);
      const r = await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
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
    easerNotified: notified,
  });
}

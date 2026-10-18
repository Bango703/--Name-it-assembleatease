import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';

/**
 * POST /api/owner/easer-reimbursement — the owner repays a cost the Easer paid
 * for a job (a hotel night when a job runs into a second day, for example).
 *
 * Body: { bookingId, amountCents, reason }
 *   amountCents 0 clears a reimbursement that has not been paid out yet.
 *
 * WHY IT IS NOT A BONUS
 * A bonus is pay. A reimbursement repays a cost and, with the receipt kept, is
 * not income to the Easer. Both are paid with the job and both come out of the
 * platform's margin, but they are recorded apart: the payout ledger stores the
 * reimbursed part (migration 112), the 1099 total leaves it out, and the
 * financial summary never counts it as Easer earnings.
 *
 * WHEN
 * Any time the job has an Easer and the payout has not gone out, including
 * while the job is still running — the cost is usually agreed on the day.
 * The contractor agreement requires a reimbursement to be agreed in writing in
 * advance; the reason recorded here and the email to the Easer are that record.
 *
 * ONCE PAID, IT IS FIXED. After money has moved, editing the figure would make
 * the books disagree with the bank.
 */

export const MAX_REIMBURSEMENT_CENTS = 100000;
const OPEN_STATUSES = ['confirmed', 'en_route', 'arrived', 'in_progress', 'completed'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, amountCents, reason } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_REIMBURSEMENT_CENTS) {
    return res.status(400).json({
      error: `A reimbursement must be between $0.00 and $${(MAX_REIMBURSEMENT_CENTS / 100).toFixed(0)}.`,
      code: 'REIMBURSEMENT_OUT_OF_RANGE',
    });
  }
  const note = String(reason || '').trim().slice(0, 500);
  if (amount > 0 && note.length < 3) {
    return res.status(400).json({ error: 'Say what this reimbursement is for.', code: 'REIMBURSEMENT_REASON_REQUIRED' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, service, status, assembler_id, assembler_name, payout_status, financial_operation_key, easer_reimbursement_cents, easer_reimbursement_reason')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr) {
    const columnMissing = /easer_reimbursement/i.test(String(bookingErr.message || ''));
    return res.status(columnMissing ? 503 : 500).json({
      error: columnMissing ? 'Reimbursements need migration 112. Apply it and retry.' : 'The booking could not be loaded.',
      code: columnMissing ? 'MIGRATION_112_REQUIRED' : 'BOOKING_LOAD_FAILED',
    });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (!OPEN_STATUSES.includes(booking.status)) {
    return res.status(409).json({
      error: 'A reimbursement can only be added to a job that is booked, in progress or completed.',
      code: 'JOB_NOT_OPEN',
    });
  }
  if (!booking.assembler_id) {
    return res.status(409).json({ error: 'This job has no Easer to reimburse.', code: 'NO_EASER' });
  }
  if (['paid', 'transferred'].includes(String(booking.payout_status || '').toLowerCase())) {
    return res.status(409).json({
      error: 'This payout has already gone out, so its reimbursement can no longer be changed.',
      code: 'PAYOUT_ALREADY_SENT',
    });
  }
  if (booking.financial_operation_key) {
    return res.status(409).json({
      error: 'A payout for this job is being processed. Try again in a minute.',
      code: 'PAYOUT_IN_PROGRESS',
    });
  }

  const previous = Number(booking.easer_reimbursement_cents || 0);
  const { data: written, error: updateErr } = await sb
    .from('bookings')
    .update({
      easer_reimbursement_cents: amount,
      easer_reimbursement_reason: amount > 0 ? note : null,
      easer_reimbursement_added_at: amount > 0 ? new Date().toISOString() : null,
    })
    .eq('id', booking.id)
    .eq('assembler_id', booking.assembler_id)
    // Re-checked at write time: a payout that started or finished between the
    // read above and here must not have money quietly attached to it.
    .is('financial_operation_key', null)
    // A job that has not finished has no payout status yet; NOT IN alone would
    // skip it, because NULL never compares.
    .or('payout_status.is.null,payout_status.not.in.(paid,transferred)')
    .select('id');
  if (updateErr) {
    console.error('[easer-reimbursement] update failed:', updateErr.message);
    const columnMissing = /easer_reimbursement/i.test(String(updateErr.message || ''));
    return res.status(columnMissing ? 503 : 500).json({
      error: columnMissing ? 'Reimbursements need migration 112. Apply it and retry.' : 'The reimbursement could not be saved.',
      code: columnMissing ? 'MIGRATION_112_REQUIRED' : 'REIMBURSEMENT_SAVE_FAILED',
    });
  }
  if (!written?.length) {
    return res.status(409).json({
      error: 'The payout or the Easer on this job changed while saving. Nothing was changed. Refresh and try again.',
      code: 'BOOKING_CHANGED',
    });
  }

  const money = c => `$${(c / 100).toFixed(2)}`;

  await writeFinancialAudit(sb, {
    eventType: 'easer_reimbursement_set',
    eventSource: 'owner_dashboard',
    bookingId: booking.id,
    status: 'processed',
    metadata: {
      ref: booking.ref,
      easerId: booking.assembler_id,
      previousReimbursementCents: previous,
      reimbursementCents: amount,
      reason: note || null,
      fundedBy: 'platform_margin',
      countsAsEarnings: false,
    },
  }).catch(err => console.error('[easer-reimbursement] audit failed:', err?.message || err));

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'easer_reimbursement_set',
    actorType: 'owner',
    actorName: 'Owner',
    description: amount > 0
      ? `Owner approved a ${money(amount)} reimbursement for ${booking.assembler_name || 'the Easer'}: ${note}`
      : `Owner removed the reimbursement for ${booking.assembler_name || 'the Easer'}`,
    metadata: { reimbursementCents: amount, previousReimbursementCents: previous },
  }).catch(() => {});

  // Rule 10: the Easer knows what they will be paid, and this email is the
  // written agreement the contractor agreement asks for.
  let notified = false;
  if (amount > 0 && (amount !== previous || note !== String(booking.easer_reimbursement_reason || ''))) {
    const { data: easer } = await sb
      .from('profiles').select('email, full_name').eq('id', booking.assembler_id).maybeSingle();
    if (easer?.email) {
      const first = esc((easer.full_name || booking.assembler_name || 'there').split(' ')[0]);
      const r = await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `A ${money(amount)} reimbursement has been added to job ${booking.ref}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1a1a1a">
          <h2 style="color:#00BFFF;margin:0 0 10px;font-size:22px">Reimbursement approved, ${first}.</h2>
          <p style="font-size:15px;color:#52525b;line-height:1.7">AssembleAtEase will reimburse <strong>${esc(money(amount))}</strong> for your ${esc(booking.service || 'job')} (${esc(booking.ref)}).</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:18px 0"><tr><td style="padding:16px 18px;font-size:14px;color:#52525b">
            For <strong style="color:#1a1a1a;float:right">${esc(note)}</strong><br/>
            <span style="display:inline-block;margin-top:10px;padding-top:10px;border-top:1px solid #e4e4e7;width:100%">Reimbursement <strong style="color:#1a1a1a;float:right">${esc(money(amount))}</strong></span>
          </td></tr></table>
          <p style="font-size:14px;color:#52525b;line-height:1.7">It is paid with this job's payout and is not part of your earnings. Keep the receipt.</p>
          <p style="font-size:13px;color:#71717a;margin-top:20px">AssembleAtEase</p>
        </div>`,
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'easer_reimbursement_added',
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
    reimbursementCents: amount,
    fundedBy: 'platform_margin',
    countsAsEarnings: false,
    easerNotified: notified,
  });
}

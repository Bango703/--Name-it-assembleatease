import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { validateWaitlistInput, saveWaitlistRecord, WAITLIST_SOURCE } from '../_waitlist-core.js';
import { buildWaitlistEmail, WAITLIST_EMAIL_VARIANT } from '../_waitlist-email.js';
import { isAutomaticDispatchZip } from '../_source-of-truth.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * /api/owner/waitlist
 * GET  — list all waitlist entries (optional ?status= filter)
 * POST — add someone (body.action = add), or act on an entry (invite | reject | delete)
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  // ── GET: list waitlist ──
  if (req.method === 'GET') {
    const { status } = req.query;
    let query = sb.from('assembler_waitlist')
      .select('*')
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Waitlist list error:', error);
      return res.status(500).json({ error: 'Failed to load waitlist' });
    }

    // Compute stats
    const all = data || [];
    const stats = {
      total: all.length,
      pending: all.filter(w => w.status === 'pending').length,
      invited: all.filter(w => w.status === 'invited').length,
      applied: all.filter(w => w.status === 'applied').length,
      approved: all.filter(w => w.status === 'approved').length,
      rejected: all.filter(w => w.status === 'rejected').length,
    };

    // If filtered, we need full stats, so do a separate count query
    if (status && status !== 'all') {
      const { data: allData } = await sb.from('assembler_waitlist').select('status');
      if (allData) {
        stats.total = allData.length;
        stats.pending = allData.filter(w => w.status === 'pending').length;
        stats.invited = allData.filter(w => w.status === 'invited').length;
        stats.applied = allData.filter(w => w.status === 'applied').length;
        stats.approved = allData.filter(w => w.status === 'approved').length;
        stats.rejected = allData.filter(w => w.status === 'rejected').length;
      }
    }

    // Coverage is a server verdict, never a rule the dashboard re-implements
    // (Article 4). The page renders inDispatchArea; it does not own the ZIP list.
    const entries = (data || []).map(w => ({
      ...w,
      inDispatchArea: w.zip ? isAutomaticDispatchZip(w.zip) : null,
    }));

    return res.status(200).json({ entries, stats });
  }

  // ── POST: actions ──
  if (req.method === 'POST') {
    const { action, id, notes } = req.body || {};

    // ── ADD: the owner puts someone on the list by hand ──────────────────────
    // Supply does not only arrive through a web form. The owner meets people on
    // job sites, at stores, through referrals — and before this, those names had
    // nowhere to go but a phone's notes app, which is to say they were lost.
    //
    // This runs BEFORE the id check because adding is the one action with no
    // entry to act on yet.
    if (action === 'add') {
      // Identical validation to the public form. Being the owner is authority to
      // add someone, not a licence to store a malformed record.
      const check = validateWaitlistInput(req.body);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const { name, email, phone, city, state, zip } = check.value;

      // Say plainly that they are already known rather than silently updating a
      // row and reporting success — the owner would learn nothing and might
      // overwrite a real signup with a half-remembered one.
      const { data: dupe } = await sb
        .from('assembler_waitlist')
        .select('id, name, status, source, created_at')
        .eq('email', email)
        .maybeSingle();
      if (dupe) {
        return res.status(409).json({
          error: `${dupe.name} is already on the waitlist (${dupe.status}), added ${new Date(dupe.created_at).toLocaleDateString('en-US')}.`,
          code: 'ALREADY_ON_WAITLIST',
          entry: dupe,
        });
      }

      let saved;
      try {
        saved = await saveWaitlistRecord(sb, {
          name, email, phone, city, state, zip,
          notes: notes ? String(notes).slice(0, 500) : null,
          source: WAITLIST_SOURCE.OWNER_ADDED,
        });
      } catch (err) {
        console.error('[owner/waitlist] add failed:', err?.message || err);
        return res.status(500).json({ error: 'Could not save this person to the waitlist. Nothing was added.' });
      }

      // Whether we may email them is the OWNER'S call, and it defaults to no.
      // This person did not ask us for anything — an unrequested email from a
      // company they have not contacted is a cold email, and the owner is the
      // only one who knows whether they actually said "yes, put me down".
      let confirmationSent = false;
      if (req.body.sendConfirmation === true) {
        // The SAME email a public signup gets — same header, badge, steps and
        // footer. Only the three sentences that would be false for someone who
        // never filled in a form are swapped. See api/_waitlist-email.js.
        const welcome = buildWaitlistEmail({
          name, city, state, variant: WAITLIST_EMAIL_VARIANT.OWNER_ADDED,
        });
        const r = await sendEmail({
          to: email,
          from: 'AssembleAtEase <waitlist@assembleatease.com>',
          subject: welcome.subject,
          html: welcome.html,
          replyTo: ownerEmail(),
          meta: { notificationType: 'easer_waitlist_owner_added', recipientType: 'easer' },
        }).catch(() => ({ ok: false }));
        confirmationSent = r?.ok === true;
      }

      return res.status(200).json({
        success: true,
        id: saved.id,
        status: saved.status,
        confirmationSent,
        // The one thing the owner actually wants to know about a new name: can we
        // send them work today? The server decides it — the page never guesses.
        inDispatchArea: saved.degraded ? null : (zip ? isAutomaticDispatchZip(zip) : null),
        coverageNote: saved.degraded
          ? 'Added — but the ZIP and source were not saved because migration 082 has not run yet.'
          : !zip
          ? 'No ZIP on file, so dispatch coverage is unknown.'
          : isAutomaticDispatchZip(zip)
            ? `${city}, ${state} ${zip} is inside the auto-dispatch area.`
            : `${city}, ${state} ${zip} is outside the auto-dispatch area, so jobs there need manual assignment.`,
      });
    }

    if (!id) return res.status(400).json({ error: 'Waitlist entry id is required' });

    // Look up entry
    const { data: entry, error: lookupErr } = await sb
      .from('assembler_waitlist')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (lookupErr || !entry) {
      return res.status(404).json({ error: 'Waitlist entry not found' });
    }

    // ── INVITE ──
    if (action === 'invite') {
      if (entry.status !== 'pending' && entry.status !== 'invited') {
        return res.status(400).json({ error: 'Can only invite pending or previously invited entries' });
      }

      const token = crypto.randomUUID();
      const now = new Date();
      const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const { error: updateErr } = await sb
        .from('assembler_waitlist')
        .update({
          status: 'invited',
          invite_token: token,
          invite_sent_at: now.toISOString(),
          invite_expires_at: expires.toISOString(),
          notes: notes || entry.notes,
        })
        .eq('id', id);

      if (updateErr) {
        console.error('Waitlist invite update error:', updateErr);
        return res.status(500).json({ error: 'Failed to update entry' });
      }

      // Send invite email
      const firstName = (entry.name || '').split(' ')[0] || 'there';
      const inviteUrl = SITE + '/assembler/apply?invite=' + token;

      try {
        await sendEmail({
          to: entry.email,
          // Every other waitlist email sends from waitlist@. A thread that changes
          // sender halfway through reads as a different company to the recipient.
          from: 'AssembleAtEase <waitlist@assembleatease.com>',
          subject: 'You are invited to join AssembleAtEase',
          replyTo: 'service@assembleatease.com',
          html: buildInviteEmail(firstName, inviteUrl, entry.city, entry.state),
        });
      } catch (emailErr) {
        console.error('Invite email error:', emailErr);
        return res.status(200).json({ success: true, emailSent: false, token });
      }

      return res.status(200).json({ success: true, emailSent: true, token });
    }

    // ── REJECT ──
    if (action === 'reject') {
      if (entry.status === 'approved' || entry.status === 'applied') {
        return res.status(400).json({ error: 'Cannot reject an entry that has already applied or been approved' });
      }

      const { error: updateErr } = await sb
        .from('assembler_waitlist')
        .update({
          status: 'rejected',
          notes: notes || entry.notes,
        })
        .eq('id', id);

      if (updateErr) {
        console.error('Waitlist reject update error:', updateErr);
        return res.status(500).json({ error: 'Failed to reject entry' });
      }

      return res.status(200).json({ success: true });
    }

    // ── DELETE ──
    if (action === 'delete') {
      const { error: delErr } = await sb.from('assembler_waitlist').delete().eq('id', id);
      if (delErr) {
        console.error('Waitlist delete error:', delErr);
        return res.status(500).json({ error: 'Failed to delete entry' });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action. Use: invite, reject, delete' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function buildInviteEmail(firstName, inviteUrl, city, state) {
  const market = [city, state].map(value => String(value || '').trim()).filter(Boolean).join(', ') || 'your Texas area';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Hi ${esc(firstName)},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Great news &mdash; you have been selected to apply to join the <strong>AssembleAtEase</strong> professional network near ${esc(market)}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">We reviewed your waitlist signup and we would like to invite you to complete a full application.</p>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${esc(inviteUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700">Complete Your Application &rarr;</a>
    </td></tr></table>

    <p style="margin:24px 0 0;font-size:13px;color:#71717a;text-align:center">This invitation expires in 7 days.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:24px 0 0"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens after you apply</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="width:24px;vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#00BFFF;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">1</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We review your application</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#00BFFF;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">2</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">You complete a quick identity verification</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#00BFFF;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">3</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We approve you and you start receiving jobs</td></tr>
      </table>
    </td></tr></table>

    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Reply to this email.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa">Texas Service Network &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}

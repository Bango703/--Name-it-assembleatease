import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * /api/owner/waitlist
 * GET  — list all waitlist entries (optional ?status= filter)
 * POST — action on a waitlist entry (body.action = invite | reject)
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

    return res.status(200).json({ entries: data || [], stats });
  }

  // ── POST: actions ──
  if (req.method === 'POST') {
    const { action, id, notes } = req.body;

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
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: 'You are invited to join AssembleAtEase',
          replyTo: 'service@assembleatease.com',
          html: buildInviteEmail(firstName, inviteUrl),
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

    return res.status(400).json({ error: 'Invalid action. Use: invite, reject' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function buildInviteEmail(firstName, inviteUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Hi ${esc(firstName)},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Great news &mdash; you have been selected to apply to join the <strong>AssembleAtEase</strong> handyman network in Austin, TX.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">We reviewed your waitlist signup and we would like to invite you to complete a full application.</p>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${esc(inviteUrl)}" style="display:inline-block;background:#0097a7;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700">Complete Your Application &rarr;</a>
    </td></tr></table>

    <p style="margin:24px 0 0;font-size:13px;color:#71717a;text-align:center">This invitation expires in 7 days.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:24px 0 0"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens after you apply</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="width:24px;vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">1</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We review your application</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">2</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">You complete a quick identity verification</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">3</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We approve you and you start receiving jobs</td></tr>
      </table>
    </td></tr></table>

    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Reply to this email.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa">Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}

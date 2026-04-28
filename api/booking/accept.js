import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * GET /api/booking/accept?token=xxx&action=accept|decline
 * Assembler accepts or declines an assigned booking via email link.
 * Returns an HTML response page.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token, action } = req.query;
  if (!token || !['accept', 'decline'].includes(action)) {
    return sendHtml(res, 'Invalid Link', 'This link is invalid or expired.', false);
  }

  const sb = getSupabase();

  // Find booking by assignment_token
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('*, profiles!bookings_assembler_id_fkey(id, full_name, email)')
    .eq('assignment_token', token)
    .single();

  if (bErr || !booking) {
    return sendHtml(res, 'Link Expired', 'This assignment link is no longer valid or has already been used.', false);
  }

  if (booking.assembler_accepted_at) {
    return sendHtml(res, 'Already Responded', 'You have already responded to this assignment.', false);
  }

  if (booking.status !== 'confirmed') {
    return sendHtml(res, 'Booking Unavailable', 'This booking is no longer available for assignment.', false);
  }

  const assembler = booking.profiles;
  const assemblerName = assembler?.full_name || 'Assembler';
  const assemblerFirstName = assemblerName.split(' ')[0];
  const assemblerLastInitial = assemblerName.split(' ')[1]?.[0] || '';
  const assemblerDisplay = assemblerFirstName + (assemblerLastInitial ? ' ' + assemblerLastInitial + '.' : '');

  if (action === 'accept') {
    // Accept the assignment
    const { error: updateErr } = await sb
      .from('bookings')
      .update({
        assembler_accepted_at: new Date().toISOString(),
      })
      .eq('id', booking.id);

    if (updateErr) {
      console.error('Accept booking error:', updateErr);
      return sendHtml(res, 'Error', 'Something went wrong. Please try again or contact support.', false);
    }

    // Notify owner
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: assembler?.email,
        subject: `Job Accepted — ${esc(booking.ref)} — ${esc(assemblerName)}`,
        html: buildOwnerAlertEmail({
          title: 'Job Accepted',
          color: '#0097a7',
          lines: [
            { label: 'Reference', value: booking.ref },
            { label: 'Service', value: booking.service },
            { label: 'Date', value: (booking.date || 'TBD') + (booking.time ? ' at ' + booking.time : '') },
            { label: 'Assembler', value: assemblerName },
          ],
          note: `<strong>${esc(assemblerName)}</strong> has accepted this job and is confirmed. No further action needed.`,
          noteColor: '#065f46', noteBg: '#d1fae5', noteBorder: '#bbf7d0',
        }),
      });
    } catch (e) { console.error('Accept notify error:', e); }

    // Notify customer (first name only, no phone)
    const customerFirst = (booking.customer_name || 'Customer').split(' ')[0];
    if (booking.customer_email) {
      try {
        await sendEmail({
          to: booking.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          replyTo: ownerEmail(),
          subject: `Your Assembler is Confirmed — ${esc(booking.ref)}`,
          html: buildCustomerNotifyEmail({
            customerFirst,
            assemblerFirst: assemblerDisplay,
            service: booking.service,
            date: booking.date,
            time: booking.time,
            ref: booking.ref,
          }),
        });
      } catch (e) { console.error('Customer notify error:', e); }
    }

    return sendHtml(res, 'Job Accepted!',
      `Thanks, ${esc(assemblerFirstName)}! You've accepted the assignment for <strong>${esc(booking.service)}</strong> on ${esc(booking.date || 'TBD')}. Check your assembler dashboard for details.`,
      true);

  } else {
    // Decline the assignment — unassign
    const { error: updateErr } = await sb
      .from('bookings')
      .update({
        assembler_id: null,
        assigned_at: null,
        assignment_token: null,
        assembler_accepted_at: null,
      })
      .eq('id', booking.id);

    if (updateErr) {
      console.error('Decline booking error:', updateErr);
      return sendHtml(res, 'Error', 'Something went wrong. Please try again or contact support.', false);
    }

    // Notify owner
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        replyTo: assembler?.email,
        subject: `Job Declined — ${esc(booking.ref)} — ${esc(assemblerName)}`,
        html: buildOwnerAlertEmail({
          title: 'Job Declined — Reassignment Needed',
          color: '#b45309',
          lines: [
            { label: 'Reference', value: booking.ref },
            { label: 'Service', value: booking.service },
            { label: 'Date', value: (booking.date || 'TBD') + (booking.time ? ' at ' + booking.time : '') },
            { label: 'Declined by', value: assemblerName },
          ],
          note: `<strong>${esc(assemblerName)}</strong> declined this assignment. The booking is now unassigned — please assign another assembler as soon as possible.`,
          noteColor: '#92400e', noteBg: '#fffbeb', noteBorder: '#fcd34d',
        }),
      });
    } catch (e) { console.error('Decline notify error:', e); }

    // #16 — Send assembler confirmation that they declined
    if (assembler?.email) {
      try {
        await sendEmail({
          to: assembler.email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          replyTo: ownerEmail(),
          subject: `Assignment Declined — ${esc(booking.ref)}`,
          html: buildAssemblerDeclineEmail(assemblerFirstName, booking.service, booking.date),
        });
      } catch (e) { console.error('Assembler decline email error:', e); }
    }

    return sendHtml(res, 'Job Declined',
      `You've declined this assignment. No worries — other jobs will come your way.`,
      false);
  }
}

function buildOwnerAlertEmail({ title, color, lines, note, noteColor, noteBg, noteBorder }) {
  const rows = lines.map(l => `<tr><td style="padding:7px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px;font-size:14px">${esc(l.label)}</td><td style="padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:600;color:#1a1a1a">${esc(l.value || '—')}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px 8px 0 0;border-bottom:3px solid ${color}"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">${esc(title)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">${rows}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${noteBg};border:1px solid ${noteBorder};border-radius:6px"><tr><td style="padding:14px 18px;font-size:13px;color:${noteColor};line-height:1.6">${note}</td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></td></tr></table>
</div></body></html>`;
}

function buildAssemblerDeclineEmail(firstName, service, date) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:20px">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </div>
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a;text-align:center">Assignment Declined</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;text-align:center;line-height:1.6">Hi ${esc(firstName)}, we've noted that you declined the following assignment.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:5px 0;color:#71717a;width:110px">Service</td><td style="padding:5px 0;font-weight:600">${esc(service)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Date</td><td style="padding:5px 0">${esc(date || 'TBD')}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;text-align:center;line-height:1.6">Other jobs will come your way. Questions? Email <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>
  </td></tr></table>
</div></body></html>`;
}

function sendHtml(res, title, message, isSuccess) {
  const iconColor = isSuccess ? '#16a34a' : '#dc2626';
  const icon = isSuccess ? '&#10003;' : '&#9888;';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — AssembleAtEase</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}.card{background:#fff;border-radius:12px;border:1px solid #e4e4e7;max-width:480px;width:100%;padding:2.5rem;text-align:center}.icon{font-size:3rem;color:${iconColor};margin-bottom:1rem}h1{font-size:1.5rem;margin-bottom:0.5rem;color:#1a1a1a}p{font-size:0.95rem;color:#52525b;line-height:1.6;margin-bottom:1.5rem}.btn{display:inline-block;background:#0097a7;color:#fff;padding:0.65rem 2rem;border-radius:6px;text-decoration:none;font-weight:600;font-size:0.9rem}.btn:hover{background:#00838f}</style>
</head><body><div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="/assembler/" class="btn">Go to Dashboard</a>
</div></body></html>`);
}

function buildCustomerNotifyEmail({ customerFirst, assemblerFirst, service, date, time, ref }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:20px">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </div>
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a;text-align:center">Your Assembler is Confirmed!</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;text-align:center;line-height:1.6">Hi ${esc(customerFirst)}, great news! ${esc(assemblerFirst)} has been assigned to your job and has confirmed.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        <tr><td style="padding:5px 0;color:#71717a;width:100px">Reference</td><td style="padding:5px 0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Service</td><td style="padding:5px 0">${esc(service)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Assembler</td><td style="padding:5px 0">${esc(assemblerFirst)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Date</td><td style="padding:5px 0">${esc(date || 'TBD')}${time ? ' at ' + esc(time) : ''}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0;font-size:12px;color:#a1a1aa;text-align:center">AssembleAtEase &bull; Austin, TX</p>
  </td></tr></table>
</div></body></html>`;
}

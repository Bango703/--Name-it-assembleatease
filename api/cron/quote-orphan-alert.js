import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { findQuoteOrphans } from '../_quote-orphans-core.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/quote-orphan-alert — daily at 12:00 UTC.
 *
 * WHAT THIS PREVENTS
 * Two customers saved a card to request a quote and their booking never got
 * created, so they never reached the queue. They sat for 34 and 44 days with
 * valid cards on file and NOT ONE email ever sent to them. For a business whose
 * hardest problem is getting anyone to ask for a quote at all, losing the people
 * who already did is the most expensive failure on the platform.
 *
 * Detection was not the missing piece — /api/owner/quote-orphans found them
 * correctly the whole time, and the dashboard panel lists them. But both are
 * PULL: the owner has to open the page and happen to look. That is what failed
 * for six weeks. This pushes.
 *
 * WHY IT ASKS STRIPE AND NOT US
 * The customer may have closed the tab mid-checkout, so no report of the failure
 * ever reached our server. Our database's honest answer is that nothing
 * happened. Stripe holds the card, so Stripe knows.
 *
 * ALERT ONCE, THEN REMIND WEEKLY
 * A daily repeat of the same three names becomes background noise and gets
 * filtered, which recreates the original failure with extra steps. A new orphan
 * alerts immediately; outstanding ones resurface every seven days until they are
 * gone, so nobody is quietly forgotten either.
 *
 * IT NEVER CHARGES AND NEVER WRITES TO STRIPE. A saved card is not permission to
 * bill for work nobody has scoped. It tells the owner, with the name, the email,
 * and how long the person has been waiting, and a human does the rest.
 */

const REMINDER_DAYS = 7;
const ALERTED_EVENT = 'quote_orphan_alerted';
const REMINDED_EVENT = 'quote_orphan_reminded';

function orphanRow(o) {
  const waited = o.ageDays === null
    ? 'unknown'
    : `${o.ageDays} day${o.ageDays === 1 ? '' : 's'}`;
  const urgent = (o.ageDays || 0) >= 7;
  return `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7">
      <strong>${esc(o.name || 'Name not on file')}</strong><br>
      ${o.email
        ? `<a href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Your AssembleAtEase quote request')}" style="color:#00BFFF;font-size:13px">${esc(o.email)}</a>`
        : '<span style="color:#dc2626;font-size:13px">no email on file</span>'}
    </td>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7;font-size:13px">${esc(o.sourceLabel)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7;font-size:13px;${urgent ? 'color:#b91c1c;font-weight:600' : 'color:#3f3f46'}">
      ${esc(waited)}
    </td>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7;font-size:13px">${o.cardOnFile ? 'card on file' : 'no card'}</td>
  </tr>`;
}

/** Exported so the guard can assert on real rendered output, not a paraphrase. */
export function buildAlertEmail({ outstanding, fresh }) {
  const isNew = fresh.length > 0;
  const heading = isNew
    ? `${fresh.length} quote request${fresh.length === 1 ? '' : 's'} never reached your queue`
    : `${outstanding.length} quote request${outstanding.length === 1 ? '' : 's'} still waiting for you`;

  return `<div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:2rem">
    <h2 style="color:#dc2626;margin:0 0 0.5rem">${esc(heading)}</h2>
    <p style="color:#3f3f46;line-height:1.6">
      ${isNew
        ? 'Someone saved a card to request a quote, but their booking was never created — so they never appeared in your queue and have not been contacted. Their card is valid and they are waiting to hear back.'
        : `These customers are still outstanding after ${REMINDER_DAYS} days. Nobody has contacted them yet.`}
    </p>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:14px">
      <thead>
        <tr style="text-align:left;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.04em">
          <th style="padding:6px 10px;border-bottom:2px solid #e4e4e7">Customer</th>
          <th style="padding:6px 10px;border-bottom:2px solid #e4e4e7">Wanted</th>
          <th style="padding:6px 10px;border-bottom:2px solid #e4e4e7">Waiting</th>
          <th style="padding:6px 10px;border-bottom:2px solid #e4e4e7">Card</th>
        </tr>
      </thead>
      <tbody>${outstanding.map(orphanRow).join('')}</tbody>
    </table>
    <p style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:0.75rem;color:#9a3412;font-size:14px;line-height:1.6">
      Email them and quote the job. Their card is saved, so once you agree on a
      price the quote flow can authorize it without asking them to enter it again.
      <strong>Nothing has been charged</strong> and nothing will be until you send
      a quote and they approve it.
    </p>
    <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open the dashboard</a></p>
  </div>`;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const outstanding = await findQuoteOrphans(sb, { stripe });

    if (!outstanding.length) {
      await logCron('quote-orphan-alert', { status: 'ok', records: 0, duration: Date.now() - startedAt });
      return res.status(200).json({ outstanding: 0, alerted: 0, reminded: false });
    }

    // Which of these has the owner already been told about?
    const ids = outstanding.map(o => o.setupIntentId);
    const { data: alreadyAlerted } = await sb
      .from('operational_events')
      .select('reason_detail')
      .eq('event_type', ALERTED_EVENT)
      .in('reason_detail', ids);
    const alertedIds = new Set((alreadyAlerted || []).map(r => r.reason_detail));
    const fresh = outstanding.filter(o => !alertedIds.has(o.setupIntentId));

    // Nothing new — resurface the backlog weekly rather than daily, so the alert
    // keeps its meaning instead of becoming a thing the owner filters away.
    let dueForReminder = false;
    if (!fresh.length) {
      const { data: lastReminder } = await sb
        .from('operational_events')
        .select('created_at')
        .eq('event_type', REMINDED_EVENT)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastMs = lastReminder?.created_at ? new Date(lastReminder.created_at).getTime() : 0;
      dueForReminder = (Date.now() - lastMs) >= REMINDER_DAYS * 86400000;
      if (!dueForReminder) {
        await logCron('quote-orphan-alert', { status: 'ok', records: 0, duration: Date.now() - startedAt });
        return res.status(200).json({ outstanding: outstanding.length, alerted: 0, reminded: false });
      }
    }

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: fresh.length
        ? `${fresh.length} quote request${fresh.length === 1 ? '' : 's'} never reached your queue`
        : `Still waiting: ${outstanding.length} quote request${outstanding.length === 1 ? '' : 's'} nobody has answered`,
      html: buildAlertEmail({ outstanding, fresh }),
      meta: { notificationType: 'quote_orphan_alert', recipientType: 'owner', priority: 'critical' },
    });

    // Record AFTER the send, so a failed email is retried tomorrow rather than
    // being marked handled and never mentioned again.
    if (fresh.length) {
      await sb.from('operational_events').insert(fresh.map(o => ({
        event_type: ALERTED_EVENT,
        route: '/api/cron/quote-orphan-alert',
        method: 'CRON',
        actor_role: 'cron',
        stage: 'alert',
        reason_code: 'quote_orphan_detected',
        reason_detail: o.setupIntentId,
        mutation_result: 'owner_alerted',
        payload: { email: o.email, name: o.name, source: o.source, ageDays: o.ageDays },
      })));
    }
    if (dueForReminder) {
      await sb.from('operational_events').insert({
        event_type: REMINDED_EVENT,
        route: '/api/cron/quote-orphan-alert',
        method: 'CRON',
        actor_role: 'cron',
        stage: 'reminder',
        reason_code: 'quote_orphans_still_outstanding',
        reason_detail: String(outstanding.length),
        mutation_result: 'owner_reminded',
        payload: { setupIntentIds: outstanding.map(o => o.setupIntentId) },
      });
    }

    await logCron('quote-orphan-alert', {
      status: 'ok',
      records: fresh.length || outstanding.length,
      duration: Date.now() - startedAt,
    });
    return res.status(200).json({
      outstanding: outstanding.length,
      alerted: fresh.length,
      reminded: dueForReminder,
    });
  } catch (err) {
    console.error('quote-orphan-alert failed:', err?.message || err);
    await logCron('quote-orphan-alert', { status: 'error', error: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Quote orphan alert failed' });
  }
}

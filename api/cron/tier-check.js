import { getSupabase } from '../_supabase.js';
import { logCron } from './_cron-logger.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

/**
 * GET /api/cron/tier-check — daily 07:00 UTC.
 *
 * The Easer tier program ("The Pro Path"). Full engine:
 *   1. Reset active_jobs_today (dispatch overload penalty).
 *   2. Recalculate acceptance_rate (30-day accepted / decided).
 *   3. Promote / hold / demote each active Easer against the tier gates, with a
 *      30-day grace window before any demotion, and fire the transition email.
 *
 * Tier gates (ALL must hold; acceptance_rate null = not enough data = fails):
 *   professional: 10+ jobs · 4.5★ · 80% acceptance · identity verified
 *   elite:        30+ jobs · 4.8★ · 85% acceptance · identity verified
 * Promotion jumps up to the deserved tier; demotion steps down ONE tier at a
 * time after the grace window. See business-artifacts/easer-tier-program.md.
 */

const TIER_ORDER = ['starter', 'professional', 'elite'];
const TIER_LABEL = { starter: 'Starter Pro', professional: 'Professional', elite: 'Elite Pro' };
const GRACE_DAYS = 30;
const SITE = 'https://www.assembleatease.com';
const JOBS_URL = SITE + '/assembler/my-assignments';

function tierIndex(t) { const i = TIER_ORDER.indexOf(t); return i === -1 ? 0 : i; }

// The tier an Easer currently qualifies for. acceptance_rate null (fewer than 3
// scored offers) fails the reliability bar, so a brand-new Easer stays Starter.
function deservedTier(p) {
  if (!p.identity_verified) return 'starter';
  const jobs = Number(p.completed_jobs || 0);
  const rating = Number(p.rating || 0);
  const acc = p.acceptance_rate == null ? -1 : Number(p.acceptance_rate);
  if (jobs >= 30 && rating >= 4.8 && acc >= 85) return 'elite';
  if (jobs >= 10 && rating >= 4.5 && acc >= 80) return 'professional';
  return 'starter';
}

const TIER_BENEFITS = {
  professional: [
    'Higher priority on new job offers',
    'First look at same-day (rush) jobs',
    'A <strong>Professional</strong> badge shown to customers',
    'Faster support',
  ],
  elite: [
    'Top priority — you see the best jobs first',
    'First dibs on same-day (rush) jobs',
    'A prominent <strong>Elite Pro ⭐</strong> badge customers can see',
    'Priority support + a quarterly call with the owner',
    'Eligible to be featured as Elite Pro of the month',
  ],
};

function shell(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0d1b2a">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">${inner}</div>
  <p style="font-size:12px;color:#64748b;text-align:center;margin-top:14px">You're receiving this about your AssembleAtEase Easer status.</p>
</div></body></html>`;
}

function benefitList(tier) {
  return '<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.9;color:#334155">'
    + (TIER_BENEFITS[tier] || []).map(b => `<li>${b}</li>`).join('')
    + '</ul>';
}

function tierEmail(kind, name, tier) {
  const first = esc(String(name || 'there').split(' ')[0] || 'there');
  const label = esc(TIER_LABEL[tier] || tier);
  const cta = `<p style="margin:22px 0 4px"><a href="${JOBS_URL}" style="display:inline-block;background:#00BFFF;color:#04222c;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:999px">Open your Easer app</a></p>`;

  if (kind === 'promoted') {
    return {
      subject: `You're now ${TIER_LABEL[tier]} on AssembleAtEase`,
      html: shell(`
        <div style="padding:22px 24px;border-bottom:3px solid #00BFFF">
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#00BFFF">Tier promotion</div>
          <div style="font-size:22px;font-weight:800;margin-top:6px">Congratulations, ${first} — you're now ${label}.</div>
        </div>
        <div style="padding:24px">
          <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 12px">Your work earned it. Here's what you just unlocked:</p>
          ${benefitList(tier)}
          ${cta}
        </div>`),
    };
  }
  if (kind === 'grace') {
    return {
      subject: `Keep your ${TIER_LABEL[tier]} status on AssembleAtEase`,
      html: shell(`
        <div style="padding:22px 24px;border-bottom:3px solid #f59e0b">
          <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#b45309">Heads up</div>
          <div style="font-size:20px;font-weight:800;margin-top:6px">Let's keep you at ${label}, ${first}.</div>
        </div>
        <div style="padding:24px">
          <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 10px">Your rating or acceptance rate has dipped below the ${label} bar. No change yet — you have <strong>${GRACE_DAYS} days</strong> to bring it back up and keep your status.</p>
          <p style="font-size:14px;line-height:1.6;color:#334155;margin:0">Focus on: accepting the offers you can make, arriving on time, and finishing each job clean. That's what keeps your rating and acceptance where they belong.</p>
          ${cta}
        </div>`),
    };
  }
  // demoted
  const nextUp = TIER_LABEL[TIER_ORDER[Math.min(TIER_ORDER.length - 1, tierIndex(tier) + 1)]];
  return {
    subject: `Your AssembleAtEase status is now ${TIER_LABEL[tier]}`,
    html: shell(`
      <div style="padding:22px 24px;border-bottom:3px solid #94a3b8">
        <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#475569">Status update</div>
        <div style="font-size:20px;font-weight:800;margin-top:6px">You're now ${label}, ${first}.</div>
      </div>
      <div style="padding:24px">
        <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 10px">Your status moved after the ${GRACE_DAYS}-day window. This isn't the end of the road — here's exactly how to earn <strong>${esc(nextUp)}</strong> back:</p>
        ${benefitList(TIER_ORDER[Math.min(TIER_ORDER.length - 1, tierIndex(tier) + 1)]) }
        <p style="font-size:14px;line-height:1.6;color:#334155;margin:12px 0 0">Keep your rating and acceptance above the bar and you'll move right back up.</p>
        ${cta}
      </div>`),
  };
}

async function sendTierEmail(p, kind, tier) {
  if (!p.email) return;
  try {
    const { subject, html } = tierEmail(kind, p.full_name, tier);
    await sendEmail({
      to: p.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject,
      html,
      replyTo: ownerEmail(),
      meta: { notificationType: `easer_tier_${kind}`, recipientType: 'easer', recipientUserId: p.id, disableDedupe: true },
    });
  } catch (e) {
    console.error(`[tier-check] ${kind} email failed for ${p.id}:`, e.message || e);
  }
}

export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();

  // ── Phase 0a: reset active_jobs_today (dispatch overload penalty) ─────────
  const { error: resetErr } = await sb.from('profiles').update({ active_jobs_today: 0 }).eq('role', 'assembler');
  if (resetErr) console.error('active_jobs_today reset error:', resetErr.message);

  // ── Phase 0b: recalc acceptance_rate (30-day accepted / decided) ──────────
  try {
    const thirtyDaysAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: offerStats, error: statsErr } = await sb
      .from('dispatch_offers')
      .select('easer_id, offer_status')
      .gte('created_at', thirtyDaysAgo)
      .in('offer_status', ['accepted', 'declined', 'expired']);
    if (!statsErr && offerStats?.length) {
      const rates = {};
      offerStats.forEach(o => {
        if (!rates[o.easer_id]) rates[o.easer_id] = { accepted: 0, total: 0 };
        rates[o.easer_id].total++;
        if (o.offer_status === 'accepted') rates[o.easer_id].accepted++;
      });
      await Promise.allSettled(Object.entries(rates).map(([easerId, s]) => {
        const rate = s.total >= 3 ? parseFloat((s.accepted / s.total * 100).toFixed(2)) : null;
        return sb.from('profiles').update({ acceptance_rate: rate }).eq('id', easerId);
      }));
    } else if (statsErr) {
      console.error('acceptance_rate stats query error:', statsErr.message);
    }
  } catch (arErr) {
    console.error('acceptance_rate calculation error:', arErr.message);
  }

  // ── Tier engine: promote / hold / demote each active Easer ────────────────
  const results = { promoted: 0, graceStarted: 0, demoted: 0, graceCleared: 0 };
  const { data: easers, error: loadErr } = await sb
    .from('profiles')
    .select('id, full_name, email, tier, completed_jobs, rating, acceptance_rate, identity_verified, tier_grace_started_at')
    .eq('role', 'assembler')
    .eq('status', 'active');

  if (loadErr) {
    // Fail SAFE and deploy-order-independent: if the tier columns don't exist yet
    // (migration 062 not run) or the load hiccups, do Phase 0 only and skip the
    // tier engine — never crash the daily cron, never write bad tier state.
    console.error('tier-check: tier engine skipped (Phase 0 still ran):', loadErr.message);
    await logCron('tier-check', { status: 'ok', records: 0, note: 'tier engine skipped: ' + loadErr.message });
    return res.status(200).json({ ok: true, tierEngineSkipped: true });
  }

  for (const p of easers || []) {
    const current = TIER_ORDER.includes(p.tier) ? p.tier : 'starter';
    const deserved = deservedTier(p);
    const ci = tierIndex(current);
    const di = tierIndex(deserved);

    if (di > ci) {
      // PROMOTE — jump straight up to the deserved tier. Guarded on current tier.
      const { data: rows } = await sb.from('profiles')
        .update({ tier: deserved, tier_updated_at: nowIso, tier_grace_started_at: null })
        .eq('id', p.id).eq('tier', current).select('id');
      if (rows?.length) { results.promoted++; await sendTierEmail(p, 'promoted', deserved); }
    } else if (di < ci) {
      // BELOW current tier — 30-day grace, then step down ONE tier.
      const graceStart = p.tier_grace_started_at ? new Date(p.tier_grace_started_at).getTime() : null;
      if (graceStart == null) {
        const { data: rows } = await sb.from('profiles')
          .update({ tier_grace_started_at: nowIso }).eq('id', p.id).is('tier_grace_started_at', null).select('id');
        if (rows?.length) { results.graceStarted++; await sendTierEmail(p, 'grace', current); }
      } else if (nowMs - graceStart >= GRACE_DAYS * 86400000) {
        const newTier = TIER_ORDER[ci - 1];
        const { data: rows } = await sb.from('profiles')
          .update({ tier: newTier, tier_updated_at: nowIso, tier_grace_started_at: null })
          .eq('id', p.id).eq('tier', current).select('id');
        if (rows?.length) { results.demoted++; await sendTierEmail(p, 'demoted', newTier); }
      }
    } else if (p.tier_grace_started_at) {
      // Back at/above their tier — clear any grace flag, no email.
      await sb.from('profiles').update({ tier_grace_started_at: null }).eq('id', p.id);
      results.graceCleared++;
    }
  }

  console.log('Tier-check complete:', results);
  await logCron('tier-check', { status: 'ok', records: results.promoted + results.demoted });
  return res.status(200).json({ ok: true, ...results });
}

// Reusable Easer announcement / required-action engine.
// Drives multi-channel (email + in-app banner + push) required actions to Easers
// with reminders and adoption tracking. First use case: Stripe Connect payout
// setup. Add a new required action by adding a TARGET_RULES entry + a seeded row
// in easer_announcements — no other plumbing changes.

import { isStripeConnectEnabled, refreshConnectPayoutState } from './_stripe-connect.js';
import { isSmsEnabled } from './_sms.js';

// Each rule decides, from a plain profile row, whether an Easer still NEEDS the
// action (`incomplete`) and how to bulk-select those Easers (`query`). `active`
// gates whether the rule is live at all right now (e.g. Connect must be on).
// Acknowledgment rule: the Easer is "done" when they tap "I understand", not
// when a profile field changes. The tap is stored on their delivery row
// (dismissed_at = acknowledged, completed_at = done), so there is a dated
// record that each Easer saw the policy. Used for the cancellation policy
// (2026-09-30); any policy notice can reuse it with target_rule
// 'policy_acknowledgment'.
async function acknowledgedEaserIds(sb, announcementId) {
  const { data, error } = await sb.from('easer_announcement_deliveries')
    .select('easer_id')
    .eq('announcement_id', announcementId)
    .not('dismissed_at', 'is', null);
  if (error) return { ids: null, error };
  return { ids: new Set((data || []).map((row) => row.easer_id)), error: null };
}

export const TARGET_RULES = {
  policy_acknowledgment: {
    ackRequired: true,
    active: () => true,
    incomplete(profile = {}) {
      return String(profile.status || '').toLowerCase() === 'active'
        && String(profile.application_status || '').toLowerCase() === 'approved';
    },
    async query(sb, announcement) {
      const { data, error } = await sb.from('profiles')
        .select('id, full_name, email, status, application_status')
        .eq('role', 'assembler')
        .eq('status', 'active')
        .eq('application_status', 'approved');
      if (error) return { data: null, error };
      if (!announcement?.id) return { data: data || [], error: null };
      const acked = await acknowledgedEaserIds(sb, announcement.id);
      if (acked.error) return { data: null, error: acked.error };
      return { data: (data || []).filter((p) => !acked.ids.has(p.id)), error: null };
    },
  },
  // Job texts. An Easer approved before the application form started recording
  // SMS consent has no consent row, so api/_sms.js silently suppresses every
  // offer, crew add and arrival nudge sent to them. On 2026-09-08 that was two
  // of four active Easers, and notification_log shows a real August 28 job where
  // every text to both Easers AND the customer was dropped for exactly this.
  //
  // The consent itself can only ever come from the Easer, so this asks. It never
  // blocks offers, and it deliberately does NOT target anyone who opted out:
  // sms_opted_out_at is a decision, and re-nagging someone who made it is the
  // behaviour carriers and the TCPA exist to stop.
  sms_consent_missing: {
    active: () => isSmsEnabled(),
    incomplete(profile = {}) {
      return String(profile.status || '').toLowerCase() === 'active'
        && String(profile.application_status || '').toLowerCase() === 'approved'
        && Boolean(String(profile.phone || '').trim())
        && !profile.sms_consent_at
        && !profile.sms_opted_out_at;
    },
    query(sb) {
      return sb.from('profiles')
        .select('id, full_name, email, status, application_status, phone, sms_consent_at, sms_opted_out_at')
        .eq('role', 'assembler')
        .eq('status', 'active')
        .eq('application_status', 'approved')
        .is('sms_consent_at', null)
        .is('sms_opted_out_at', null)
        .not('phone', 'is', null);
    },
  },
  payout_setup_incomplete: {
    active: () => isStripeConnectEnabled(),
    incomplete(profile = {}) {
      return String(profile.status || '').toLowerCase() === 'active'
        && String(profile.application_status || '').toLowerCase() === 'approved'
        && profile.stripe_connect_payouts_enabled !== true;
    },
    query(sb) {
      return sb.from('profiles')
        .select('id, full_name, email, status, application_status, stripe_connect_account_id, stripe_connect_payouts_enabled')
        .eq('role', 'assembler')
        .eq('status', 'active')
        .eq('application_status', 'approved')
        .not('stripe_connect_payouts_enabled', 'is', true);
    },
    // Live confirmation used by the reminder cron right before an email sends.
    // The cached `stripe_connect_payouts_enabled` flag only refreshes when the
    // Easer returns through the app or via webhook, so it can lag reality and nag
    // someone whose Stripe payouts are already enabled. This re-reads the LIVE
    // Stripe account, self-heals the cached flag, and reports whether the Easer
    // is truly still incomplete. `verified:false` means we could not check
    // (transient/misconfig) — the cron then skips rather than nag on uncertainty.
    async confirmStillIncomplete(sb, profile = {}) {
      const live = await refreshConnectPayoutState(sb, profile);
      if (live.payoutsEnabled === true) return { stillIncomplete: false, verified: true };
      if (live.payoutsEnabled === null) return { stillIncomplete: true, verified: false };
      return { stillIncomplete: true, verified: true };
    },
  },
};

// Load announcements that are active AND whose rule is currently live.
export async function loadActiveAnnouncements(sb) {
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('easer_announcements')
    .select('*')
    .eq('status', 'active')
    .lte('starts_at', nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`);
  if (error) throw error;
  return (data || []).filter((a) => {
    const rule = TARGET_RULES[a.target_rule];
    if (!rule) return false;
    return typeof rule.active === 'function' ? rule.active() : true;
  });
}

export function ruleFor(announcement) {
  return TARGET_RULES[announcement?.target_rule] || null;
}

// A delivery is complete once the Easer no longer matches the rule.
export function isDeliveryComplete(profile, announcement) {
  const rule = ruleFor(announcement);
  if (!rule) return true;
  return !rule.incomplete(profile);
}

// Whether an incomplete required action should also pull the Easer from dispatch.
// Default false — the owner's decision is: never block offers, only hold payout.
export function announcementBlocksOffers(announcement) {
  return announcement?.blocks_offers === true;
}

// For a single Easer (in-app banner / required-actions endpoint): the active
// required actions they still need to complete, safe to expose to the client.
export async function getEaserRequiredActions(sb, profile) {
  if (!profile?.id) return [];
  const announcements = await loadActiveAnnouncements(sb);
  const out = [];
  for (const a of announcements) {
    const rule = ruleFor(a);
    if (!rule || !rule.incomplete(profile)) continue;
    if (rule.ackRequired) {
      const { data: delivery, error } = await sb.from('easer_announcement_deliveries')
        .select('dismissed_at')
        .eq('announcement_id', a.id)
        .eq('easer_id', profile.id)
        .maybeSingle();
      if (error) throw error;
      if (delivery?.dismissed_at) continue;
    }
    out.push({
      ackRequired: rule.ackRequired === true,
      key: a.key,
      type: a.type,
      // Which rule this is (payout_setup_incomplete, policy_acknowledgment,
      // sms_consent_missing): the app decides what its button does from it.
      rule: a.target_rule || null,
      title: a.title,
      body: a.body,
      actionLabel: a.action_label || null,
      actionUrl: a.action_url || null,
    });
  }
  return out;
}

// The Easer taps "I understand" on an acknowledgment announcement. Idempotent;
// only for announcements whose rule requires acknowledgment.
export async function acknowledgeAnnouncement(sb, { easerId, key, nowIso = new Date().toISOString() }) {
  const { data: a, error } = await sb.from('easer_announcements')
    .select('id, key, target_rule, status').eq('key', key).maybeSingle();
  if (error) return { ok: false, status: 503, error: 'The notice could not be checked. Please retry.' };
  if (!a || a.status !== 'active' || !ruleFor(a)?.ackRequired) return { ok: false, status: 404, error: 'Notice not found.' };
  const { data: existing, error: loadError } = await sb.from('easer_announcement_deliveries')
    .select('id, dismissed_at').eq('announcement_id', a.id).eq('easer_id', easerId).maybeSingle();
  if (loadError) return { ok: false, status: 503, error: 'The notice could not be checked. Please retry.' };
  if (existing?.dismissed_at) return { ok: true, alreadyAcknowledged: true, acknowledgedAt: existing.dismissed_at };
  const patch = { dismissed_at: nowIso, completed_at: nowIso, updated_at: nowIso };
  const result = existing
    ? await sb.from('easer_announcement_deliveries').update(patch).eq('id', existing.id).select('id').single()
    : await sb.from('easer_announcement_deliveries').insert({ announcement_id: a.id, easer_id: easerId, ...patch }).select('id').single();
  if (result.error) return { ok: false, status: 503, error: 'Your confirmation could not be saved. Please retry.' };
  return { ok: true, acknowledgedAt: nowIso, announcementKey: a.key };
}

// Cadence: send when no delivery yet, or when the next reminder day has arrived.
// reminderDays e.g. [0,2,5] → send at first sight, then ~2 and ~5 days later.
export function isReminderDue(delivery, reminderDays, now = Date.now()) {
  const days = Array.isArray(reminderDays) && reminderDays.length ? reminderDays : [0, 2, 5];
  if (!delivery || !delivery.first_notified_at) return true; // never sent
  const sent = Number(delivery.reminder_count || 0);
  if (sent >= days.length) return false; // all reminders used
  const lastAt = delivery.last_reminded_at ? new Date(delivery.last_reminded_at).getTime() : 0;
  const nextGapDays = Math.max(0, days[sent] - days[sent - 1] || days[sent] || 0);
  return now - lastAt >= nextGapDays * 24 * 3600 * 1000;
}

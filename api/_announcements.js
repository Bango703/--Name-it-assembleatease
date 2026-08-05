// Reusable Easer announcement / required-action engine.
// Drives multi-channel (email + in-app banner + push) required actions to Easers
// with reminders and adoption tracking. First use case: Stripe Connect payout
// setup. Add a new required action by adding a TARGET_RULES entry + a seeded row
// in easer_announcements — no other plumbing changes.

import { isStripeConnectEnabled } from './_stripe-connect.js';

// Each rule decides, from a plain profile row, whether an Easer still NEEDS the
// action (`incomplete`) and how to bulk-select those Easers (`query`). `active`
// gates whether the rule is live at all right now (e.g. Connect must be on).
export const TARGET_RULES = {
  payout_setup_incomplete: {
    active: () => isStripeConnectEnabled(),
    incomplete(profile = {}) {
      return String(profile.status || '').toLowerCase() === 'active'
        && String(profile.application_status || '').toLowerCase() === 'approved'
        && profile.stripe_connect_payouts_enabled !== true;
    },
    query(sb) {
      return sb.from('profiles')
        .select('id, full_name, email, status, application_status, stripe_connect_payouts_enabled')
        .eq('role', 'assembler')
        .eq('status', 'active')
        .eq('application_status', 'approved')
        .not('stripe_connect_payouts_enabled', 'is', true);
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
    out.push({
      key: a.key,
      type: a.type,
      title: a.title,
      body: a.body,
      actionLabel: a.action_label || null,
      actionUrl: a.action_url || null,
    });
  }
  return out;
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

// Bulk-email send governor.
//
// Transactional email is one-at-a-time and self-limiting. BULK email is not: a
// broadcast, an announcement campaign, or any future Easer digest walks a list
// and can fire hundreds of sends in seconds. Three things go wrong when it does:
//
//   1. Resend's default account limit is 2 requests/second. An unpaced loop
//      blows straight past it and the provider answers 429. sendEmail() has no
//      retry, so a rate-limited message is recorded as `failed` and is simply
//      lost — the owner sees a failure count with no cause and no resend.
//   2. Mailbox providers read a sudden burst from a low-volume domain as spam.
//      Sender reputation is slow to earn and fast to lose.
//   3. A bad query or a loop bug can bill and blast the entire list at once,
//      and nothing today would stop it.
//
// So every bulk path goes through governedSend():
//   - paced   — a guaranteed minimum gap between sends (default ~1.8/sec),
//   - capped  — a hard maximum per run, chosen by the caller,
//   - fused   — a platform-wide 24h ceiling read from notification_log, which
//               no code path can exceed regardless of who calls it,
//   - retried — 429 and 5xx get bounded backoff instead of silent loss.
//
// The fuse is deliberately the LAST word: it counts real sends already recorded
// in the database, so two different crons in the same window cannot each spend
// the full budget. When it trips the run stops and reports; it never keeps
// sending "just a few more".

import { getSupabase } from './_supabase.js';

// Resend's documented default is 2 requests/second. Sit just under it so a
// clock skew or a slow response never pushes a burst over the line.
const DEFAULT_MIN_INTERVAL_MS = 550;

// Platform-wide 24-hour ceiling across every channel and caller. Sized for a
// launch-stage roster with room for a real campaign, not for mass mail. Raise
// deliberately via env once volume genuinely needs it — never in code.
const DEFAULT_DAILY_CEILING = 500;

// Never let a single run consume the whole day's budget by accident.
const DEFAULT_MAX_PER_RUN = 200;

// A 429 is a "slow down", not a failure. Back off and try again rather than
// dropping the message. Kept short so a cron cannot stall on a bad window.
const RETRY_BACKOFF_MS = [1200, 3000, 7000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function intFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function dailyCeiling() {
  return intFromEnv('EMAIL_DAILY_CEILING', DEFAULT_DAILY_CEILING);
}

export function minSendIntervalMs() {
  return intFromEnv('EMAIL_MIN_SEND_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS);
}

// Sends already recorded in the last 24 hours. Only attempts that actually
// reached the provider count against the fuse — a suppressed or deduped message
// never left the building, and a failed one consumed no goodwill with mailbox
// providers, so neither should shrink a legitimate campaign's budget.
export async function sendsInLast24h(sb) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await sb
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'email')
    .gte('sent_at', since)
    .in('status', ['queued', 'provider_accepted', 'sent', 'delivered', 'delivery_delayed']);
  if (error) throw new Error(`send-fuse count unavailable: ${error.message}`);
  return Number(count || 0);
}

// How much of the daily budget is left right now. Callers use this to refuse a
// too-large list UP FRONT rather than sending half of it and stopping midway.
export async function remainingDailyBudget(sb) {
  const ceiling = dailyCeiling();
  const used = await sendsInLast24h(sb || getSupabase());
  return { ceiling, used, remaining: Math.max(0, ceiling - used) };
}

function isRetryable(outcome) {
  if (!outcome) return false;
  if (outcome.status === 429) return true;
  if (Number(outcome.status) >= 500) return true;
  return /rate.?limit|too many requests|429|timeout|ECONNRESET|ETIMEDOUT/i.test(
    String(outcome.error || ''),
  );
}

/**
 * Walk `recipients`, calling `sendOne(recipient, index)` for each, under the
 * pace / per-run cap / daily fuse described above.
 *
 * `sendOne` should return `{ ok, status, error }` — `status` being the provider
 * HTTP status when known, so a 429 can be retried rather than counted as a loss.
 * A bare truthy/falsy return is accepted too and simply skips retry.
 *
 * Resolves with a full accounting of what happened, including WHY it stopped.
 * Never throws for a single bad recipient; a whole-run problem (fuse unreadable)
 * throws so the caller can refuse rather than guess.
 */
export async function governedSend(recipients, sendOne, options = {}) {
  const sb = options.sb || getSupabase();
  const list = Array.isArray(recipients) ? recipients : [];
  const maxPerRun = Math.max(1, Math.min(
    Number(options.maxPerRun) || DEFAULT_MAX_PER_RUN,
    DEFAULT_MAX_PER_RUN,
  ));
  const intervalMs = minSendIntervalMs();
  const label = String(options.label || 'bulk');

  const budget = await remainingDailyBudget(sb);
  const allowed = Math.min(list.length, maxPerRun, budget.remaining);

  const result = {
    label,
    requested: list.length,
    attempted: 0,
    sent: 0,
    failed: 0,
    retried: 0,
    skipped: Math.max(0, list.length - allowed),
    stoppedBy: null,
    ceiling: budget.ceiling,
    usedBeforeRun: budget.used,
  };

  if (allowed <= 0) {
    result.stoppedBy = budget.remaining <= 0 ? 'daily_ceiling' : 'empty_list';
    return result;
  }
  if (allowed < list.length) {
    result.stoppedBy = budget.remaining < Math.min(list.length, maxPerRun)
      ? 'daily_ceiling'
      : 'per_run_cap';
  }

  let lastStartedAt = 0;
  for (let i = 0; i < allowed; i++) {
    // Pace from the START of the previous send, so a slow provider response
    // already counts toward the gap instead of adding to it.
    const waitMs = intervalMs - (Date.now() - lastStartedAt);
    if (lastStartedAt && waitMs > 0) await sleep(waitMs);
    lastStartedAt = Date.now();

    result.attempted++;
    let outcome = null;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        const raw = await sendOne(list[i], i);
        outcome = (raw && typeof raw === 'object') ? raw : { ok: !!raw };
      } catch (err) {
        outcome = { ok: false, error: err?.message || String(err) };
      }
      if (outcome.ok || !isRetryable(outcome) || attempt === RETRY_BACKOFF_MS.length) break;
      result.retried++;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
    if (outcome?.ok) result.sent++;
    else result.failed++;
  }

  return result;
}

// Human-readable one-liner for the owner UI and cron logs. The owner should
// never have to infer from a raw count that a send was cut short.
export function describeGovernedRun(r) {
  if (!r) return '';
  const base = `${r.sent} sent, ${r.failed} failed`;
  if (r.stoppedBy === 'daily_ceiling') {
    return `${base}. ${r.skipped} not sent — the platform 24-hour email ceiling (${r.ceiling}) was reached. They were NOT dropped silently; re-run after the window clears or raise EMAIL_DAILY_CEILING deliberately.`;
  }
  if (r.stoppedBy === 'per_run_cap') {
    return `${base}. ${r.skipped} not sent — per-run cap reached. Re-run to continue.`;
  }
  return base;
}

import { getSupabase } from '../_supabase.js';
import { verifyOwner, ownerEmail } from '../_email.js';

/**
 * GET /api/owner/test-cases — which active cases look like they came from
 * testing, and the reason each one is suspected.
 *
 * READ ONLY. It closes nothing. The owner ticks what to close and the close
 * goes through api/owner/case-action.js, which already has the compare-and-set,
 * the confirmation, the damage guard and the audit trail. One transition path,
 * not two.
 *
 * WHY DETECTION AND NOT A FLAG
 * Cases attached to a booking already inherit is_test_booking and disappear
 * with it (visibleOperationCases). The ones that cannot are the cases with no
 * booking at all — a support request, a voice callback, a contact form fired
 * during testing. There is nothing for them to inherit from, so they sit in the
 * owner's queue forever. Rather than add a second test flag and a migration for
 * it, this names the signals and lets the owner decide.
 *
 * EVERY SUSPECT IS SHOWN WITH ITS REASON AND NOTHING IS PRE-JUDGED SERVER SIDE.
 * A case is suspected, never concluded: "matched: subject contains 'test'" is a
 * prompt for a human, not a verdict. Closing a real customer's case because a
 * regex liked it is a worse outcome than leaving noise on the board.
 */

const ACTIVE_STATUSES = new Set(['open', 'acknowledged', 'in_progress', 'waiting_customer', 'waiting_easer']);

// Deliberately narrow. Each one is a phrase a real customer is unlikely to
// produce, and each is reported by name so the owner can judge it.
const TEXT_SIGNALS = [
  [/\btest(ing|s)?\b/i, "text says 'test'"],
  [/\bphase\s*\d/i, "text says 'phase N'"],
  [/post[-\s]?deploy/i, "text says 'post-deploy'"],
  [/\bseed(ed|ing)?\b/i, "text says 'seed'"],
  [/\bdry[-\s]?run\b/i, "text says 'dry run'"],
  [/\bsmoke\b/i, "text says 'smoke'"],
  [/\bqa\b/i, "text says 'QA'"],
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { data: cases, error } = await sb
    .from('operation_cases')
    .select('id, case_ref, case_type, status, severity, subject, description, booking_id, customer_name, customer_email, created_by_name, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('test-cases load error:', error);
    return res.status(503).json({ error: 'Cases could not be read.' });
  }

  const active = (cases || []).filter(row => ACTIVE_STATUSES.has(row.status));
  const bookingIds = [...new Set(active.map(row => row.booking_id).filter(Boolean))];

  let bookingMap = new Map();
  if (bookingIds.length) {
    const { data: bookings } = await sb
      .from('bookings')
      .select('id, ref, customer_email, is_test_booking')
      .in('id', bookingIds);
    bookingMap = new Map((bookings || []).map(b => [b.id, b]));
  }

  const owner = String(ownerEmail() || '').trim().toLowerCase();

  const suspects = [];
  for (const row of active) {
    const signals = [];
    const booking = row.booking_id ? bookingMap.get(row.booking_id) : null;
    const caseEmail = String(row.customer_email || '').trim().toLowerCase();
    const bookingEmail = String(booking?.customer_email || '').trim().toLowerCase();
    const haystack = `${row.subject || ''} ${row.description || ''}`;

    if (booking?.is_test_booking === true) signals.push('its booking is marked as a test');
    if (owner && caseEmail === owner) signals.push("raised against the owner's own email");
    if (owner && bookingEmail === owner) signals.push("its booking is the owner's own email");
    if (/^SIM-/i.test(String(row.customer_name || ''))) signals.push('customer name starts with SIM-');
    for (const [pattern, why] of TEXT_SIGNALS) {
      if (pattern.test(haystack)) { signals.push(why); break; }
    }

    if (!signals.length) continue;
    suspects.push({
      id: row.id,
      ref: row.case_ref,
      type: row.case_type,
      status: row.status,
      severity: row.severity,
      subject: row.subject,
      createdAt: row.created_at,
      bookingRef: booking?.ref || null,
      // Cases on a flagged booking are already hidden from the board; closing
      // them is optional tidying, so they are marked as the weaker case.
      alreadyHidden: booking?.is_test_booking === true,
      signals,
    });
  }

  return res.status(200).json({
    ok: true,
    activeCount: active.length,
    suspects,
    // Said plainly, because the owner is about to close things in bulk.
    caveat: 'These are suspected from wording and ownership, not confirmed. Read each subject before closing it.',
  });
}

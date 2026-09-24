/**
 * The words a customer may never be shown, and what to say instead.
 *
 * WHY THIS EXISTS
 * Panel seat 13 owns the single colour token, so a rogue hex fails the build.
 * Nothing owned the words, so a rogue word shipped freely. Article 16 asks
 * whether a sentence is TRUE; it never asked whether the reader understands it.
 * "Your card is authorized, not charged. Payment is captured only after
 * completed work" is entirely true and written in processor vocabulary the
 * customer never opted into. So was "Upload failed (server said 502)".
 *
 * This is the map panel seat 15 (Content Design & Voice) enforces. It covers
 * customer-addressed email, SMS and push, and the visible copy on the customer
 * pages. Owner surfaces are exempt on purpose: the owner dashboard is an
 * operator console and needs the real terms. Easer surfaces sit in between —
 * operational detail they act on is fine, platform internals are not.
 *
 * Add a term when one leaks. Never weaken a term to make a build pass; reword
 * the copy, which was the point.
 */

/**
 * Each entry: what not to say, and the plain replacement.
 * `pattern` must be anchored on word boundaries so ordinary English survives
 * ("avoid" must not trip "void", "recapture the deposit" must still be caught).
 */
export const CUSTOMER_FORBIDDEN_TERMS = Object.freeze([
  // ── Payment-processor mechanics ──────────────────────────────────────────
  { pattern: /\bauthoriz(?:e|ed|es|ation|ing)\b/i, say: 'a hold, or "we place a hold"' },
  { pattern: /\bcaptur(?:e|ed|es|ing)\b/i, say: 'charged' },
  { pattern: /\bvoid(?:ed|ing)?\b/i, say: 'cancelled, or "the hold is released"' },
  { pattern: /\bpayment[_ ]intent\b|\bPaymentIntent\b/i, say: 'the payment' },
  { pattern: /\bstripe connect\b|\bconnect (?:account|transfer)\b/i, say: 'nothing — this is internal' },
  { pattern: /\bchargeback\b/i, say: 'a dispute with your bank' },
  { pattern: /\bidempoten\w+/i, say: 'nothing — this is internal' },

  // ── Money that is not the customer's ─────────────────────────────────────
  { pattern: /\bpayout\b/i, say: 'nothing — a customer is never paid out' },
  { pattern: /\bledger\b/i, say: 'nothing — this is internal' },
  { pattern: /\breconcil\w+/i, say: 'checked, or reviewed' },

  // ── Workflow states and column names ─────────────────────────────────────
  { pattern: /\bin_progress\b/i, say: 'under way' },
  { pattern: /\ben_route\b/i, say: 'on the way' },
  { pattern: /\bneeds_manual\w*|\bdispatch_\w+|\bfinancial_operation\w*|\bpayout_status\b|\bassembler_id\b/i,
    say: 'nothing — this is a database column' },
  { pattern: /\bdispatch(?:ed|ing)?\b/i, say: 'assigned, or "we found someone"' },
  { pattern: /\bassembler\b/i, say: 'Easer, or "your pro"' },

  // ── Plumbing and debugging ───────────────────────────────────────────────
  { pattern: /\bwebhook\b|\bcron\b|\bendpoint\b|\bpayload\b/i, say: 'nothing — this is internal' },
  { pattern: /\bHTTP\b|\bstatus code\b/i, say: 'nothing — say what to do instead' },
  { pattern: /\b(?:4\d{2}|5\d{2}) error\b|\berror (?:4\d{2}|5\d{2})\b/i, say: 'nothing — say what to do instead' },
  { pattern: /\b(?:null|undefined|NaN)\b/, say: 'nothing — render a real value or hide the line' },
  { pattern: /\bstack trace\b|\bexception\b/i, say: 'nothing — say what to do instead' },
]);

/**
 * Strip everything a customer does not read: template interpolations (those are
 * values, not words we wrote), HTML tags and their attributes, URLs, and inline
 * style blocks. What is left is the sentence in front of the person.
 */
export function visibleCustomerText(source) {
  return String(source || '')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/** Every forbidden term present in text a customer actually reads. */
export function findCustomerLanguageViolations(source) {
  const text = visibleCustomerText(source);
  const found = [];
  for (const rule of CUSTOMER_FORBIDDEN_TERMS) {
    const match = text.match(rule.pattern);
    if (match) found.push({ term: match[0], say: rule.say });
  }
  return found;
}

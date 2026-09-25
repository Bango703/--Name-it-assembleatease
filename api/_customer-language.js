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
 * Copy must not argue with the reader.
 *
 * A message to a customer or an Easer says what happened and what to do. It
 * does not explain why the rule exists. "Every payout waits 24 hours after the
 * job closes. That window is there so a refund, a damage report or a card
 * dispute is settled before money moves, and it applies to every job" became
 * one table row and one sentence, and lost nothing. Justifying a rule makes it
 * sound negotiable or apologetic, and the reader who wants the reasoning asks.
 *
 * Scope is notification copy and product screens. Contracts are exempt: the
 * contractor agreement and the terms need their conditional clauses.
 */
export const JUSTIFYING_PHRASES = Object.freeze([
  /\bso that\b/i,
  /\bbecause\b/i,
  /\bthe reason\b/i,
  /\bin order to\b/i,
  /\bthat is why\b/i,
  /\bthis ensures\b/i,
  /\bto ensure\b/i,
  /\bis there so\b/i,
  /\bthat way\b/i,
  /\bwhich allows\b/i,
  /\bthis helps\b/i,
  /\bwe do this\b/i,
  /\bplease note\b/i,
  /\bkindly note\b/i,
]);

/** Sentences in `source` that explain themselves instead of just saying the thing. */
export function findJustifyingCopy(source) {
  const found = [];
  for (const sentence of visibleCustomerText(source).split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/).length;
    if (words < 5 || words > 60) continue;
    const hit = JUSTIFYING_PHRASES.find(p => p.test(sentence));
    if (hit) found.push({ phrase: sentence.match(hit)[0], sentence: sentence.trim() });
  }
  return found;
}

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

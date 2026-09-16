// ─── Relay contact guard ─────────────────────────────────────────────────────
//
// The pre-appointment contact window holds back the customer's phone and email.
// The Easer→customer relay exists so nobody is stranded without a channel — but
// an unchecked relay hands the gate straight back: "call me at 512-555-0134"
// achieves in one message exactly what withholding the number prevented.
//
// So the relay carries operational questions, never a private channel out of
// the platform. This is the same rule the contractor agreement already states
// in Section 11 and clause 734; this module is the part that actually enforces
// it at the moment of sending, rather than after the money is gone.
//
// Deliberately NOT applied to Easer→owner support messages: a pro giving the
// owner their own phone number is normal and necessary.

const PATTERNS = Object.freeze([
  // Payment handles — the unambiguous tell of an off-platform deal.
  { code: 'payment_handle', re: /\b(venmo|zelle|cash\s?app|cashapp|paypal|apple\s?pay|western\s?union)\b/i,
    label: 'a payment app' },
  { code: 'cashtag', re: /\$[A-Za-z][A-Za-z0-9_]{2,}/, label: 'a payment handle' },

  // Email addresses, plus the two ways people spell around a filter:
  // "joe (at) gmail dot com".
  { code: 'email', re: /[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[A-Za-z0-9.-]+\s*(?:\.|\(dot\))\s*[A-Za-z]{2,}/i,
    label: 'an email address' },
  { code: 'email_obfuscated_at', re: /[([]\s*at\s*[)\]]/i, label: 'an email address' },
  { code: 'email_obfuscated_dot', re: /\bdot\s+(?:com|net|org|edu|gov|io|co|me)\b/i, label: 'an email address' },

  // Phone numbers, including the usual spacing/punctuation dodges. Requires the
  // full 3-3-4 shape so a ZIP, a house number, or "10:30" never trips it.
  { code: 'phone', re: /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]{0,3}\d{3}[\s.\-]{0,3}\d{4}(?!\d)/, label: 'a phone number' },

  // Long digit runs that dodge the shape above (e.g. "5125550134").
  { code: 'digit_run', re: /\d[\d\s.\-]{9,}/, label: 'a phone number' },

  // Off-platform handles and solicitation shorthand.
  { code: 'handle', re: /(?:^|\s)@[A-Za-z0-9_]{3,}/, label: 'an off-platform handle' },
  { code: 'off_platform', re: /\b(?:text|call|reach|contact|hit)\s+me\s+(?:at|on|direct(?:ly)?)\b/i,
    label: 'a request to move off the platform' },
  { code: 'cash_deal', re: /\b(?:pay(?:\s+me)?|deal|price)\s+(?:in\s+)?cash\b|\bcash\s+(?:deal|price|only)\b/i,
    label: 'an off-platform cash arrangement' },
]);

/**
 * Inspect an Easer→customer relay message.
 * @returns {{ok:true}|{ok:false, code:string, error:string}}
 */
export function inspectRelayMessage(text) {
  const value = String(text || '');
  for (const { code, re, label } of PATTERNS) {
    if (re.test(value)) {
      return {
        ok: false,
        code,
        // Article 16: name the actual reason. A generic "message blocked" leaves
        // the pro guessing and looks like a bug rather than a policy.
        error: `This message looks like it contains ${label}. Messages to the customer go through AssembleAtEase, so direct contact details and payment arrangements can't be included. Remove it and send again — for anything else, use "Report an issue" to reach the AssembleAtEase team.`,
      };
    }
  }
  return { ok: true };
}

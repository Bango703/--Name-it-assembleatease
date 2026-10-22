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

  // A number spelled out ("five one two five five five 0134"): seven or more
  // digits in a row, as words or mixed with figures.
  { code: 'phone_words', re: /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d+)(?:[\s,.\-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d+)\b){6,}/i,
    label: 'a phone number' },

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
        error: `This message contains ${label} and was not sent. Contact details and payment arrangements can't be shared with customers. AssembleAtEase has been notified. To reach the AssembleAtEase team, use "Report an issue".`,
        label,
      };
    }
  }
  return { ok: true };
}

// ─── Application screening ───────────────────────────────────────────────────
//
// Owner, 2026-10-22, after the application from "innocent Joshua": he answered
// "no" to running a competing business, and his About text was an advert for
// his own TV-mounting company ("Call or message Pro TV Mount today for a free
// estimate"). The disclosure flag was driven by the checkbox alone, so nothing
// noticed. The owner's rule: nobody joins AssembleAtEase to take its customers,
// no exceptions.
//
// This never rejects anyone by itself. It names what it found, the owner's
// email and dashboard show it, and approval is refused until the owner
// confirms the review (api/assembler/update.js).
const APPLICATION_PATTERNS = Object.freeze([
  ...PATTERNS.filter(({ code }) => !['cash_deal'].includes(code)),
  { code: 'website', re: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|co|biz|us|io)\b/i, label: 'a website' },
  { code: 'business_ad', re: /\b(?:call|text|message|contact)\s+(?:or\s+(?:call|text|message)\s+)?(?:us|me|[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\s+(?:today|now|for)\b/,
    label: 'an advert asking customers to contact a business' },
  { code: 'free_estimate', re: /\bfree\s+(?:estimates?|quotes?|consultations?)\b/i, label: 'an offer of free estimates' },
  { code: 'business_offer', re: /\b(?:what\s+we\s+offer|we\s+(?:offer|provide|specialize)|our\s+(?:company|business|services|team))\b/i,
    label: 'a description of the applicant\'s own business' },
  { code: 'business_entity', re: /\b(?:llc|l\.l\.c\.|inc\.?|incorporated|ltd\.?)\b/i, label: 'a company name' },
]);

/**
 * Screen an Easer application's free text (About, competing-business details).
 * @returns {{flagged:boolean, findings:Array<{code:string,label:string}>}}
 */
export function inspectApplicationText(text) {
  const value = String(text || '')
    // The application form writes its own disclosure line into this field.
    .replace(/^No competing home-services business disclosed\.\s*/i, '');
  const findings = [];
  const seen = new Set();
  for (const { code, re, label } of APPLICATION_PATTERNS) {
    if (re.test(value) && !seen.has(label)) {
      seen.add(label);
      findings.push({ code, label });
    }
  }
  return { flagged: findings.length > 0, findings };
}

/** One line for the owner: "a website, an offer of free estimates". */
export function describeApplicationFindings(findings = []) {
  return findings.map((f) => f.label).join(', ');
}

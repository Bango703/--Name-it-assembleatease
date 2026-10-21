// Spam signals for custom quotes, which no longer require a card (owner,
// 2026-10-21). One rule for the lead capture and the quote submission.
// Each check only fires on positive evidence; a missing signal never blocks a
// real customer.

export const MIN_HUMAN_FILL_MS = 8000;
const LINK_PATTERN = 'https?:\\/\\/|www\\.|\\[url|<a\\s';
const LINK_RE = new RegExp(LINK_PATTERN, 'i');

export function isLikelySpamQuote({ company, formStartedAt, details, name, now = Date.now() } = {}) {
  // A hidden decoy field only bots fill in.
  if (String(company || '').trim()) return true;
  // Nobody picks a service, enters an address and contact details this fast.
  const started = Number(formStartedAt);
  if (Number.isFinite(started) && started > 0 && now - started < MIN_HUMAN_FILL_MS) return true;
  // Link spam in the project notes or the name.
  if ((String(details || '').match(new RegExp(LINK_PATTERN, 'gi')) || []).length >= 2) return true;
  if (LINK_RE.test(String(name || ''))) return true;
  return false;
}

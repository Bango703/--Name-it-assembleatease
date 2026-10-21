// What a social post may not say. Checked at the one place every post passes
// through (publishContentKit), whoever wrote it: the AI content kit, a campaign
// template, a review share, or the owner.
//
// Owner, 2026-10-21, after reading a month of Facebook posts: the AI wrote "We've
// assembled hundreds of these IKEA units", "security systems ... faulty wiring",
// "weatherproof wiring, proper power setup", "verified torque" and "starts at $69
// per item" although its prompt forbade invented counts and scare copy. A prompt
// is a request; this is the rule.

const RULES = [
  { code: 'invented_count', why: 'job, customer or unit count', re: /\b(hundreds|thousands|dozens|countless)\s+of\b|\b(over|more than)\s+\d+\s+(jobs|customers|homes|installs|projects|units|clients)\b|\bwe(?:'ve| have)\s+(?:assembled|installed|mounted|completed|helped|built|done)\s+(?:hundreds|thousands|dozens|over|more than|\d+)/i },
  { code: 'experience_claim', why: 'years of experience', re: /\b\d+\+?\s+years?\s+of\s+experience\b|\b(years|decades)\s+of\s+experience\b/i },
  { code: 'insurance_license', why: 'insured, bonded or licensed', re: /\b(insured|bonded|licensed|fully covered)\b/i },
  { code: 'electrical_work', why: 'electrical or security-system work (not offered)', re: /\b(wiring|rewir\w*|hard-?wir\w*|electrical|electrician|outlet install\w*|power setup|in-wall power|security systems?|alarm systems?|low-voltage wiring)\b/i },
  { code: 'guarantee', why: 'guarantee', re: /\bguarantee[ds]?\b/i },
  { code: 'per_item_price', why: 'per-item price', re: /\$\s?\d+[^.\n]{0,20}\b(per|\/|each)\s*(item|piece)\b/i },
  { code: 'invented_detail', why: 'invented technical detail', re: /\b(verified torque|torque spec\w*|heat and humidity|humidity affect\w*)\b/i },
  { code: 'scare', why: 'scare copy', re: /\bcosts?\s+(?:you\s+)?(?:thousands|hundreds)\b|\bfire\s+(risk|hazard)\b|\b(tv|television)\s+(falls|crash\w*|crashing)\b|\bliability\b/i },
  { code: 'handyman_tag', why: 'off-brand hashtag', re: /#\w*handyman\w*/i },
  { code: 'emoji', why: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
];

/** Every rule a post breaks, as [{ code, why, match }]. Empty means it may go out. */
export function findClaimViolations(text) {
  const value = String(text || '');
  const out = [];
  for (const rule of RULES) {
    const m = value.match(rule.re);
    if (m) out.push({ code: rule.code, why: rule.why, match: m[0] });
  }
  return out;
}

/** A post with no words, or only a link, is not a post. */
export function hasPostText(text) {
  const words = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').trim();
  return words.length >= 40;
}

export function describeViolations(violations) {
  return violations.map((v) => `${v.why} ("${v.match}")`).join('; ');
}

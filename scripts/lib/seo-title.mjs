// One rule for page titles across every generator. Google cuts titles at about
// 600px, roughly 60 characters (Similarweb Site Audit, 2026-10-26: 198 titles
// over it), and Bing Site Scan flags anything over 70. The suffix (brand or
// "Become an Easer") is dropped when it would push a title past 60; a base
// that is still too long (long city names) drops its "— From $X" price.
export const TITLE_MAX = 60;

export function fitTitle(base, suffix = ' | AssembleAtEase', max = TITLE_MAX) {
  const full = `${base}${suffix}`;
  if (full.length <= max) return full;
  if (base.length <= max) return base;
  return base.replace(/ — From \$[\d,]+$/, '');
}

// One rule for page titles across every generator. Bing Site Scan flags titles
// over 70 characters and both engines cut them off in results, so the suffix
// (brand or "Become an Easer") is dropped when it would push a title past that.
export const TITLE_MAX = 70;

export function fitTitle(base, suffix = ' | AssembleAtEase', max = TITLE_MAX) {
  const full = `${base}${suffix}`;
  return full.length <= max ? full : base;
}

/**
 * How a person's name is stored for display.
 *
 * Owner, 2026-10-06: an applicant typed "THOMAS J WILLIAMS-GIBSON" and the
 * owner roster, emails and the customer's booking page all showed it in
 * capitals beside names written normally. A name typed entirely in capitals or
 * entirely in lowercase carries no casing information, so it is stored in
 * ordinary capitalisation. A name typed with its own casing ("McDonald",
 * "DeShawn", "van der Berg") is kept exactly as typed.
 *
 * The rule matches PostgreSQL initcap() so migration 105 corrects stored rows
 * the same way: a letter after any non-letter, non-digit character starts a
 * word ("Williams-Gibson", "O'Brien").
 *
 * The contractor-agreement signature is NOT passed through this; a signature is
 * recorded exactly as written.
 */
export function normalizePersonName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!/[a-z]/i.test(name)) return name;
  const shouting = name === name.toUpperCase();
  const whispering = name === name.toLowerCase();
  if (!shouting && !whispering) return name;
  return name.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase());
}

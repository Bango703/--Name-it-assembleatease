export function normalizeUsPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? `+1${digits}` : null;
}

export function formatUsPhone(value) {
  const normalized = normalizeUsPhone(value);
  if (!normalized) return null;
  const digits = normalized.slice(2);
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

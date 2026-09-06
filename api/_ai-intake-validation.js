import { createHash } from 'node:crypto';

export function cleanIntakeText(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : '';
}

// Provider context only. Never accept a caller/model-selected booking/profile ID.
export function intakeCallReference(body) {
  let reference = cleanIntakeText(body.conversationId, 100);
  if (body.callControlId !== undefined) {
    if (body.conversationId !== undefined || typeof body.callControlId !== 'string'
        || !/^v3:[A-Za-z0-9_+/=-]{10,1000}$/.test(body.callControlId)) return null;
    reference = `call_${createHash('sha256').update(body.callControlId).digest('hex')}`;
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{9,99}$/.test(reference) ? reference : null;
}

export function intakeCallbackPhone(value) {
  const raw = typeof value === 'string' && value.length <= 30 ? value : '';
  if (/[^\d+().\s-]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+1${digits}` : null;
}

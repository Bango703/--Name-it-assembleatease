import { createHash } from 'node:crypto';

// Lines the phone intake writes into every case description. They are ours, not
// the caller's: api/_ai-assist.js leaves them out when it checks what the caller
// said (owner, 2026-11-26: the "payment taken" disclaimer had blocked every
// phone case from the AI's review).
export const INTAKE_ITEMS_NOTE = 'Items are caller descriptions, NOT priced or verified catalog selections:';
export const INTAKE_SYSTEM_LINES = Object.freeze([
  'Caller confirmed these details and permitted a callback. No SMS or marketing consent inferred.',
  'REQUEST ONLY: no booking confirmed, payment taken, account accessed, dispatch sent, cancellation/refund processed, or payout changed.',
  'Owner: verify identity/assignment before disclosing private information or changing an existing job. Emergency reports require human follow-up; this case is not emergency dispatch.',
]);

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

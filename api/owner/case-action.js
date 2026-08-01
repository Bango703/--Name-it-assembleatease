import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  appendOperationCaseEvent,
  availableOperationCaseActions,
  canTransitionOperationCase,
  isMissingOperationCasesError,
  isOperationCaseStatus,
  operationCaseActionRequiresConfirmation,
  operationCaseActionTarget,
  transitionOperationCase,
} from '../_operation-cases.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const input = normalizeCaseAction(req.body || {});
  const validationError = validateCaseAction(input);
  if (validationError) return res.status(400).json({ error: validationError });

  const sb = getSupabase();
  const { data: existing, error: loadError } = await sb
    .from('operations_cases')
    .select('id, case_ref, case_type, status, booking_id')
    .eq('id', input.caseId)
    .maybeSingle();

  if (loadError) return actionError(res, loadError);
  if (!existing) return res.status(404).json({ error: 'Case not found' });
  if (existing.status !== input.expectedStatus) {
    return res.status(409).json({ error: 'This case changed. Refresh it before saving another update.' });
  }

  try {
    if (input.action === 'add_note') {
      await appendOperationCaseEvent(sb, {
        caseId: input.caseId,
        eventType: 'internal_note',
        actorType: 'owner',
        actorName: 'Owner',
        note: input.note,
        metadata: { caseRef: existing.case_ref },
      });
      return res.status(200).json({
        success: true,
        caseId: existing.id,
        caseRef: existing.case_ref,
        status: existing.status,
        availableActions: availableOperationCaseActions(existing.status),
        moneyMovementCreated: false,
      });
    }

    const targetStatus = operationCaseActionTarget(input.action);
    if (!targetStatus || !canTransitionOperationCase(existing.status, targetStatus)) {
      return res.status(409).json({ error: 'That action is not available for the case in its current status.' });
    }
    if (existing.case_type === 'damage'
        && existing.booking_id
        && ['resolved', 'closed'].includes(targetStatus)) {
      const { data: booking, error: bookingError } = await sb
        .from('bookings')
        .select('damage_review_status')
        .eq('id', existing.booking_id)
        .maybeSingle();
      if (bookingError) throw bookingError;
      if (booking?.damage_review_status === 'review_required') {
        return res.status(409).json({
          error: 'Review the linked booking evidence and complete its damage acknowledgment first. The case will close automatically.',
          code: 'BOOKING_DAMAGE_REVIEW_REQUIRED',
        });
      }
    }

    const updated = await transitionOperationCase(sb, {
      caseId: input.caseId,
      expectedStatus: input.expectedStatus,
      targetStatus,
      actorType: 'owner',
      actorName: 'Owner',
      note: input.note,
      confirmed: input.confirmed,
    });

    return res.status(200).json({
      success: true,
      caseId: updated.id,
      caseRef: updated.case_ref,
      status: updated.status,
      availableActions: availableOperationCaseActions(updated.status),
      moneyMovementCreated: false,
    });
  } catch (error) {
    return actionError(res, error);
  }
}

export function normalizeCaseAction(body = {}) {
  return {
    caseId: String(body.caseId || '').trim(),
    expectedStatus: String(body.expectedStatus || '').trim().toLowerCase(),
    action: String(body.action || '').trim().toLowerCase(),
    note: String(body.note || '').trim().slice(0, 4001),
    confirmed: body.confirmed === true,
  };
}

export function validateCaseAction(input) {
  if (!UUID_RE.test(input.caseId)) return 'A valid caseId is required.';
  if (!isOperationCaseStatus(input.expectedStatus)) return 'A valid expectedStatus is required.';
  if (!operationCaseActionTarget(input.action) && input.action !== 'add_note') return 'A valid case action is required.';
  if (input.note.length > 4000) return 'The internal note must be 4,000 characters or fewer.';
  if (input.action === 'add_note' && input.note.length < 2) return 'Enter an internal note.';
  if (['resolve', 'close', 'reopen'].includes(input.action) && input.note.length < 10) {
    return 'A note of at least 10 characters is required for this action.';
  }
  if (['wait_customer', 'wait_easer'].includes(input.action) && input.note.length < 5) {
    return 'Add a short note explaining what is needed.';
  }
  if (operationCaseActionRequiresConfirmation(input.action) && !input.confirmed) {
    return `Confirmation is required to ${input.action} this case.`;
  }
  return null;
}

function actionError(res, error) {
  console.error('Operations case action failed:', error);
  if (isMissingOperationCasesError(error)) {
    return res.status(503).json({
      error: 'Operations Cases requires migration 053.',
      setupNeeded: true,
      requiredMigration: 53,
    });
  }
  if (error?.code === 'P0002') return res.status(404).json({ error: 'Case not found' });
  if (error?.code === '40001') return res.status(409).json({ error: 'This case changed. Refresh it and try again.' });
  if (error?.code === '22023') return res.status(409).json({ error: error.message || 'Invalid case update' });
  if (error?.code === '42501') return res.status(403).json({ error: 'This case update is not authorized.' });
  return res.status(500).json({ error: 'Failed to update the case' });
}

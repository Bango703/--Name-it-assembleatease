import { getSupabase } from '../_supabase.js';
import { buildStatusEmail, esc, sendEmail, verifyOwner } from '../_email.js';
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
    .select('id, case_ref, case_type, status, subject, booking_id, customer_name, customer_email, easer_id')
    .eq('id', input.caseId)
    .maybeSingle();

  if (loadError) return actionError(res, loadError);
  if (!existing) return res.status(404).json({ error: 'Case not found' });
  if (existing.status !== input.expectedStatus) {
    return res.status(409).json({ error: 'This case changed. Refresh it before saving another update.' });
  }

  try {
    if (input.action === 'send_update') {
      const recipient = await resolveCaseRecipient(sb, existing, input.recipientType);
      const notification = await sendCaseUpdate(existing, recipient, input.publicMessage);
      if (!notification.providerAccepted) {
        return res.status(502).json({
          error: 'The update was not accepted for delivery. The case was not changed.',
          code: 'CASE_NOTIFICATION_NOT_ACCEPTED',
        });
      }
      await appendOperationCaseEvent(sb, {
        caseId: input.caseId,
        eventType: 'public_update',
        actorType: 'owner',
        actorName: 'Owner',
        publicMessage: input.publicMessage,
        metadata: {
          caseRef: existing.case_ref,
          recipientType: recipient.type,
          recipientEmail: recipient.email,
          providerAccepted: true,
          providerId: notification.providerId || null,
        },
      });
      return res.status(200).json({
        success: true,
        caseId: existing.id,
        caseRef: existing.case_ref,
        status: existing.status,
        availableActions: availableOperationCaseActions(existing.status),
        notification: { providerAccepted: true, deliveryStatus: notification.deliveryStatus },
        moneyMovementCreated: false,
      });
    }

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

    let notification = null;
    if (['wait_customer', 'wait_easer'].includes(input.action)) {
      const expectedRecipientType = input.action === 'wait_customer' ? 'customer' : 'easer';
      const recipient = await resolveCaseRecipient(sb, existing, expectedRecipientType);
      notification = await sendCaseUpdate(existing, recipient, input.publicMessage);
      if (!notification.providerAccepted) {
        return res.status(502).json({
          error: `The ${expectedRecipientType === 'customer' ? 'customer' : 'Easer'} update was not accepted for delivery. The case status was not changed.`,
          code: 'CASE_NOTIFICATION_NOT_ACCEPTED',
        });
      }
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
      publicMessage: input.publicMessage,
      confirmed: input.confirmed,
    });

    return res.status(200).json({
      success: true,
      caseId: updated.id,
      caseRef: updated.case_ref,
      status: updated.status,
      availableActions: availableOperationCaseActions(updated.status),
      notification: notification
        ? { providerAccepted: true, deliveryStatus: notification.deliveryStatus }
        : null,
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
    publicMessage: String(body.publicMessage || '').trim().slice(0, 2001),
    recipientType: String(body.recipientType || '').trim().toLowerCase(),
    confirmed: body.confirmed === true,
  };
}

export function validateCaseAction(input) {
  if (!UUID_RE.test(input.caseId)) return 'A valid caseId is required.';
  if (!isOperationCaseStatus(input.expectedStatus)) return 'A valid expectedStatus is required.';
  if (!operationCaseActionTarget(input.action) && !['add_note', 'send_update'].includes(input.action)) return 'A valid case action is required.';
  if (input.note.length > 4000) return 'The internal note must be 4,000 characters or fewer.';
  if (input.publicMessage.length > 2000) return 'The external message must be 2,000 characters or fewer.';
  if (input.action === 'add_note' && input.note.length < 2) return 'Enter an internal note.';
  if (input.action === 'send_update') {
    if (!['customer', 'easer'].includes(input.recipientType)) return 'Choose the customer or Easer.';
    if (input.publicMessage.length < 5) return 'Enter the update to send.';
  }
  if (['resolve', 'close', 'reopen'].includes(input.action) && input.note.length < 10) {
    return 'A note of at least 10 characters is required for this action.';
  }
  if (['wait_customer', 'wait_easer'].includes(input.action) && input.note.length < 5) {
    return 'Add a short note explaining what is needed.';
  }
  if (['wait_customer', 'wait_easer'].includes(input.action) && input.publicMessage.length < 5) {
    return 'Enter the message the recipient needs before changing the case status.';
  }
  if (operationCaseActionRequiresConfirmation(input.action) && !input.confirmed) {
    return `Confirmation is required to ${input.action} this case.`;
  }
  return null;
}

async function resolveCaseRecipient(sb, operationCase, recipientType) {
  if (recipientType === 'customer') {
    if (!operationCase.customer_email) {
      const error = new Error('This case has no customer email. Add or verify the booking contact before sending an update.');
      error.status = 409;
      error.code = 'CASE_CUSTOMER_EMAIL_MISSING';
      throw error;
    }
    return {
      type: 'customer',
      id: null,
      name: operationCase.customer_name || 'Customer',
      email: operationCase.customer_email,
    };
  }

  if (recipientType === 'easer' && operationCase.easer_id) {
    const { data, error: profileError } = await sb.from('profiles')
      .select('id, full_name, email')
      .eq('id', operationCase.easer_id)
      .eq('role', 'assembler')
      .maybeSingle();
    if (profileError) throw profileError;
    if (data?.email) {
      return { type: 'easer', id: data.id, name: data.full_name || 'Easer', email: data.email };
    }
  }

  const error = new Error('This case has no linked Easer email. Link the correct Easer before sending an update.');
  error.status = 409;
  error.code = 'CASE_EASER_EMAIL_MISSING';
  throw error;
}

async function sendCaseUpdate(operationCase, recipient, publicMessage) {
  const firstName = String(recipient.name || (recipient.type === 'easer' ? 'Easer' : 'Customer')).split(/\s+/)[0];
  const result = await sendEmail({
    to: recipient.email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Update for your AssembleAtEase request - ${operationCase.case_ref}`,
    html: buildStatusEmail({
      customerName: firstName,
      ref: operationCase.case_ref,
      status: 'Update',
      statusColor: '#0369a1',
      statusBg: '#e0f2fe',
      headline: 'We have an update for you',
      bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">${esc(publicMessage)}</p><p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Reply to this email if you need help. Keep reference <strong>${esc(operationCase.case_ref)}</strong> for your records.</p>`,
    }),
    meta: {
      bookingId: operationCase.booking_id || null,
      operationCaseId: operationCase.id,
      notificationType: `case_update_${recipient.type}`,
      recipientType: recipient.type,
      recipientUserId: recipient.id || null,
      disableDedupe: true,
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));
  return {
    providerAccepted: result?.ok === true && result?.suppressed !== true,
    providerId: result?.providerId || null,
    deliveryStatus: result?.deliveryStatus || (result?.ok ? 'provider_accepted' : 'failed'),
  };
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
  if (error?.status === 409) return res.status(409).json({ error: error.message, code: error.code || 'CASE_CONTACT_MISSING' });
  return res.status(500).json({ error: 'Failed to update the case' });
}

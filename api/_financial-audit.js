export async function writeFinancialAudit(sb, {
  eventType,
  eventSource = 'api',
  stripeEventId = null,
  bookingId = null,
  paymentIntentId = null,
  refundId = null,
  idempotencyKey = null,
  status = 'processed',
  eventCreatedAt = null,
  metadata = null,
  error = null,
}) {
  if (!sb || !eventType) return { ok: false, error: 'Financial audit input is incomplete' };

  try {
    const { error: insertError } = await sb.from('financial_event_audit').insert({
      stripe_event_id: stripeEventId,
      booking_id: bookingId,
      payment_intent_id: paymentIntentId,
      refund_id: refundId,
      event_type: eventType,
      event_source: eventSource,
      event_created_at: eventCreatedAt,
      processed_at: new Date().toISOString(),
      status,
      idempotency_key: idempotencyKey,
      metadata,
      error,
    });
    if (insertError) {
      console.warn('Financial audit insert skipped:', insertError.message || insertError);
      return { ok: false, error: insertError.message || String(insertError) };
    }
    return { ok: true };
  } catch (e) {
    console.warn('Financial audit insert skipped:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function writeFinancialAuditRequired(sb, payload) {
  const result = await writeFinancialAudit(sb, payload);
  if (!result.ok) {
    const error = new Error(`Financial audit could not be persisted: ${result.error || 'unknown audit error'}`);
    error.code = 'FINANCIAL_AUDIT_PERSISTENCE_REQUIRED';
    throw error;
  }
  return result;
}

export async function claimStripeWebhookEvent(sb, event) {
  if (!sb || !event?.id) return { duplicate: false, claimed: false, reason: 'invalid-event', error: 'Invalid webhook event claim input' };

  try {
    const { error } = await sb.from('financial_event_audit').insert({
      stripe_event_id: event.id,
      event_type: event.type,
      event_source: 'stripe_webhook',
      event_created_at: event.created ? new Date(event.created * 1000).toISOString() : null,
      status: 'processing',
      metadata: { livemode: !!event.livemode },
    });

    if (error) {
      if (error.code === '23505') {
        return { duplicate: true, claimed: false, reason: 'already-processed' };
      }
      console.warn('Webhook event claim skipped:', error.message || error);
      return { duplicate: false, claimed: false, reason: 'claim-error', error: error.message || String(error) };
    }

    return { duplicate: false, claimed: true, reason: 'claimed' };
  } catch (e) {
    console.warn('Webhook event claim failed:', e?.message || e);
    return { duplicate: false, claimed: false, reason: 'claim-exception', error: e?.message || String(e) };
  }
}

export async function finalizeStripeWebhookEvent(sb, eventId, {
  bookingId = null,
  paymentIntentId = null,
  status = 'processed',
  metadata = null,
  error = null,
} = {}) {
  if (!sb || !eventId) return { ok: false, error: 'Invalid webhook finalization input' };

  try {
    const { data, error: updateError } = await sb.from('financial_event_audit')
      .update({
        booking_id: bookingId,
        payment_intent_id: paymentIntentId,
        processed_at: new Date().toISOString(),
        status,
        metadata,
        error,
      })
      .eq('stripe_event_id', eventId)
      .select('id');
    if (updateError || !data?.length) {
      const error = updateError?.message || 'Webhook claim row was not finalized';
      console.warn('Webhook event finalize failed:', error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    console.warn('Webhook event finalize skipped:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

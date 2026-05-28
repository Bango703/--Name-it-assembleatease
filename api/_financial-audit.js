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
  if (!sb || !eventType) return;

  try {
    await sb.from('financial_event_audit').insert({
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
  } catch (e) {
    console.warn('Financial audit insert skipped:', e?.message || e);
  }
}

export async function claimStripeWebhookEvent(sb, event) {
  if (!sb || !event?.id) return { duplicate: false, claimed: false, reason: 'invalid-event' };

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
      return { duplicate: false, claimed: false, reason: 'claim-error' };
    }

    return { duplicate: false, claimed: true, reason: 'claimed' };
  } catch (e) {
    console.warn('Webhook event claim failed:', e?.message || e);
    return { duplicate: false, claimed: false, reason: 'claim-exception' };
  }
}

export async function finalizeStripeWebhookEvent(sb, eventId, {
  bookingId = null,
  paymentIntentId = null,
  status = 'processed',
  metadata = null,
  error = null,
} = {}) {
  if (!sb || !eventId) return;

  try {
    await sb.from('financial_event_audit')
      .update({
        booking_id: bookingId,
        payment_intent_id: paymentIntentId,
        processed_at: new Date().toISOString(),
        status,
        metadata,
        error,
      })
      .eq('stripe_event_id', eventId);
  } catch (e) {
    console.warn('Webhook event finalize skipped:', e?.message || e);
  }
}

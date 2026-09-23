// Owner-facing delivery truth. This does not decide whether to send/retry.
export function notificationNeedsAttention(status) {
  return ['failed', 'bounced', 'complained', 'delivery_delayed', 'uncertain'].includes(String(status || ''));
}

export function notificationOwnerAction(status) {
  if (status === 'uncertain') return 'Provider acceptance is unknown. Check the provider delivery record before any resend; the first attempt may have reached the recipient.';
  if (status === 'deferred') return 'Waiting for a permitted delivery or retry window. Sending is not yet confirmed; automatic retry will recheck booking state and preferences.';
  if (status === 'cancelled') return 'Further delivery of this notification was cancelled because it expired or became stale. This does not cancel the booking. Review prior attempts and current booking details if follow-up is still needed.';
  if (notificationNeedsAttention(status)) return 'Review delivery details and current booking state before contacting the recipient. Do not assume delivery.';
  return null;
}

export function notificationEventType(status) {
  if (status === 'uncertain') return 'notification_uncertain';
  if (notificationNeedsAttention(status)) return 'notification_failed';
  if (status === 'deferred') return 'notification_deferred';
  if (status === 'cancelled') return 'notification_cancelled';
  if (status === 'suppressed') return 'notification_suppressed';
  if (status === 'delivered') return 'notification_delivered';
  if (status === 'queued') return 'notification_queued';
  if (status === 'sending') return 'notification_sending';
  if (status === 'provider_accepted') return 'notification_accepted';
  return status === 'sent' ? 'notification_sent' : 'notification_recorded';
}

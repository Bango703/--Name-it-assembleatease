import { loadPostjobSuppressions, canSendPostjobMessage } from './_postjob-notifications.js';
import { bookingsWithOpenCase } from './_review-email.js';
import { ruleFor } from './_announcements.js';
import { ASSEMBLECASH } from './_assemblecash.js';
import { DISPATCH_OFFER_STATUS } from './_source-of-truth.js';

// Re-evaluate deferred routine messages just before sending. Their original
// snapshot proves what was true when queued, not what is still wanted now.
// retryable distinguishes an unreadable source from a confirmed reason to stop.
export async function notificationRetryEligibility(sb, row, payload, booking, now = new Date()) {
  const type = String(row.notification_type || payload?.meta?.notificationType || '');
  const meta = payload?.meta || {};
  try {
    if (type === 'assemblecash_access_code') {
      const { data: codes, error } = await sb.from('customer_verification_codes')
        .select('code_hash,expires_at,consumed_at,attempts').eq('email', row.recipient_email).eq('purpose', 'assemblecash')
        .order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      const code = codes?.[0];
      return code && !code.consumed_at && code.code_hash === meta.verificationCodeHash && new Date(code.expires_at) > now && Number(code.attempts || 0) < ASSEMBLECASH.CODE_MAX_ATTEMPTS
        ? { ok: true } : { ok: false, reason: 'verification_code_replaced_or_expired' };
    }
    if (type === 'dispatch_offer') {
      const { data: offers, error } = await sb.from('dispatch_offers').select('id,offer_status,expires_at')
        .eq('booking_id', row.booking_id).eq('easer_id', row.recipient_user_id).eq('expires_at', meta.expiresAt)
        .eq('offer_status', DISPATCH_OFFER_STATUS.SENT).limit(1);
      if (error) throw error;
      return offers?.some(offer => new Date(offer.expires_at) > now)
        ? { ok: true } : { ok: false, reason: 'dispatch_offer_no_longer_available' };
    }
    if (type === 'broadcast') {
      const email = String(row.recipient_email || payload?.to || '').trim().toLowerCase();
      const suppressed = await loadPostjobSuppressions(sb);
      if (!email || suppressed.has(email)) return { ok: false, reason: 'marketing_opted_out' };
      if (meta.broadcastAudience === 'marketing_optins') {
        const { data: optin, error } = await sb.from('email_marketing_optins').select('email').eq('email', email).maybeSingle();
        if (error) throw error;
        if (!optin) return { ok: false, reason: 'marketing_optin_removed' };
      }
      return { ok: true };
    }
    if (type === 'followup' || /^review_request_\d+$/.test(type)) {
      const bookingId = row.booking_id || meta.bookingId || booking?.id;
      if (!bookingId) return { ok: false, reason: 'postjob_booking_missing' };
      const { data: current, error } = await sb.from('bookings')
        .select('id,status,customer_email,completed_at,return_visit_required,is_test_booking,review_request_count')
        .eq('id', bookingId).maybeSingle();
      if (error) throw error;
      if (!current) return { ok: false, reason: 'postjob_booking_missing' };
      const openCases = await bookingsWithOpenCase(sb, [bookingId]);
      if (openCases === null) return { ok: false, reason: 'open_case_lookup_failed', retryable: true };
      const suppressed = await loadPostjobSuppressions(sb);
      if (!canSendPostjobMessage(current, { openCases, suppressed })) {
        return { ok: false, reason: 'postjob_no_longer_eligible' };
      }
      const ageDays = (new Date(now).getTime() - new Date(current.completed_at).getTime()) / 86400000;
      if (!Number.isFinite(ageDays) || ageDays < (type === 'followup' ? 21 : 2) || ageDays > (type === 'followup' ? 35 : 30)) {
        return { ok: false, reason: 'postjob_window_ended' };
      }
      if (type !== 'followup') {
        const { data: reviews, error: reviewError } = await sb.from('reviews').select('booking_id').eq('booking_id', bookingId).limit(1);
        if (reviewError) throw reviewError;
        if (reviews?.length) return { ok: false, reason: 'review_already_recorded' };
        const step = Number(type.split('_').at(-1));
        if (step > 2 || Number(current.review_request_count || 0) >= step) {
          return { ok: false, reason: 'review_request_already_recorded' };
        }
      }
      return { ok: true };
    }

    if (type.startsWith('easer_required_action_')) {
      const key = type.slice('easer_required_action_'.length);
      const { data: announcement, error } = await sb.from('easer_announcements').select('*').eq('key', key).maybeSingle();
      if (error) throw error;
      const instant = new Date(now).getTime();
      if (!announcement || announcement.status !== 'active'
          || new Date(announcement.starts_at).getTime() > instant
          || (announcement.ends_at && new Date(announcement.ends_at).getTime() <= instant)) {
        return { ok: false, reason: 'announcement_inactive' };
      }
      const rule = ruleFor(announcement);
      if (!rule || (typeof rule.active === 'function' && !rule.active())) return { ok: false, reason: 'announcement_inactive' };
      const easerId = row.recipient_user_id || meta.recipientUserId;
      if (!easerId) return { ok: false, reason: 'announcement_recipient_missing' };
      const { data: profile, error: profileError } = await sb.from('profiles').select('*').eq('id', easerId).eq('role', 'assembler').maybeSingle();
      if (profileError) throw profileError;
      if (!profile || !rule.incomplete(profile)) return { ok: false, reason: 'announcement_action_complete' };
      const destination = String(row.recipient_email || payload?.to || '').trim().toLowerCase();
      if (destination && destination !== String(profile.email || '').trim().toLowerCase()) {
        return { ok: false, reason: 'announcement_recipient_changed' };
      }
      if (typeof rule.confirmStillIncomplete === 'function') {
        const result = await rule.confirmStillIncomplete(sb, profile);
        if (!result.verified) return { ok: false, reason: 'announcement_action_unverified', retryable: true };
        if (!result.stillIncomplete) return { ok: false, reason: 'announcement_action_complete' };
      }
      if (meta.announcementCycle) {
        const { data: delivery, error: deliveryError } = await sb.from('easer_announcement_deliveries')
          .select('completed_at,reminder_state').eq('announcement_id', announcement.id).eq('easer_id', easerId).maybeSingle();
        if (deliveryError) throw deliveryError;
        if (!delivery || delivery.completed_at
            || (delivery.reminder_state?.cycle || 'initial') !== meta.announcementCycle) {
          return { ok: false, reason: 'announcement_reminder_replaced' };
        }
      }
    }
    return { ok: true };
  } catch (error) {
    console.error('[notification] retry eligibility unavailable:', error.message);
    return { ok: false, reason: 'notification_eligibility_unavailable', retryable: true };
  }
}

import { randomBytes } from 'crypto';

export const REVIEW_REWARD_MINIMUM_CENTS = 10000;
export const REVIEW_REWARD_DISCOUNT_CENTS = 1000;
const CODE_PREFIX = 'AAE10-';

export function isReviewRewardCode(value) {
  return /^AAE10-[A-F0-9]{24}$/.test(String(value || '').trim().toUpperCase());
}

export function createReviewRewardCode() {
  return `${CODE_PREFIX}${randomBytes(12).toString('hex').toUpperCase()}`;
}

export async function issueReviewReward(sb, booking) {
  const code = createReviewRewardCode();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  const { error } = await sb.from('review_reward_codes').insert({
    booking_id: booking.id,
    customer_email: String(booking.customer_email || '').trim().toLowerCase(),
    code,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'issued',
  });
  if (error) throw error;
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function reserveReviewReward(sb, { code, email, bookingId }) {
  const { data, error } = await sb.rpc('reserve_review_reward_v1', {
    p_code: String(code || '').trim().toUpperCase(),
    p_customer_email: String(email || '').trim().toLowerCase(),
    p_booking_id: bookingId,
  });
  if (error) throw error;
  return data === true;
}

export async function releaseReviewReward(sb, bookingId) {
  if (!bookingId) return;
  const { error } = await sb.rpc('release_review_reward_v1', { p_booking_id: bookingId });
  if (error) throw error;
}

export async function completeReviewReward(sb, bookingId) {
  if (!bookingId) return;
  const { error } = await sb.rpc('complete_review_reward_v1', { p_booking_id: bookingId });
  if (error) throw error;
}

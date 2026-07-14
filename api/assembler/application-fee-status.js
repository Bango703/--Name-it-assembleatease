import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { getClientIp } from '../_assembler-onboarding.js';
import {
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_CURRENCY,
  EASER_APPLICATION_FEE_DISPLAY,
  getEaserApplicationFeeStatus,
} from '../_easer-application-fee.js';
import { isActiveInstantBookingZip } from '../_source-of-truth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!await rateLimit(getClientIp(req), 'default')) {
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }

  const requestedState = String(req.query?.state || '').trim().toUpperCase();
  const requestedZip = String(req.query?.zip || '').trim();
  const marketRequested = Boolean(requestedState || requestedZip);
  const marketActive = marketRequested
    ? requestedState === 'TX' && isActiveInstantBookingZip(requestedZip)
    : null;

  // The national waitlist must remain available even if fee inventory cannot
  // be read. No application or payment is permitted for an inactive market,
  // so return the non-waived standard fee only as safe display context.
  if (marketRequested && !marketActive) {
    return res.status(200).json({
      applicationFee: {
        amountCents: EASER_APPLICATION_FEE_CENTS,
        standardAmountCents: EASER_APPLICATION_FEE_CENTS,
        currency: EASER_APPLICATION_FEE_CURRENCY,
        amountDisplay: EASER_APPLICATION_FEE_DISPLAY,
        standardAmountDisplay: EASER_APPLICATION_FEE_DISPLAY,
        waiverAvailable: false,
        finalDecisionAtSubmission: true,
      },
      market: {
        active: false,
        code: 'EASER_MARKET_NOT_ACTIVE',
        waitlistEndpoint: '/api/waitlist',
      },
    });
  }

  try {
    const applicationFee = await getEaserApplicationFeeStatus(getSupabase());
    return res.status(200).json({
      applicationFee: {
        amountCents: applicationFee.amountCents,
        standardAmountCents: applicationFee.standardAmountCents,
        currency: applicationFee.currency,
        amountDisplay: applicationFee.waiverAvailable ? '$0.00' : EASER_APPLICATION_FEE_DISPLAY,
        standardAmountDisplay: EASER_APPLICATION_FEE_DISPLAY,
        waiverAvailable: applicationFee.waiverAvailable,
        finalDecisionAtSubmission: true,
      },
      market: marketRequested ? {
        active: marketActive,
        code: marketActive ? 'EASER_MARKET_ACTIVE' : 'EASER_MARKET_NOT_ACTIVE',
        waitlistEndpoint: marketActive ? null : '/api/waitlist',
      } : undefined,
    });
  } catch (error) {
    console.error('Application fee status lookup failed:', error?.message || error);
    return res.status(503).json({
      error: 'Application fee status is temporarily unavailable. Submission will not assume a waiver.',
    });
  }
}

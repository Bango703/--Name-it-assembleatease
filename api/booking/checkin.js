/**
 * POST /api/booking/checkin — DEPRECATED (v2 2026-05-23)
 *
 * This endpoint has been replaced by easer-status with stage='arrived'.
 * easer-status is the single source of truth for all pipeline transitions:
 *   POST /api/booking/easer-status  { bookingId, stage: 'arrived' }
 *
 * Using checkin would set checked_in_at without updating the booking status
 * (status stays 'confirmed'), causing divergence from the pipeline state and
 * sending duplicate customer notifications when easer-status is also called.
 */
export default async function handler(req, res) {
  return res.status(410).json({
    error: 'This endpoint has been retired. Use POST /api/booking/easer-status with stage="arrived" instead.',
    replacement: '/api/booking/easer-status',
  });
}

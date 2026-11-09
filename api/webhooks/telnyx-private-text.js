import handler from './telnyx.js';

/**
 * POST /api/webhooks/telnyx-private-text — the text number's Telnyx messaging
 * profile was first pointed here, for forwarding customer and Easer texts to
 * each other. They no longer text each other (owner, 2026-11-09): they talk in
 * the app and on the booking page, and texts are updates only.
 *
 * Whatever webhook address Telnyx uses for the text number, its replies, STOP
 * and START, and delivery receipts are handled exactly as the business
 * number's are (api/webhooks/telnyx.js): a reply lands in the owner's Messages
 * inbox, and the owner's answer goes back from the text number.
 */
export const config = { api: { bodyParser: false } };
export default handler;

/**
 * What can actually reach a function, and therefore what a browser may send.
 *
 * THE BUG THIS EXISTS TO END
 * Every upload screen capped the file at 5 MB and then base64-encoded it before
 * POSTing it as JSON. Base64 adds a third. Vercel rejects any request body over
 * 4.5 MB with a 413 BEFORE the function runs, so a 4 MB photo became a 5.4 MB
 * body that never reached the handler: nothing logged, no activity row, and the
 * browser showed "Connection error" because it tried to JSON.parse a 413 page.
 * Under about 3.3 MB it worked. Over it, it never could. Which Easer you were
 * decided whether job completion worked at all.
 *
 * The 5 MB number was not wrong by a little; it was never reachable. Nothing
 * may hardcode an upload size again. Every cap is derived from the platform
 * limit below, and scripts/test-upload-limits.mjs fails the build if any
 * browser or server path invents its own number.
 *
 * Source: https://vercel.com/docs/functions/limitations#request-body-size
 * "The maximum payload size for the request body or the response body of a
 * Vercel Function is 4.5 MB ... 413: FUNCTION_PAYLOAD_TOO_LARGE".
 */

/** Hard platform ceiling. Not ours to raise, and bodyParser cannot override it. */
export const VERCEL_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);

/** Base64 encodes 3 bytes as 4 characters. */
export const BASE64_EXPANSION = 4 / 3;

/** "data:image/jpeg;base64," plus the JSON keys, a UUID, a mime type, and up to 2,000 characters of notes. */
export const JSON_ENVELOPE_BYTES = 4096;

/**
 * Headroom. Proxy headers, multibyte characters in notes and any future field
 * all consume body budget, and the failure mode for guessing too high is a job
 * that cannot be completed in someone's living room.
 */
export const SAFETY_FACTOR = 0.9;

/** The largest ORIGINAL file whose base64 JSON body still fits. About 3.0 MB. */
export const MAX_UPLOAD_BYTES = Math.floor(
  ((VERCEL_BODY_LIMIT_BYTES * SAFETY_FACTOR) - JSON_ENVELOPE_BYTES) / BASE64_EXPANSION,
);

/**
 * Every job photo is downscaled in the browser before it is sent. A phone photo
 * lands at 200-500 KB, which is far under the ceiling, uploads in a moment on a
 * job-site connection, and is still more detail than a completion record needs.
 * Re-encoding to JPEG also converts iPhone HEIC, which not every browser decodes.
 */
export const IMAGE_MAX_EDGE_PX = 1600;
export const IMAGE_JPEG_QUALITY = 0.8;

/** Fallback qualities if the first encode is still somehow over the ceiling. */
export const IMAGE_FALLBACK_QUALITIES = Object.freeze([0.6, 0.45]);

/** One wording for the one condition, so no screen invents a friendlier lie. */
export const UPLOAD_TOO_LARGE_MESSAGE =
  'That photo is too large to send. Take it again at a lower resolution, or pick a smaller one.';

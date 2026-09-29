# Call Routing Review

Status: review-only
As of: 2026-09-24

## Current Paths

- Owner click-to-call: `api/owner/call-customer.js` -> `api/_owner-call.js` -> `api/webhooks/telnyx-call-control.js`.
- Inbound booking-aware routing: `api/webhooks/telnyx-call-control.js`.
- Voice history: `api/webhooks/telnyx-voice.js` and `_voice-call-history.js`.
- AI/receptionist: `api/ai/receptionist.js`.

## Safety Rules

- Caller identity must match exactly one active eligible booking.
- Ambiguous or unmatched callers use fallback rather than guessing.
- Business number remains the presented caller identity.
- Webhook signatures are required.
- Operational event logging must never alter call routing.
- Live end-to-end customer/Easer bridge remains unverified and needs a synthetic test with an eligible booking.

## Current Validation

- Existing owner click-to-call test passes.
- Existing Telnyx webhook suite reaches a pre-existing failure in a provider-accepted/log-failure scenario; this review did not alter that SMS webhook path.
- Booking-aware inbound routing has syntax validation but no complete live synthetic bridge proof yet.

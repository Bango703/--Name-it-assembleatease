// Legacy Stripe Identity URL retained as an alias so an older Stripe endpoint
// cannot diverge from the canonical audited webhook implementation. Event
// claiming in the canonical handler makes delivery to both URLs idempotent.
export { config } from '../assembler/stripe-webhook.js';
export { default } from '../assembler/stripe-webhook.js';

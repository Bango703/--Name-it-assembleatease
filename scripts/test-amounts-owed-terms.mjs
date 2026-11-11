#!/usr/bin/env node
// What happens when a customer does not pay (owner, 2026-11-10): the Terms
// authorize charging the saved card for amounts owed, and set out the
// past-due notice and collection path. The authorization matches what the
// platform charges saved cards for today; it never covers an amount under
// dispute, and the Terms never claim a right to customer property.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('terms.html');
const text = terms.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');

assert.match(terms, /<h3>Charges for Amounts You Owe<\/h3>/);
assert.match(text, /charge the payment method saved for a booking, through Stripe, for any amount you owe under these Terms for that booking: additional work you approved, a cancellation or no-show fee under the policy above, and any unpaid balance for completed Services/);
assert.match(text, /We email a receipt for each charge\./);
assert.match(text, /we do not charge a card for an amount you are currently disputing with your card issuer/);

assert.match(terms, /<h3>Past-Due Amounts and Collection<\/h3>/);
assert.match(text, /email a written notice to the email address on the booking stating the amount, the booking reference, and how to pay/);
assert.match(text, /still unpaid 30 days after that notice, AssembleAtEase may refer it to a collection agency or file an individual claim in small claims court/);
assert.match(text, /To the extent permitted by Texas law, you agree to pay the reasonable costs of collecting a past-due amount, including collection agency fees, court costs, and reasonable attorneys' fees/);
assert.match(text, /follow applicable debt collection laws/);

// Small claims stays outside arbitration, or the collection path above would
// have to go through consumer arbitration instead.
assert.match(text, /This requirement does not prevent either party from seeking urgent temporary relief or filing an eligible individual action in small claims court/);
assert.match(text, /Except for an eligible individual small-claims action/);

// Never a claim on the customer's home or belongings.
assert.doesNotMatch(text, /\blien\b|seize|repossess|take possession of your/i);

// The authorization matches what the platform does: cards are saved for later
// charges at booking, and approved extra work and balances charge the saved card.
assert.match(read('api/booking.js'), /setup_future_usage: 'off_session'/);
assert.match(read('api/booking/change-order-approve.js'), /off_session: true/);
assert.match(read('api/booking/_stripe-booking-payment.js'), /type: 'customer_booking_balance'/);

assert.match(read('api/_legal-consent.js'), /CUSTOMER_TERMS_VERSION = '2026-11-10-amounts-owed-v1'/);
console.log('PASS amounts owed: saved-card charges for amounts owed, a written notice, then collection or small claims; never property');

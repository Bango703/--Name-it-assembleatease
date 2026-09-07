import { voiceSelectionFragment, validateVoiceSelection } from '../../assets/js/voice-booking-selection.js';

// Read-only handoff. Deliberately no customer/contact fields, credentials,
// arbitrary URLs, prices, booking IDs, automatic messages or payment actions.
export function prepareBookingContinuation(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['action', 'items', 'requestQuote', 'selectionConfirmed'].includes(key))
      || body.action !== 'prepare_booking' || body.selectionConfirmed !== true) {
    return { error: 'Confirm the selected services and quantities before preparing checkout.' };
  }
  const selection = { version: 1, items: body.items, requestQuote: body.requestQuote ?? false };
  const validated = validateVoiceSelection(selection, catalog);
  if (validated.error) return validated;
  const encoded = voiceSelectionFragment(validated.value, catalog);
  if (encoded.error) return encoded;
  return { value: {
    status: 'selection_prepared', bookingCreated: false, paymentTaken: false,
    identityVerified: false, appointmentConfirmed: false, messageSent: false,
    requiresQuote: validated.value.requestQuote,
    items: validated.value.items,
    bookingUrl: 'https://www.assembleatease.com/book?utm_source=sora&utm_medium=voice' + encoded.value,
    message: 'The selected items are ready to review on the booking page. The customer must enter their details, choose appointment options, review current prices and terms, and complete secure payment or quote submission there. Nothing is booked or sent yet. Do not read the long link aloud or claim it was delivered.',
  } };
}

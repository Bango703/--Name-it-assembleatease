# Bullard appointment confirmation drafts

Prepared October 7, 2026 for existing booking `AAE-EYXG5NSDUN`. **Not sent.** The owner record shows an accepted October 16, 10 AM–noon appointment, four TVs, stone-fireplace MantelMount work, a soundbar and three in-wall concealments. The October 6 Easer message asks about a day/time on or after October 14; no customer reply was visible during review.

**October 8 instruction:** Travis will handle the customer follow-up. Neither draft below was sent by the assistant. These remain reference copy, not a pending request to send automatically. No appointment, price, assignment or payment was changed.

These drafts confirm the existing appointment and scope. They do not promise a backup Easer or authorize travel. Record an actual reply before treating the appointment or scope as confirmed by either person.

## Customer message

Hello, we're checking the details for your AssembleAtEase appointment in Bullard. Your booking is currently scheduled for Friday, October 16, with a 10 AM–noon arrival window. Please confirm that this window still works for you.

We have four TVs, the stone-fireplace MantelMount installation, a soundbar and three in-wall cable concealments listed. Please send the MantelMount model and any wall or installation details that have changed since booking. We'll confirm the details with your Easer before the visit. You can reply here or call 979-232-5139.

## Assigned Easer message

Hi Phil, please confirm your availability and travel plans for the Bullard booking on Friday, October 16, with a 10 AM–noon arrival window. Your October 6 message asks the customer about dates on or after October 14; the booking still shows October 16, and we have not yet confirmed a different time.

Please review the full scope: four TVs, the stone-fireplace MantelMount installation, a soundbar and three in-wall cable concealments. Confirm that you have the experience and tools for the wall surfaces and mount, and flag any model, wall-access or concealment questions before the appointment. Please use the booking thread so everyone has the same confirmed details.

## Owner follow-through

Record each actual reply in the existing booking timeline. If either party cannot confirm the appointment or the scope, resolve the exception through the existing scheduling/assignment workflow and identify a qualified backup before making a promise. Review the scheduled card authorization outcome and existing travel checks before the visit. An internal note or a sent message is not proof of customer commitment, capability, attendance or payment.

The October 7 internal owner note is already saved. The outstanding follow-up is tracked as `GROWTH-FULFILL-20261007` in the single backlog.

## Where messages go (code rechecked against current main October 8)

- Owner **Send to Customer** saves the message in this booking and emails the customer's booking address. It does not send customer SMS or push.
- Owner **Send to Easer** saves the message and notifies the assigned Easer by email and available push subscriptions.
- A customer reply on the tracking page goes to the accepted Easer, or the team if no Easer has accepted. It stays visible in the booking; the owner receives an email copy. The accepted Easer can also receive push and consent-gated, throttled SMS notifications.
- The Easer's explicit customer-message route saves the message, emails the customer and attempts a consent-gated SMS notice. The normal Easer support route contacts the owner.
- A direct reply to a notification email goes to the configured owner mailbox. No inbound email-to-booking-thread synchronization was found.
- Provider acceptance, email delivery and customer reading are different. The customer thread does not record a read receipt. Confirm receipt from an actual customer response.

Sources: `api/booking/message.js`, `api/booking/_message-routing.js`, `api/booking/track.js`, `owner/index.html`. Current main also has a separate owner SMS inbox; that does not change the booking composer into an SMS sender.

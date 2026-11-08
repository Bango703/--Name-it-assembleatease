# Thumbtack owner area

The owner console has a dedicated Thumbtack view at **Growth → Thumbtack**. It stores lead summaries and message previews from inbound Thumbtack webhooks, tracks lead charges separately from refunds and courtesy credits, and links a Thumbtack lead to an AAE booking for completed-job return reporting.

## Data and money boundaries

- Thumbtack events never create or change AAE bookings, Stripe payments, customer messages, dispatch, or Easer payouts.
- Thumbtack sends the lead-created event once; the status shown here is the initial status received, not a live status feed. This tracker does not poll Thumbtack for later status changes.
- Lead price is taken from the lead event when Thumbtack supplies it. Unknown cost remains unknown until the owner records it.
- Thumbtack does not send lead refund/credit webhook events. Verify those in Thumbtack and enter refunds and courtesy credits separately in the owner view.
- Completed-job return is read from the existing AAE finance projection for a linked, completed Thumbtack booking. It shows platform gross after the existing AAE job economics, then subtracts net Thumbtack lead cost for the selected set of leads.
- The webhook stores only the lead ID, service/location summary, status, lead price, event timestamps, and a bounded latest-message excerpt. It does not persist raw event payloads or customer phone/email.

## Deployment configuration

1. Apply `api/migrations/122_thumbtack_owner_area.sql` to the production database before deploying the application code.
2. Set `THUMBTACK_WEBHOOK_USERNAME` and `THUMBTACK_WEBHOOK_PASSWORD` in the target Vercel environment. Use unique high-entropy credentials and never put them in source control or a public URL.
3. In Thumbtack's self-serve webhook settings, configure `https://www.assembleatease.com/api/webhooks/thumbtack` for lead and message events, and set HTTP Basic authentication to the same credentials. Thumbtack's current self-serve webhook setup supports Basic Auth; do not leave authentication unset.
4. Send a test lead/message event and confirm it appears in the owner area before relying on it. The receiver is idempotent by provider event ID (or a payload digest when an event ID is absent).

Thumbtack's self-serve webhooks support one business at a time and can send lead, message, and review event families. This endpoint is configured for lead and message payloads only; review events should not be subscribed until a review handler exists. The receiver does not fall back to unauthenticated delivery.

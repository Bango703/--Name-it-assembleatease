# Stripe Connect Test Rollout

This project now supports an optional Stripe Connect payout path for completion flows while preserving manual payouts as fallback.

## 1) Enable Connect in test mode

Set these in your local env:

- STRIPE_SECRET_KEY=sk_test_...
- STRIPE_PUBLISHABLE_KEY=pk_test_...
- STRIPE_WEBHOOK_SECRET=whsec_...
- STRIPE_CONNECT_ENABLED=true

## 2) Run schema migration

Run the SQL in api/migrations/021_stripe_connect_columns.sql in Supabase SQL editor.

## 3) Seed end-to-end Stripe sandbox data

Command:

```bash
npm run stripe:connect:seed
```

Optional env before the command:

- CONNECT_TEST_PROFILE_ID: profile UUID to auto-attach connected account data
- CONNECT_TEST_EMAIL: explicit account email
- CONNECT_TEST_AMOUNT_CENTS: default 12900
- CONNECT_MEMBERSHIP_AMOUNT_CENTS: default 4900

The command creates:

- Express connected account
- Onboarding link
- Test customer + test payment method
- Manual-capture payment intent (captured by default)
- Test transfer to connected account
- Test membership product + recurring price

## 4) Validate in app

1. Complete a booking from assembler path (api/booking/assembler-complete) and owner path (api/booking/complete).
2. Confirm response includes payout.status.
3. Confirm booking row has stripe_transfer_id and stripe_destination_account_id.
4. Confirm payout_status is paid when transfer succeeded.
5. Confirm fallback keeps payout pending when transfer cannot run.

## 5) Safe fallback behavior

If Connect is disabled or account capabilities are incomplete:

- Booking still completes
- Payment still captures
- Payout remains manual/pending
- No production behavior changes unless STRIPE_CONNECT_ENABLED=true

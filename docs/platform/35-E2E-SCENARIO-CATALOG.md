# E2E Scenario Catalog

Status: target contract

Critical scenarios:

- customer booking happy path
- booking payment failure
- authorization expires before appointment
- active-job reauthorization
- no eligible Easer
- two Easers accept simultaneously
- Easer cancellation and reassignment
- customer reschedule/cancel after assignment
- Easer late/no-show
- evidence upload failure and replacement
- completion submitted twice
- owner manual completion verification
- capture timeout or unknown result
- duplicate and out-of-order Stripe webhook
- SMS/email delivery failure
- Easer payout failure
- refund success/failure
- dispute created
- unauthorized customer/Easer resource access
- owner financial permission denial
- database rollback
- outbox/worker restart
- duplicate worker processing
- dead-letter creation and recovery

Each scenario records actors, starting state, commands, provider calls, database writes, events, notifications, money effect, audit effect, failure behavior, idempotency expectation, and proof test.

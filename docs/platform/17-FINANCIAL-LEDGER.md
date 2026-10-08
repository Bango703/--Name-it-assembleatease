# Financial Ledger

Status: target contract
As of: 2026-09-24

Provider records are evidence of external movement, not the complete platform accounting source of truth.

## Entry Types

```text
customer_payment
sales_tax_liability
processing_fee
owner_easer_labor
external_easer_labor
assemblecash_liability
platform_gross
refund
rework_cost
chargeback
collection_recovery
adjustment
```

## Rules

- Ledger entries are append-oriented.
- Corrections are reversal plus replacement, never silent mutation.
- Every entry links booking, transaction, customer, Easer, and provider reference where applicable.
- Ledger posting follows confirmed provider truth or a documented offline payment policy.
- Reconciliation compares provider, booking, ledger, earnings, and payout records.

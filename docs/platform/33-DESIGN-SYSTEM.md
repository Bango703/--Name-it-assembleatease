# Design System

Status: target contract

## Foundations

```text
space-1 space-2 space-3 space-4 space-6 space-8
text-xs text-sm text-base text-lg text-xl text-2xl
surface surface-raised border text-primary text-secondary success warning danger info
```

## Components

```text
typography spacing color elevation radius iconography
button input select tabs table card alert badge modal drawer timeline metric chart empty-state skeleton toast
```

Rules:

- Components render canonical domain state rather than reinterpreting it.
- Every state has loading, empty, error, disabled, and permission-aware behavior where applicable.
- Owner, Customer, and Easer surfaces share tokens but not information exposure.

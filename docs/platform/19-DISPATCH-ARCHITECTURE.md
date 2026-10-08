# Dispatch Architecture

Status: target contract mapped to current dispatch implementation
As of: 2026-09-24

```text
confirmed booking
 -> dispatch request
 -> eligibility filter
 -> candidate ranking
 -> offer
 -> accepted
 -> assignment
```

Eligibility includes:

- active account
- availability
- terms and readiness
- skill/service match
- market match
- distance
- crew/equipment requirements
- payment readiness
- suspension and quality flags

Rules:

- Offers expire and are never silently accepted after expiry.
- Acceptance uses atomic compare-and-set.
- Assignment history is append-only.
- Reassignment creates a new assignment version.
- No eligible Easer creates an owner alert and recovery path.
- Automatic dispatch and owner manual assignment have separate payment rules.

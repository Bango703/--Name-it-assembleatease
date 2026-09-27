# Evidence Architecture

Status: target contract mapped to current evidence implementation
As of: 2026-09-24

Evidence fields:

```text
booking_id
easer_id
uploaded_by
uploaded_on_behalf_of
type
storage_key
checksum
mime_type
captured_at
uploaded_at
source
visibility
verification_status
```

Types:

```text
before_photo
after_photo
damage_existing
scope_document
customer_approval
issue_photo
owner_override
```

Rules:

- Evidence is private by default.
- Owner-supplied evidence identifies the owner and the Easer it supports separately.
- Upload failure preserves a recoverable completion path.
- File type, magic bytes, size, storage path, and signed URL expiry are validated.
- Sharing with the customer is an explicit owner decision.
- Evidence review may hold payout but must not silently mutate payment truth.

# Security Model

Status: target contract mapped to current controls
As of: 2026-09-24

Controls:

- authentication and session validation
- deny-by-default authorization
- explicit owner permissions
- customer ownership checks
- Easer assignment checks
- resource and tenant scope checks
- rate limiting
- input validation and output encoding
- SQL parameterization through Supabase APIs/RPCs
- Stripe, Telnyx, and Resend webhook signature verification
- encrypted transport and provider-managed encrypted storage
- private evidence storage with expiring signed URLs
- secrets kept in environment/provider configuration, not source
- restricted and redacted logs
- upload size, MIME, and magic-byte validation
- secure headers and no-store owner responses
- append-only audit trail for sensitive operations

Known target gaps:

- explicit MFA enforcement policy for owner roles
- centralized permission registry implementation
- formal data retention/deletion policy
- dependency and supply-chain scanning contract
- restore and incident-response exercises

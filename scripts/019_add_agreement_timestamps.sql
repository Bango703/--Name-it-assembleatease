ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contractor_agreement_signed_at TIMESTAMPTZ;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS code_of_conduct_agreed_at TIMESTAMPTZ;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contractor_agreement_version TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contractor_agreement_ip TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contractor_agreement_user_agent TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contractor_agreement_signed_name TEXT;

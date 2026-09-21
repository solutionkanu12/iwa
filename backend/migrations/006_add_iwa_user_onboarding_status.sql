-- Adds onboarding_status to Iwa users table.
--
-- Tracks whether an Iwa User account is newly created, in the process of
-- onboarding, or has completed wallet onboarding.
--
-- Migration is idempotent and safe to apply to an existing users table.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'new'
    CHECK (onboarding_status IN ('new', 'incomplete', 'completed'));

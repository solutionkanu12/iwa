-- Iwa User accounts and durable browser sessions.
--
-- WHAT THIS SCHEMA MAY HOLD: an opaque user id, a normalized verified email,
-- a provider subject (Google sub or Supabase user id), and the SHA-256 of a
-- session token. Email is a login identifier. It is not a member_ref and it
-- is not a wallet.
--
-- WHAT IT MUST NEVER HOLD, and has no column for: wallet private keys, seed
-- phrases, viewing keys, Google/Supabase access or refresh tokens, or any
-- chain signing material.

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY,
    email       TEXT        NOT NULL UNIQUE,
    status      TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_identities (
    id               UUID PRIMARY KEY,
    user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('google', 'email')),
    provider_subject TEXT        NOT NULL,
    verified_email   TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    user_agent   TEXT,
    device_label TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_hash_idx ON sessions (token_hash);

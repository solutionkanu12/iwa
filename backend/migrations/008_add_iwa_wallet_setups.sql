-- Non-custodial Iwa Wallet setup coordination.
--
-- This table intentionally holds only an opaque, server-generated wallet id
-- and non-secret local-vault setup progress. It has no column for passwords,
-- PINs, WebAuthn PRF output, recovery material, encrypted vault records, or
-- current/future chain authority.

CREATE TABLE IF NOT EXISTS iwa_wallet_setups (
    user_id      UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    wallet_id    UUID        NOT NULL UNIQUE,
    setup_status TEXT        NOT NULL CHECK (setup_status IN ('reserved', 'vaultProvisioned')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

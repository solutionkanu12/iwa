-- Chain-neutral member <-> account binding.
--
-- This is deliberately a separate table from circle_drafts/draft_slots, not
-- an extra column on them. Those tables' circle_id is a Starknet on-chain
-- INTEGER id; a chain-neutral binding needs an opaque TEXT circle identifier
-- (a Celo circle's identity is its deployed contract address, not a
-- Starknet-style integer), so folding it into the existing schema would mean
-- overloading a column's type and meaning rather than reusing it.
--
-- WHAT THIS SCHEMA MAY HOLD: a public commitment (member_ref), a public,
-- adapter-formatted chain identifier (e.g. "celo:42220"), and a public
-- account identifier (e.g. "celo:0x..."). All three are already public by
-- the time a circle transacts on any chain.
--
-- WHAT IT MUST NEVER HOLD, and has no column for: private keys, seed
-- phrases, signing secrets, or wallet-signature proof material. Binding an
-- account here proves nothing about its private key; this is a coordination
-- record, not a credential.
--
-- IMMUTABILITY: a binding is never updated once written. There is no UPDATE
-- statement anywhere in Store/PgStore/MemoryStore for account_bindings, and
-- accept_account_bind (the only writer) refuses to write over an existing
-- row. Changing a binding requires deleting the row by direct operator
-- action outside the API surface, which is deliberate friction against
-- silent reassignment (AGENTS.md: "admin cannot choose recipients
-- arbitrarily"; the same principle applies to who a member even is).

-- A single-use, per-(circle, member) coordination token. Mirrors
-- draft_slots.invite_token: a bearer token that authorizes claiming exactly
-- one place, not a credential that proves who is claiming it. The wallet
-- signature/ownership proof for whichever chain is doing the binding is the
-- adapter's concern; this table only proves "whoever holds this token was
-- the one invited to be this member."
CREATE TABLE IF NOT EXISTS account_bind_invites (
    circle_id    TEXT        NOT NULL,
    member_ref   TEXT        NOT NULL,
    chain        TEXT        NOT NULL,
    invite_token TEXT        NOT NULL UNIQUE,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, member_ref)
);

CREATE TABLE IF NOT EXISTS account_bindings (
    circle_id    TEXT        NOT NULL,
    member_ref   TEXT        NOT NULL,
    chain        TEXT        NOT NULL,
    account      TEXT        NOT NULL,
    bound_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, member_ref)
);

CREATE INDEX IF NOT EXISTS account_bindings_account_idx
    ON account_bindings (chain, account);

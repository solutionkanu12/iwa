-- IWA coordination and indexing schema.
--
-- WHAT THIS DATABASE MAY HOLD: public, on-chain-derivable coordination data.
-- Member commitments (member_ref) and auth PUBLIC keys are public by design —
-- they are written to the circle contract when it is created.
--
-- WHAT IT MUST NEVER HOLD, and has no column for: wallet private keys, seed
-- phrases, STRK20 viewing keys, member auth PRIVATE keys, invite secrets, or
-- any private contribution amount or note. The API rejects such fields; the
-- absence of columns is the second line of defence.

CREATE TABLE IF NOT EXISTS circle_drafts (
    id                  UUID PRIMARY KEY,
    chain_id            TEXT        NOT NULL,
    organizer_address   TEXT        NOT NULL,
    token               TEXT        NOT NULL,
    -- u128 base units. TEXT because a u128 does not fit a bigint and must
    -- never be rounded through a float.
    contribution_amount TEXT        NOT NULL,
    cadence_seconds     INTEGER     NOT NULL CHECK (cadence_seconds > 0),
    grace_seconds       INTEGER     NOT NULL CHECK (grace_seconds > 0),
    member_count        SMALLINT    NOT NULL CHECK (member_count BETWEEN 2 AND 32),
    -- draft -> ready (all slots accepted) -> created (on chain) -> abandoned
    status              TEXT        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'ready', 'created', 'abandoned')),
    -- Set only once the creating transaction is confirmed and the circle id is
    -- recovered from the CircleCreated event.
    circle_id           INTEGER,
    created_tx          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS circle_drafts_organizer_idx
    ON circle_drafts (organizer_address, created_at DESC);

-- One reserved place in a draft. The invite token is a coordination pointer,
-- not a credential: a member's identity is derived from their own wallet, so a
-- leaked token lets nobody impersonate anybody.
CREATE TABLE IF NOT EXISTS draft_slots (
    id                  UUID PRIMARY KEY,
    draft_id            UUID        NOT NULL REFERENCES circle_drafts (id) ON DELETE CASCADE,
    slot_index          SMALLINT    NOT NULL CHECK (slot_index >= 0),
    invite_token        TEXT        NOT NULL UNIQUE,
    -- Public commitment written to the contract. NULL until accepted.
    member_ref          TEXT,
    -- Public x-coordinate of the member's settlement key. Public by design.
    auth_public_key     TEXT,
    accepted_by_address TEXT,
    accepted_at         TIMESTAMPTZ,
    UNIQUE (draft_id, slot_index)
);

-- The same person must not be able to fill two slots in one circle, and the
-- same commitment must never appear twice in a payout order.
CREATE UNIQUE INDEX IF NOT EXISTS draft_slots_unique_member
    ON draft_slots (draft_id, member_ref) WHERE member_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS draft_slots_draft_idx ON draft_slots (draft_id, slot_index);

-- Public circle state, cached from view calls so the app can list circles
-- without a read storm. Authoritative source is always the chain.
CREATE TABLE IF NOT EXISTS indexed_circles (
    chain_id            TEXT        NOT NULL,
    circle_id           INTEGER     NOT NULL,
    contribution_amount TEXT        NOT NULL,
    token               TEXT        NOT NULL,
    member_limit        SMALLINT    NOT NULL,
    joined_count        SMALLINT    NOT NULL,
    current_round       INTEGER     NOT NULL,
    status              TEXT        NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, circle_id)
);

-- Public events emitted by IwaCircle. No amounts beyond what the contract
-- already publishes, and no private note data.
CREATE TABLE IF NOT EXISTS circle_events (
    id           BIGSERIAL PRIMARY KEY,
    chain_id     TEXT      NOT NULL,
    block_number BIGINT    NOT NULL,
    tx_hash      TEXT      NOT NULL,
    event_index  INTEGER   NOT NULL,
    event_name   TEXT      NOT NULL,
    circle_id    INTEGER,
    round        INTEGER,
    member_ref   TEXT,
    status       TEXT,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_id, tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS circle_events_circle_idx
    ON circle_events (chain_id, circle_id, round);

-- Where the indexer got to. Restarting mid-range must never skip a block.
CREATE TABLE IF NOT EXISTS sync_cursor (
    name         TEXT        PRIMARY KEY,
    chain_id     TEXT        NOT NULL,
    last_block   BIGINT      NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

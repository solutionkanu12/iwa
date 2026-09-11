-- Celo circle organizer authority: first-claim, then immutable.
--
-- Unlike circle_drafts.organizer_address (set once at draft creation, itself
-- an authenticated action), a Celo circle's identity is its deployed
-- contract address, chosen externally rather than issued by this backend.
-- There is no earlier authenticated moment to anchor organizer identity to,
-- so the first wallet to present a valid signed authorization for a given
-- circle_id is recorded as its organizer, and every later request for that
-- circle_id must be signed by that same wallet.
--
-- This is a coordination record, not an on-chain fact: it does not prove the
-- recorded wallet actually deployed IwaCircleCelo at circle_id. See
-- SECURITY.md's "Celo member/account binding" section for the accepted
-- residual gap and what would close it (on-chain deployment verification,
-- mirroring chainVerify.ts's Starknet pattern).
--
-- Immutable once written: there is no UPDATE statement anywhere in
-- Store/PgStore/MemoryStore for this table.

CREATE TABLE IF NOT EXISTS celo_circle_organizers (
    circle_id       TEXT        PRIMARY KEY,
    organizer       TEXT        NOT NULL,
    established_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

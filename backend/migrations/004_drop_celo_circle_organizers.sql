-- Removes the first-claim organizer-authority table.
--
-- Superseded: organizer authority for account-binding invites is now read
-- directly from IwaCircleCelo.organizer() on chain (see celoChainVerify.ts),
-- never from a backend-recorded claim. Keeping this table around risked it
-- being mistaken for, or reintroduced as, a substitute for the on-chain
-- read — the exact trust model this change replaces. A new migration drops
-- it rather than editing migration 003 in place, so the applied-migration
-- history stays an honest, append-only record of what actually happened.

DROP TABLE IF EXISTS celo_circle_organizers;

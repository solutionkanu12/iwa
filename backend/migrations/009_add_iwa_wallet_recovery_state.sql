-- Non-custodial recovery freshness coordination only.
--
-- This has no package, recovery code, encrypted vault data, passkey output,
-- password, PIN, seed, viewing key, or chain authority. It is solely the
-- latest non-secret generation reported after an in-browser verification.

ALTER TABLE iwa_wallet_setups
    ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'notConfigured'
        CHECK (recovery_status IN ('notConfigured', 'verified')),
    ADD COLUMN recovery_generation INTEGER NULL,
    ADD CONSTRAINT iwa_wallet_setups_recovery_generation_check CHECK (
        (recovery_status = 'notConfigured' AND recovery_generation IS NULL)
        OR
        (recovery_status = 'verified' AND recovery_generation IS NOT NULL AND recovery_generation >= 1)
    );

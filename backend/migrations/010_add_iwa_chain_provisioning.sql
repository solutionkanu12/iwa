-- Generic, forward-only chain-account coordination for the non-custodial
-- Iwa Wallet roadmap. This migration stores public Starknet account facts
-- only. The local vault remains the sole home for all authority material.

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_onboarding_step_check;

ALTER TABLE users
    ADD CONSTRAINT users_onboarding_step_check
    CHECK (onboarding_step IN ('profile', 'passwordPin', 'walletProvisioning', 'recovery', 'chainProvisioning', 'finish'));

ALTER TABLE iwa_wallet_setups
    ADD COLUMN chain_provisioning_stage TEXT NOT NULL DEFAULT 'notStarted'
        CHECK (chain_provisioning_stage IN ('notStarted', 'starknetAuthority', 'starknetDeployment')),
    ADD COLUMN starknet_network_id TEXT NULL,
    ADD COLUMN starknet_account_address TEXT NULL,
    ADD COLUMN starknet_public_key TEXT NULL,
    ADD COLUMN starknet_account_class_id TEXT NULL,
    ADD COLUMN starknet_account_class_hash TEXT NULL,
    ADD COLUMN starknet_descriptor_version INTEGER NULL,
    ADD CONSTRAINT iwa_wallet_setups_starknet_descriptor_check CHECK (
        (chain_provisioning_stage = 'notStarted'
            AND starknet_network_id IS NULL
            AND starknet_account_address IS NULL
            AND starknet_public_key IS NULL
            AND starknet_account_class_id IS NULL
            AND starknet_account_class_hash IS NULL
            AND starknet_descriptor_version IS NULL)
        OR
        (chain_provisioning_stage IN ('starknetAuthority', 'starknetDeployment')
            AND starknet_network_id IS NOT NULL
            AND starknet_account_address IS NOT NULL
            AND starknet_public_key IS NOT NULL
            AND starknet_account_class_id IS NOT NULL
            AND starknet_account_class_hash IS NOT NULL
            AND starknet_descriptor_version >= 1)
    );

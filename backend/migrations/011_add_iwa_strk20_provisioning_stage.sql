-- B2-B records one public-only completion marker after the local STRK20
-- private-state proof succeeds. It stores no protocol authority or state.

ALTER TABLE iwa_wallet_setups
    DROP CONSTRAINT IF EXISTS iwa_wallet_setups_chain_provisioning_stage_check;

ALTER TABLE iwa_wallet_setups
    ADD CONSTRAINT iwa_wallet_setups_chain_provisioning_stage_check
    CHECK (chain_provisioning_stage IN ('notStarted', 'starknetAuthority', 'starknetDeployment', 'strk20'));

ALTER TABLE iwa_wallet_setups
    DROP CONSTRAINT IF EXISTS iwa_wallet_setups_starknet_descriptor_check;

ALTER TABLE iwa_wallet_setups
    ADD CONSTRAINT iwa_wallet_setups_starknet_descriptor_check CHECK (
        (chain_provisioning_stage = 'notStarted'
            AND starknet_network_id IS NULL
            AND starknet_account_address IS NULL
            AND starknet_public_key IS NULL
            AND starknet_account_class_id IS NULL
            AND starknet_account_class_hash IS NULL
            AND starknet_descriptor_version IS NULL)
        OR
        (chain_provisioning_stage IN ('starknetAuthority', 'starknetDeployment', 'strk20')
            AND starknet_network_id IS NOT NULL
            AND starknet_account_address IS NOT NULL
            AND starknet_public_key IS NOT NULL
            AND starknet_account_class_id IS NOT NULL
            AND starknet_account_class_hash IS NOT NULL
            AND starknet_descriptor_version >= 1)
    );

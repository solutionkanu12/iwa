//! IwaCircle **V2** — circle, contribution, cure, payout accounting, and
//! **Candidate P private pot collection** (precommitted private destination).
//!
//! A minimal delta over `iwa_circle` (V1, immutable, UNTOUCHED): create / join /
//! contribution / default / cure / payout accounting / recovery accounting /
//! final settlement are the V1 rules verbatim. The ONLY behavioural change is
//! the payout and recovery **settlement** mechanism:
//!
//!   V1:  member signs an assembly-time `open_note_id` at settlement time
//!        (impossible to order safely in a browser — the A1 problem).
//!   V2:  the member REGISTERS a precommitted private destination note id +
//!        the exact state-derived amount BEFORE assembling the STRK20
//!        transaction (`register_payout_destination`, one member-auth-key
//!        signature, monotonic epoch, single-use nonce, expiry). Settlement
//!        carries NO signature and only checks `open_note_id == registered`.
//!
//! Invariants preserved from V1: locked payout order, immutable completed
//! history, exact per-round/per-token liability, member-controlled
//! authorization, no organizer/admin/backend financial power, no public ERC20
//! payout, fail-closed. New: destination substitution / stale epoch / stale or
//! expired authorization / nonce replay / double collect all fail closed and
//! leave pot + liability + accounting unchanged.

use starknet::ContractAddress;
use crate::iwa_types::{
    CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState, RoundLiability,
    SettlementConfig, SupportedAsset,
};
use crate::iwa_types_v2::{PayoutStateV2, RegisteredDestinationV2};

#[derive(Copy, Drop, Serde)]
pub struct CircleViewV2 {
    pub id: u32,
    pub asset: SupportedAsset,
    pub contribution_amount: u128,
    pub cadence_seconds: u64,
    pub grace_period_seconds: u64,
    pub member_limit: u8,
    pub current_round: u32,
    pub status: CircleStatus,
    pub created_at: u64,
    pub organizer: ContractAddress,
    pub payout_order_locked: bool,
    pub joined_count: u8,
}

#[starknet::interface]
pub trait IIwaCircleV2<TContractState> {
    fn create_circle(
        ref self: TContractState,
        token: ContractAddress,
        contribution_amount: u128,
        cadence_seconds: u64,
        grace_period_seconds: u64,
        member_limit: u8,
        payout_order: Span<felt252>,
    ) -> u32;
    fn get_circle(self: @TContractState, circle_id: u32) -> CircleViewV2;
    fn get_payout_order(self: @TContractState, circle_id: u32) -> Array<felt252>;
    fn get_cure_config(self: @TContractState, circle_id: u32) -> CureConfig;
    fn get_circle_contract(self: @TContractState) -> ContractAddress;

    fn join_circle(
        ref self: TContractState, circle_id: u32, invite_secret: felt252, auth_public_key: felt252,
    ) -> u8;
    fn is_member(self: @TContractState, circle_id: u32, member_ref: felt252) -> bool;
    fn get_member_auth_key(self: @TContractState, circle_id: u32, member_ref: felt252) -> felt252;

    fn get_contribution_obligation(
        self: @TContractState, circle_id: u32, round: u32, member_ref: felt252,
    ) -> ContributionObligation;
    fn is_contribution_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;

    fn get_settlement_config(self: @TContractState) -> SettlementConfig;
    fn initialize_settlement_helper(ref self: TContractState, helper: ContractAddress);
    fn get_round_liability(self: @TContractState, circle_id: u32, round: u32) -> RoundLiability;
    fn get_round_unresolved_deficit(self: @TContractState, circle_id: u32, round: u32) -> u128;
    fn get_token_outstanding_liability(self: @TContractState, token: ContractAddress) -> u256;

    fn settle_contribution_from_helper(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        amount: u128,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> ContributionStatus;
    fn finalize_contribution_default(
        ref self: TContractState, circle_id: u32, round: u32, member_ref: felt252,
    ) -> ContributionStatus;

    fn get_cure_state(
        self: @TContractState, circle_id: u32, round: u32, member_ref: felt252,
    ) -> CureState;
    fn is_cure_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    fn settle_cure_from_helper(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        amount: u128,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> CureState;

    fn get_payout_state_v2(self: @TContractState, circle_id: u32, round: u32) -> PayoutStateV2;
    fn finalize_round_payout_accounting(
        ref self: TContractState, circle_id: u32, round: u32,
    ) -> PayoutStateV2;

    // --- Candidate P: precommitted private destination -----------------------

    /// The scheduled member registers the STRK20 open-note id their wallet will
    /// create for the payout, plus the exact state-derived amount, a monotonic
    /// `dest_epoch`, an `expiry`, and a single-use `nonce`. Authenticated by
    /// one signature from the member's Iwa auth key over
    /// `iwa_types_v2::payout_dest_v2_hash(...)`. The amount and member are taken
    /// from circle state, never the caller. Moves the payout from `Scheduled`
    /// (or cured `DeferredLocked`) to `PrivateSettlementAuthorized`. A later
    /// registration with a strictly higher epoch rotates the destination (only
    /// before settlement).
    fn register_payout_destination(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        note_id: felt252,
        amount: u128,
        dest_epoch: u64,
        expiry: u64,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> PayoutStateV2;
    fn get_registered_payout_destination(
        self: @TContractState, circle_id: u32, round: u32,
    ) -> RegisteredDestinationV2;
    fn get_dest_epoch(self: @TContractState, circle_id: u32, member_ref: felt252) -> u64;
    fn is_dest_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    fn is_payout_privately_settled(self: @TContractState, circle_id: u32, round: u32) -> bool;

    /// Helper-only. Carries NO signature. Checks `open_note_id == registered`,
    /// derives the amount from state, requires status
    /// `PrivateSettlementAuthorized` and a not-yet-settled round and a
    /// non-expired authorization, debits the exact round liability, and sets
    /// status `PrivatelyPaid`. Any failure reverts the whole STRK20
    /// transaction, leaving pot + liability + accounting unchanged.
    fn settle_payout_from_helper_v2(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        open_note_id: felt252,
    ) -> PayoutStateV2;

    // --- recovery (same Candidate P mechanism) ------------------------------

    fn get_recovery_amount(self: @TContractState, circle_id: u32, round: u32) -> u128;
    fn register_recovery_destination(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        note_id: felt252,
        amount: u128,
        dest_epoch: u64,
        expiry: u64,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> PayoutStateV2;
    fn get_registered_recovery_destination(
        self: @TContractState, circle_id: u32, round: u32,
    ) -> RegisteredDestinationV2;
    fn settle_recovery_from_helper_v2(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        open_note_id: felt252,
    ) -> PayoutStateV2;

    fn is_final_settlement_prepared(self: @TContractState, circle_id: u32) -> bool;
    fn prepare_final_settlement(ref self: TContractState, circle_id: u32);
}

#[starknet::contract]
pub mod IwaCircleV2 {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::iwa_errors;
    use crate::iwa_events::{
        CircleActivated, CircleCreated, ContributionStateUpdated, CureAccountingSettled,
        MemberJoined, SettlementHelperInitialized,
    };
    use crate::iwa_events_v2::{
        FinalSettlementPreparedV2, PayoutAccountingPreparedV2, PrivateDestinationRegistered,
        PrivatelySettled,
    };
    use crate::iwa_types::{
        CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState,
        RoundLiability, SettlementConfig, SupportedAsset, invite_commitment,
        is_valid_auth_public_key, locked_cure_config, verify_contribution_settlement_authorization,
        verify_cure_settlement_authorization,
    };
    use crate::iwa_types_v2::{
        PayoutStateV2, PayoutStatusV2, RegisteredDestinationV2, errors_v2, payout_dest_v2_hash,
        recovery_dest_v2_hash, verify_dest_v2_signature,
    };
    use super::{CircleViewV2, IIwaCircleV2};

    const MAX_MEMBER_LIMIT: u8 = 32;
    const U128_MAX: u256 = 0xffffffffffffffffffffffffffffffff;

    #[derive(Copy, Drop, starknet::Store)]
    struct CircleRecord {
        asset: SupportedAsset,
        contribution_amount: u128,
        cadence_seconds: u64,
        grace_period_seconds: u64,
        member_limit: u8,
        current_round: u32,
        status: CircleStatus,
        created_at: u64,
        organizer: ContractAddress,
        cure: CureConfig,
        payout_order_locked: bool,
        joined_count: u8,
    }

    #[storage]
    struct Storage {
        usdc: ContractAddress,
        strk: ContractAddress,
        settlement_helper: ContractAddress,
        privacy_pool: ContractAddress,
        setup_authority: ContractAddress,
        helper_initialized: bool,
        next_circle_id: u32,
        exists: Map<u32, bool>,
        circles: Map<u32, CircleRecord>,
        payout_order: Map<(u32, u8), felt252>,
        payout_order_len: Map<u32, u8>,
        joined: Map<(u32, felt252), bool>,
        member_auth_keys: Map<(u32, felt252), felt252>,
        obligation_exists: Map<(u32, u32, felt252), bool>,
        obligations: Map<(u32, u32, felt252), ContributionObligation>,
        contribution_nonces: Map<(u32, felt252, felt252), bool>,
        cured_deficits: Map<(u32, u32, felt252), bool>,
        cure_nonces: Map<(u32, felt252, felt252), bool>,
        cure_windows_closed: Map<(u32, u32, felt252), bool>,
        payout_exists: Map<(u32, u32), bool>,
        payout_states: Map<(u32, u32), PayoutStateV2>,
        final_settlement_prepared: Map<u32, bool>,
        round_settled_inflows: Map<(u32, u32), u256>,
        round_settled_outflows: Map<(u32, u32), u256>,
        round_outstanding_liability: Map<(u32, u32), u256>,
        recovery_amounts: Map<(u32, u32), u128>,
        recovery_amount_exists: Map<(u32, u32), bool>,
        token_outstanding_liability: Map<ContractAddress, u256>,
        // --- Candidate P destination registry ---
        payout_dest: Map<(u32, u32), RegisteredDestinationV2>,
        recovery_dest: Map<(u32, u32), RegisteredDestinationV2>,
        dest_epoch: Map<(u32, felt252), u64>,
        dest_nonces: Map<(u32, felt252, felt252), bool>,
        payout_privately_settled: Map<(u32, u32), bool>,
        recovery_privately_settled: Map<(u32, u32), bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        CircleCreated: CircleCreated,
        MemberJoined: MemberJoined,
        CircleActivated: CircleActivated,
        ContributionStateUpdated: ContributionStateUpdated,
        CureAccountingSettled: CureAccountingSettled,
        SettlementHelperInitialized: SettlementHelperInitialized,
        PayoutAccountingPreparedV2: PayoutAccountingPreparedV2,
        PrivateDestinationRegistered: PrivateDestinationRegistered,
        PrivatelySettled: PrivatelySettled,
        FinalSettlementPreparedV2: FinalSettlementPreparedV2,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        usdc: ContractAddress,
        strk: ContractAddress,
        privacy_pool: ContractAddress,
        setup_authority: ContractAddress,
    ) {
        assert(!usdc.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(!strk.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(!privacy_pool.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(!setup_authority.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(usdc != strk, iwa_errors::INVALID_CONFIG);
        self.usdc.write(usdc);
        self.strk.write(strk);
        self.privacy_pool.write(privacy_pool);
        self.setup_authority.write(setup_authority);
    }

    #[abi(embed_v0)]
    impl IwaCircleV2Impl of IIwaCircleV2<ContractState> {
        fn create_circle(
            ref self: ContractState,
            token: ContractAddress,
            contribution_amount: u128,
            cadence_seconds: u64,
            grace_period_seconds: u64,
            member_limit: u8,
            payout_order: Span<felt252>,
        ) -> u32 {
            let asset = self.resolve_asset(token);
            assert(contribution_amount > 0, iwa_errors::INVALID_CONFIG);
            assert(
                member_limit >= 2 && member_limit <= MAX_MEMBER_LIMIT, iwa_errors::INVALID_CONFIG,
            );
            assert(cadence_seconds > 0, iwa_errors::INVALID_CONFIG);
            assert(grace_period_seconds > 0, iwa_errors::INVALID_CONFIG);
            validate_payout_order(payout_order, member_limit);
            let member_count: u128 = member_limit.into();
            let scheduled_payout_amount: u256 = contribution_amount.into() * member_count.into();
            assert(scheduled_payout_amount <= U128_MAX, iwa_errors::INVALID_CONFIG);

            let id = self.next_circle_id.read() + 1;
            self.next_circle_id.write(id);

            let record = CircleRecord {
                asset,
                contribution_amount,
                cadence_seconds,
                grace_period_seconds,
                member_limit,
                current_round: 1,
                status: CircleStatus::OpenForMembers,
                created_at: get_block_timestamp(),
                organizer: get_caller_address(),
                cure: locked_cure_config(),
                payout_order_locked: true,
                joined_count: 0,
            };
            self.circles.write(id, record);
            self.exists.write(id, true);
            self.store_payout_order(id, payout_order, member_limit);
            self.emit(CircleCreated { circle_id: id, asset, contribution_amount, member_limit });
            id
        }

        fn get_circle(self: @ContractState, circle_id: u32) -> CircleViewV2 {
            let r = self.read_record(circle_id);
            CircleViewV2 {
                id: circle_id,
                asset: r.asset,
                contribution_amount: r.contribution_amount,
                cadence_seconds: r.cadence_seconds,
                grace_period_seconds: r.grace_period_seconds,
                member_limit: r.member_limit,
                current_round: r.current_round,
                status: r.status,
                created_at: r.created_at,
                organizer: r.organizer,
                payout_order_locked: r.payout_order_locked,
                joined_count: r.joined_count,
            }
        }

        fn get_payout_order(self: @ContractState, circle_id: u32) -> Array<felt252> {
            self.assert_exists(circle_id);
            let len = self.payout_order_len.read(circle_id);
            let mut order = array![];
            let mut slot: u8 = 0;
            while slot < len {
                order.append(self.payout_order.read((circle_id, slot)));
                slot += 1;
            }
            order
        }

        fn get_cure_config(self: @ContractState, circle_id: u32) -> CureConfig {
            self.read_record(circle_id).cure
        }

        fn get_circle_contract(self: @ContractState) -> ContractAddress {
            get_contract_address()
        }

        fn join_circle(
            ref self: ContractState,
            circle_id: u32,
            invite_secret: felt252,
            auth_public_key: felt252,
        ) -> u8 {
            let mut record = self.read_record(circle_id);
            assert(record.status == CircleStatus::OpenForMembers, iwa_errors::JOIN_CLOSED);
            assert(invite_secret != 0, iwa_errors::INVALID_CONFIG);
            assert(is_valid_auth_public_key(auth_public_key), iwa_errors::INVALID_AUTH_KEY);
            let member_ref = invite_commitment(invite_secret, auth_public_key);
            let slot = self.find_invite_slot(circle_id, member_ref);
            assert(!self.joined.read((circle_id, member_ref)), iwa_errors::ALREADY_MEMBER);
            assert(record.joined_count < record.member_limit, iwa_errors::CIRCLE_FULL);

            self.joined.write((circle_id, member_ref), true);
            self.member_auth_keys.write((circle_id, member_ref), auth_public_key);
            record.joined_count += 1;
            let activating = record.joined_count == record.member_limit;
            if activating {
                record.status = CircleStatus::Active;
                self.create_round_obligations(circle_id, record, get_block_timestamp());
            }
            self.circles.write(circle_id, record);
            self.emit(MemberJoined { circle_id, member_ref, slot });
            if activating {
                self.emit(CircleActivated { circle_id });
            }
            slot
        }

        fn is_member(self: @ContractState, circle_id: u32, member_ref: felt252) -> bool {
            self.assert_exists(circle_id);
            self.joined.read((circle_id, member_ref))
        }

        fn get_member_auth_key(
            self: @ContractState, circle_id: u32, member_ref: felt252,
        ) -> felt252 {
            self.assert_exists(circle_id);
            assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);
            self.member_auth_keys.read((circle_id, member_ref))
        }

        fn get_contribution_obligation(
            self: @ContractState, circle_id: u32, round: u32, member_ref: felt252,
        ) -> ContributionObligation {
            self.assert_exists(circle_id);
            let key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(key), iwa_errors::OBLIGATION_NOT_FOUND);
            self.obligations.read(key)
        }

        fn is_contribution_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.contribution_nonces.read((circle_id, member_ref, nonce))
        }

        fn get_settlement_config(self: @ContractState) -> SettlementConfig {
            SettlementConfig {
                settlement_helper: self.settlement_helper.read(),
                privacy_pool: self.privacy_pool.read(),
                setup_authority: self.setup_authority.read(),
                helper_initialized: self.helper_initialized.read(),
            }
        }

        fn initialize_settlement_helper(ref self: ContractState, helper: ContractAddress) {
            assert(!self.helper_initialized.read(), iwa_errors::HELPER_ALREADY_INITIALIZED);
            assert(get_caller_address() == self.setup_authority.read(), iwa_errors::UNAUTHORIZED);
            assert(!helper.is_zero(), iwa_errors::INVALID_CONFIG);
            self.settlement_helper.write(helper);
            self.helper_initialized.write(true);
            self.setup_authority.write(Zero::zero());
            self.emit(SettlementHelperInitialized { helper });
        }

        fn get_round_liability(self: @ContractState, circle_id: u32, round: u32) -> RoundLiability {
            let record = self.read_record(circle_id);
            let final_round: u32 = record.member_limit.into();
            assert(round > 0 && round <= final_round, iwa_errors::WRONG_ROUND);
            RoundLiability {
                circle_id,
                round,
                token: self.token_for_asset(record.asset),
                settled_inflows: self.round_settled_inflows.read((circle_id, round)),
                settled_outflows: self.round_settled_outflows.read((circle_id, round)),
                outstanding: self.round_outstanding_liability.read((circle_id, round)),
            }
        }

        fn get_round_unresolved_deficit(self: @ContractState, circle_id: u32, round: u32) -> u128 {
            let record = self.read_record(circle_id);
            let final_round: u32 = record.member_limit.into();
            assert(round > 0 && round <= final_round, iwa_errors::WRONG_ROUND);
            self.calculate_round_unresolved_deficit(circle_id, round, record.member_limit)
        }

        fn get_token_outstanding_liability(self: @ContractState, token: ContractAddress) -> u256 {
            let _asset = self.resolve_asset(token);
            self.token_outstanding_liability.read(token)
        }

        fn settle_contribution_from_helper(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            amount: u128,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> ContributionStatus {
            self.assert_settlement_helper();
            let record = self.read_record(circle_id);
            assert(record.status == CircleStatus::Active, iwa_errors::WRONG_ROUND);
            assert(round == record.current_round, iwa_errors::WRONG_ROUND);
            assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            assert(amount == record.contribution_amount, iwa_errors::WRONG_AMOUNT);

            let obligation_key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND);
            let mut obligation = self.obligations.read(obligation_key);
            let nonce_key = (circle_id, member_ref, nonce);
            assert(!self.contribution_nonces.read(nonce_key), iwa_errors::NONCE_USED);
            assert(obligation.status == ContributionStatus::Pending, iwa_errors::ALREADY_SATISFIED);

            let auth_key = self.member_auth_keys.read((circle_id, member_ref));
            assert(
                verify_contribution_settlement_authorization(
                    auth_key,
                    circle_id,
                    round,
                    member_ref,
                    self.settlement_helper.read(),
                    self.privacy_pool.read(),
                    token,
                    record.contribution_amount,
                    nonce,
                    signature_r,
                    signature_s,
                ),
                iwa_errors::INVALID_SIGNATURE,
            );

            let now = get_block_timestamp();
            let status = if now <= obligation.due_at {
                ContributionStatus::OnTime
            } else {
                assert(now <= obligation.grace_ends_at, iwa_errors::CONTRIBUTION_WINDOW_CLOSED);
                ContributionStatus::LateWithinGrace
            };

            obligation.status = status;
            self.obligations.write(obligation_key, obligation);
            self.contribution_nonces.write(nonce_key, true);
            self.credit_round_liability(circle_id, round, record.contribution_amount);
            self.emit(ContributionStateUpdated { circle_id, round, member_ref, status });
            status
        }

        fn finalize_contribution_default(
            ref self: ContractState, circle_id: u32, round: u32, member_ref: felt252,
        ) -> ContributionStatus {
            self.assert_exists(circle_id);
            let key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(key), iwa_errors::OBLIGATION_NOT_FOUND);
            let mut obligation = self.obligations.read(key);
            assert(obligation.status == ContributionStatus::Pending, iwa_errors::HISTORY_IMMUTABLE);
            assert(get_block_timestamp() > obligation.grace_ends_at, iwa_errors::GRACE_NOT_EXPIRED);
            obligation.status = ContributionStatus::MissedDefault;
            self.obligations.write(key, obligation);
            self
                .emit(
                    ContributionStateUpdated {
                        circle_id, round, member_ref, status: ContributionStatus::MissedDefault,
                    },
                );
            ContributionStatus::MissedDefault
        }

        fn get_cure_state(
            self: @ContractState, circle_id: u32, round: u32, member_ref: felt252,
        ) -> CureState {
            self.assert_exists(circle_id);
            let obligation_key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND);
            let obligation = self.obligations.read(obligation_key);
            CureState {
                circle_id,
                round,
                member_ref,
                deficit_amount: obligation.required_amount,
                deficit_settled: self.cured_deficits.read(obligation_key),
                window_open: !self.cure_windows_closed.read(obligation_key),
            }
        }

        fn is_cure_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.cure_nonces.read((circle_id, member_ref, nonce))
        }

        fn settle_cure_from_helper(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            amount: u128,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> CureState {
            self.assert_settlement_helper();
            self.assert_exists(circle_id);
            let obligation_key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND);
            let obligation = self.obligations.read(obligation_key);
            assert(
                obligation.status == ContributionStatus::MissedDefault,
                iwa_errors::CURE_NOT_ELIGIBLE,
            );
            assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);
            let record = self.read_record(circle_id);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            assert(amount == obligation.required_amount, iwa_errors::WRONG_AMOUNT);

            let nonce_key = (circle_id, member_ref, nonce);
            assert(!self.cure_nonces.read(nonce_key), iwa_errors::CURE_NONCE_USED);
            assert(!self.cured_deficits.read(obligation_key), iwa_errors::ALREADY_CURED);
            assert(!self.cure_windows_closed.read(obligation_key), iwa_errors::CURE_WINDOW_CLOSED);

            let auth_key = self.member_auth_keys.read((circle_id, member_ref));
            assert(
                verify_cure_settlement_authorization(
                    auth_key,
                    circle_id,
                    round,
                    member_ref,
                    self.settlement_helper.read(),
                    self.privacy_pool.read(),
                    token,
                    obligation.required_amount,
                    nonce,
                    signature_r,
                    signature_s,
                ),
                iwa_errors::INVALID_SIGNATURE,
            );

            self.cured_deficits.write(obligation_key, true);
            self.cure_nonces.write(nonce_key, true);
            self.credit_round_liability(circle_id, round, obligation.required_amount);
            self.emit(CureAccountingSettled { circle_id, round, member_ref });
            CureState {
                circle_id,
                round,
                member_ref,
                deficit_amount: obligation.required_amount,
                deficit_settled: true,
                window_open: true,
            }
        }

        fn get_payout_state_v2(self: @ContractState, circle_id: u32, round: u32) -> PayoutStateV2 {
            self.assert_exists(circle_id);
            let key = (circle_id, round);
            assert(self.payout_exists.read(key), iwa_errors::PAYOUT_LOCKED);
            self.payout_states.read(key)
        }

        fn finalize_round_payout_accounting(
            ref self: ContractState, circle_id: u32, round: u32,
        ) -> PayoutStateV2 {
            let mut record = self.read_record(circle_id);
            let payout_key = (circle_id, round);
            assert(!self.payout_exists.read(payout_key), iwa_errors::PAYOUT_ALREADY_PREPARED);
            assert(record.status == CircleStatus::Active, iwa_errors::WRONG_ROUND);
            assert(round == record.current_round, iwa_errors::WRONG_ROUND);

            let mut slot: u8 = 0;
            while slot < record.member_limit {
                let member_ref = self.payout_order.read((circle_id, slot));
                let obligation_key = (circle_id, round, member_ref);
                assert(
                    self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND,
                );
                assert(
                    self.obligations.read(obligation_key).status != ContributionStatus::Pending,
                    iwa_errors::ROUND_NOT_READY,
                );
                slot += 1;
            }

            let recipient_slot: u8 = (round - 1).try_into().unwrap();
            assert(recipient_slot < record.member_limit, iwa_errors::WRONG_ROUND);
            let scheduled_member_ref = self.payout_order.read((circle_id, recipient_slot));
            let round_unresolved_deficit = self
                .calculate_round_unresolved_deficit(circle_id, round, record.member_limit);
            let member_count: u128 = record.member_limit.into();
            let scheduled_payout_amount = record.contribution_amount * member_count;
            assert(
                round_unresolved_deficit <= scheduled_payout_amount, iwa_errors::LIABILITY_INVARIANT,
            );
            let funded_amount: u256 = (scheduled_payout_amount - round_unresolved_deficit).into();
            assert(
                self.round_outstanding_liability.read((circle_id, round)) == funded_amount,
                iwa_errors::LIABILITY_INVARIANT,
            );
            let status = if round_unresolved_deficit > 0 {
                PayoutStatusV2::DeferredLocked
            } else {
                PayoutStatusV2::Scheduled
            };
            let payout = PayoutStateV2 {
                circle_id, round, scheduled_member_ref, amount: scheduled_payout_amount, status,
            };
            self.payout_states.write(payout_key, payout);
            self.payout_exists.write(payout_key, true);
            self
                .emit(
                    PayoutAccountingPreparedV2 {
                        circle_id, round, scheduled_member_ref, status,
                    },
                );

            if round < record.member_limit.into() {
                record.current_round += 1;
                self.create_round_obligations(circle_id, record, get_block_timestamp());
                self.circles.write(circle_id, record);
            }
            payout
        }

        // ----- Candidate P: destination registration + settlement -----------

        fn register_payout_destination(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            note_id: felt252,
            amount: u128,
            dest_epoch: u64,
            expiry: u64,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> PayoutStateV2 {
            self.assert_exists(circle_id);
            assert(note_id != 0, errors_v2::DEST_ZERO_NOTE);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);

            let record = self.read_record(circle_id);
            let is_scheduled = payout.status == PayoutStatusV2::Scheduled;
            let is_cured_deferred = payout.status == PayoutStatusV2::DeferredLocked
                && self
                    .calculate_round_unresolved_deficit(
                        circle_id, round, record.member_limit,
                    ) == 0;
            let is_reregister = payout.status == PayoutStatusV2::PrivateSettlementAuthorized;
            assert(
                is_scheduled || is_cured_deferred || is_reregister,
                iwa_errors::PAYOUT_NOT_AUTHORIZABLE,
            );
            assert(
                !self.payout_privately_settled.read(payout_key), errors_v2::ALREADY_PRIVATELY_PAID,
            );
            assert(amount == payout.amount, iwa_errors::WRONG_AMOUNT);

            let member_ref = payout.scheduled_member_ref;
            let token = self.token_for_asset(record.asset);
            self
                .consume_destination_registration(
                    false, circle_id, round, member_ref, token, note_id, amount, dest_epoch,
                    expiry, nonce, signature_r, signature_s,
                );

            payout.status = PayoutStatusV2::PrivateSettlementAuthorized;
            self.payout_states.write(payout_key, payout);
            payout
        }

        fn get_registered_payout_destination(
            self: @ContractState, circle_id: u32, round: u32,
        ) -> RegisteredDestinationV2 {
            self.assert_exists(circle_id);
            let d = self.payout_dest.read((circle_id, round));
            assert(d.note_id != 0, errors_v2::DEST_NOT_REGISTERED);
            d
        }

        fn get_dest_epoch(self: @ContractState, circle_id: u32, member_ref: felt252) -> u64 {
            self.assert_exists(circle_id);
            self.dest_epoch.read((circle_id, member_ref))
        }

        fn is_dest_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.dest_nonces.read((circle_id, member_ref, nonce))
        }

        fn is_payout_privately_settled(
            self: @ContractState, circle_id: u32, round: u32,
        ) -> bool {
            self.assert_exists(circle_id);
            self.payout_privately_settled.read((circle_id, round))
        }

        fn settle_payout_from_helper_v2(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            open_note_id: felt252,
        ) -> PayoutStateV2 {
            self.assert_settlement_helper();
            assert(open_note_id != 0, iwa_errors::INVALID_OPEN_NOTE);
            let record = self.read_record(circle_id);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);
            assert(
                payout.status == PayoutStatusV2::PrivateSettlementAuthorized,
                errors_v2::PAYOUT_NOT_AUTHORIZED,
            );
            assert(
                !self.payout_privately_settled.read(payout_key), errors_v2::ALREADY_PRIVATELY_PAID,
            );
            assert(member_ref == payout.scheduled_member_ref, iwa_errors::NOT_MEMBER);
            assert(
                self.calculate_round_unresolved_deficit(circle_id, round, record.member_limit) == 0,
                iwa_errors::PAYOUT_LOCKED,
            );

            let d = self.payout_dest.read(payout_key);
            assert(d.note_id != 0, errors_v2::DEST_NOT_REGISTERED);
            assert(open_note_id == d.note_id, errors_v2::DEST_MISMATCH);
            assert(d.amount == payout.amount, iwa_errors::WRONG_AMOUNT);
            assert(get_block_timestamp() <= d.expiry, errors_v2::DEST_EXPIRED);
            self.assert_round_can_debit(circle_id, round, payout.amount);

            payout.status = PayoutStatusV2::PrivatelyPaid;
            self.payout_states.write(payout_key, payout);
            self.payout_privately_settled.write(payout_key, true);
            self.debit_round_liability(circle_id, round, payout.amount);
            self
                .emit(
                    PrivatelySettled {
                        circle_id,
                        round,
                        scheduled_member_ref: member_ref,
                        amount: payout.amount,
                        is_recovery: false,
                    },
                );
            payout
        }

        // ----- recovery (same mechanism) -----------------------------------

        fn get_recovery_amount(self: @ContractState, circle_id: u32, round: u32) -> u128 {
            self.assert_exists(circle_id);
            assert(
                self.recovery_amount_exists.read((circle_id, round)),
                iwa_errors::RECOVERY_NOT_READY,
            );
            self.recovery_amounts.read((circle_id, round))
        }

        fn register_recovery_destination(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            note_id: felt252,
            amount: u128,
            dest_epoch: u64,
            expiry: u64,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> PayoutStateV2 {
            self.assert_exists(circle_id);
            assert(note_id != 0, errors_v2::DEST_ZERO_NOTE);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);
            assert(
                payout.status == PayoutStatusV2::RecoveryPending, iwa_errors::RECOVERY_NOT_READY,
            );
            assert(
                self.recovery_amount_exists.read(payout_key), iwa_errors::RECOVERY_NOT_READY,
            );
            assert(
                !self.recovery_privately_settled.read(payout_key),
                errors_v2::ALREADY_PRIVATELY_RECOVERED,
            );
            let recovery_amount = self.recovery_amounts.read(payout_key);
            assert(amount == recovery_amount, iwa_errors::WRONG_AMOUNT);

            let record = self.read_record(circle_id);
            let member_ref = payout.scheduled_member_ref;
            let token = self.token_for_asset(record.asset);
            self
                .consume_destination_registration(
                    true, circle_id, round, member_ref, token, note_id, amount, dest_epoch, expiry,
                    nonce, signature_r, signature_s,
                );
            // status stays RecoveryPending; the destination flag gates settlement
            payout
        }

        fn get_registered_recovery_destination(
            self: @ContractState, circle_id: u32, round: u32,
        ) -> RegisteredDestinationV2 {
            self.assert_exists(circle_id);
            let d = self.recovery_dest.read((circle_id, round));
            assert(d.note_id != 0, errors_v2::DEST_NOT_REGISTERED);
            d
        }

        fn settle_recovery_from_helper_v2(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            open_note_id: felt252,
        ) -> PayoutStateV2 {
            self.assert_settlement_helper();
            assert(open_note_id != 0, iwa_errors::INVALID_OPEN_NOTE);
            let record = self.read_record(circle_id);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);
            assert(
                payout.status == PayoutStatusV2::RecoveryPending,
                errors_v2::RECOVERY_NOT_AUTHORIZED,
            );
            assert(
                !self.recovery_privately_settled.read(payout_key),
                errors_v2::ALREADY_PRIVATELY_RECOVERED,
            );
            assert(member_ref == payout.scheduled_member_ref, iwa_errors::NOT_MEMBER);
            assert(self.recovery_amount_exists.read(payout_key), iwa_errors::RECOVERY_NOT_READY);
            let recovery_amount = self.recovery_amounts.read(payout_key);

            let d = self.recovery_dest.read(payout_key);
            assert(d.note_id != 0, errors_v2::DEST_NOT_REGISTERED);
            assert(open_note_id == d.note_id, errors_v2::DEST_MISMATCH);
            assert(d.amount == recovery_amount, iwa_errors::WRONG_AMOUNT);
            assert(get_block_timestamp() <= d.expiry, errors_v2::DEST_EXPIRED);
            self.assert_round_can_debit(circle_id, round, recovery_amount);

            payout.status = PayoutStatusV2::PrivatelyRecovered;
            self.payout_states.write(payout_key, payout);
            self.recovery_privately_settled.write(payout_key, true);
            self.debit_round_liability(circle_id, round, recovery_amount);
            self
                .emit(
                    PrivatelySettled {
                        circle_id,
                        round,
                        scheduled_member_ref: member_ref,
                        amount: recovery_amount,
                        is_recovery: true,
                    },
                );
            payout
        }

        fn is_final_settlement_prepared(self: @ContractState, circle_id: u32) -> bool {
            self.assert_exists(circle_id);
            self.final_settlement_prepared.read(circle_id)
        }

        fn prepare_final_settlement(ref self: ContractState, circle_id: u32) {
            let mut record = self.read_record(circle_id);
            assert(
                !self.final_settlement_prepared.read(circle_id), iwa_errors::FINAL_ALREADY_PREPARED,
            );
            assert(record.status == CircleStatus::Active, iwa_errors::FINAL_NOT_READY);
            let final_round: u32 = record.member_limit.into();
            assert(self.payout_exists.read((circle_id, final_round)), iwa_errors::FINAL_NOT_READY);

            // Preflight: a Scheduled or PrivateSettlementAuthorized payout is a
            // live rightful claim and cannot be silently converted to recovery.
            let mut round: u32 = 1;
            while round <= final_round {
                let payout = self.payout_states.read((circle_id, round));
                if payout.status == PayoutStatusV2::Scheduled
                    || payout.status == PayoutStatusV2::PrivateSettlementAuthorized {
                    core::panic_with_felt252(iwa_errors::FINAL_NOT_READY);
                }
                if payout.status == PayoutStatusV2::DeferredLocked {
                    assert(
                        self
                            .calculate_round_unresolved_deficit(
                                circle_id, round, record.member_limit,
                            ) > 0,
                        iwa_errors::FINAL_NOT_READY,
                    );
                } else {
                    assert(
                        payout.status == PayoutStatusV2::PrivatelyPaid
                            || payout.status == PayoutStatusV2::RecoveryPending
                            || payout.status == PayoutStatusV2::PrivatelyRecovered
                            || payout.status == PayoutStatusV2::NoFundedRecovery,
                        iwa_errors::FINAL_NOT_READY,
                    );
                }
                round += 1;
            }

            round = 1;
            while round <= final_round {
                let payout_key = (circle_id, round);
                let mut payout = self.payout_states.read(payout_key);
                if payout.status == PayoutStatusV2::DeferredLocked {
                    let unresolved = self
                        .calculate_round_unresolved_deficit(circle_id, round, record.member_limit);
                    assert(unresolved <= payout.amount, iwa_errors::LIABILITY_INVARIANT);
                    let recovery_amount = payout.amount - unresolved;
                    assert(
                        self
                            .round_outstanding_liability
                            .read(payout_key) == recovery_amount.into(),
                        iwa_errors::LIABILITY_INVARIANT,
                    );
                    assert(
                        !self.recovery_amount_exists.read(payout_key),
                        iwa_errors::RECOVERY_ALREADY_PREPARED,
                    );
                    self.recovery_amounts.write(payout_key, recovery_amount);
                    self.recovery_amount_exists.write(payout_key, true);
                    payout
                        .status =
                            if recovery_amount == 0 {
                                PayoutStatusV2::NoFundedRecovery
                            } else {
                                PayoutStatusV2::RecoveryPending
                            };
                    self.payout_states.write(payout_key, payout);
                }
                let mut slot: u8 = 0;
                while slot < record.member_limit {
                    let member_ref = self.payout_order.read((circle_id, slot));
                    let obligation_key = (circle_id, round, member_ref);
                    if self
                        .obligations
                        .read(obligation_key)
                        .status == ContributionStatus::MissedDefault {
                        self.cure_windows_closed.write(obligation_key, true);
                    }
                    slot += 1;
                }
                round += 1;
            }

            record.status = CircleStatus::SettlementPending;
            self.circles.write(circle_id, record);
            self.final_settlement_prepared.write(circle_id, true);
            self.emit(FinalSettlementPreparedV2 { circle_id });
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_settlement_helper(self: @ContractState) {
            assert(self.helper_initialized.read(), iwa_errors::HELPER_NOT_INITIALIZED);
            let helper = self.settlement_helper.read();
            assert(!helper.is_zero(), iwa_errors::HELPER_NOT_INITIALIZED);
            assert(get_caller_address() == helper, iwa_errors::NOT_SETTLEMENT_HELPER);
        }

        /// Verifies the member-auth-key signature over the destination hash,
        /// enforces monotonic epoch + single-use nonce, and records the
        /// registered destination. Shared by payout and recovery. Every check
        /// precedes every write; revert atomicity rolls all of them back.
        fn consume_destination_registration(
            ref self: ContractState,
            is_recovery: bool,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            note_id: felt252,
            amount: u128,
            dest_epoch: u64,
            expiry: u64,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            assert(get_block_timestamp() <= expiry, errors_v2::DEST_EXPIRED);
            assert(
                dest_epoch > self.dest_epoch.read((circle_id, member_ref)),
                errors_v2::DEST_STALE_EPOCH,
            );
            let nonce_key = (circle_id, member_ref, nonce);
            assert(!self.dest_nonces.read(nonce_key), errors_v2::DEST_NONCE_USED);

            let auth_key = self.member_auth_keys.read((circle_id, member_ref));
            let helper = self.settlement_helper.read();
            let pool = self.privacy_pool.read();
            let circle_contract = get_contract_address();
            let hash = if is_recovery {
                recovery_dest_v2_hash(
                    circle_contract, helper, pool, token, circle_id, round, member_ref, note_id,
                    amount, dest_epoch, expiry, nonce,
                )
            } else {
                payout_dest_v2_hash(
                    circle_contract, helper, pool, token, circle_id, round, member_ref, note_id,
                    amount, dest_epoch, expiry, nonce,
                )
            };
            assert(
                verify_dest_v2_signature(auth_key, hash, signature_r, signature_s),
                iwa_errors::INVALID_SIGNATURE,
            );

            self.dest_epoch.write((circle_id, member_ref), dest_epoch);
            self.dest_nonces.write(nonce_key, true);
            let dest = RegisteredDestinationV2 { note_id, amount, dest_epoch, expiry };
            if is_recovery {
                self.recovery_dest.write((circle_id, round), dest);
            } else {
                self.payout_dest.write((circle_id, round), dest);
            }
            self
                .emit(
                    PrivateDestinationRegistered {
                        circle_id, round, scheduled_member_ref: member_ref, dest_epoch, is_recovery,
                    },
                );
        }

        fn token_for_asset(self: @ContractState, asset: SupportedAsset) -> ContractAddress {
            match asset {
                SupportedAsset::Usdc => self.usdc.read(),
                SupportedAsset::Strk => self.strk.read(),
            }
        }

        fn calculate_round_unresolved_deficit(
            self: @ContractState, circle_id: u32, round: u32, member_limit: u8,
        ) -> u128 {
            let mut unresolved: u128 = 0;
            let mut slot: u8 = 0;
            while slot < member_limit {
                let member_ref = self.payout_order.read((circle_id, slot));
                let key = (circle_id, round, member_ref);
                assert(self.obligation_exists.read(key), iwa_errors::OBLIGATION_NOT_FOUND);
                let obligation = self.obligations.read(key);
                if obligation.status == ContributionStatus::MissedDefault
                    && !self.cured_deficits.read(key) {
                    unresolved += obligation.required_amount;
                }
                slot += 1;
            }
            unresolved
        }

        fn credit_round_liability(
            ref self: ContractState, circle_id: u32, round: u32, amount: u128,
        ) {
            let key = (circle_id, round);
            let amount_u256: u256 = amount.into();
            let token = self.token_for_asset(self.read_record(circle_id).asset);
            self
                .round_settled_inflows
                .write(key, self.round_settled_inflows.read(key) + amount_u256);
            self
                .round_outstanding_liability
                .write(key, self.round_outstanding_liability.read(key) + amount_u256);
            self
                .token_outstanding_liability
                .write(token, self.token_outstanding_liability.read(token) + amount_u256);
        }

        fn assert_round_can_debit(self: @ContractState, circle_id: u32, round: u32, amount: u128) {
            let amount_u256: u256 = amount.into();
            assert(
                self.round_outstanding_liability.read((circle_id, round)) >= amount_u256,
                iwa_errors::LIABILITY_INVARIANT,
            );
        }

        fn debit_round_liability(
            ref self: ContractState, circle_id: u32, round: u32, amount: u128,
        ) {
            let key = (circle_id, round);
            let amount_u256: u256 = amount.into();
            let outstanding = self.round_outstanding_liability.read(key);
            let token = self.token_for_asset(self.read_record(circle_id).asset);
            let token_outstanding = self.token_outstanding_liability.read(token);
            assert(outstanding >= amount_u256, iwa_errors::LIABILITY_INVARIANT);
            assert(token_outstanding >= amount_u256, iwa_errors::LIABILITY_INVARIANT);
            self
                .round_settled_outflows
                .write(key, self.round_settled_outflows.read(key) + amount_u256);
            self.round_outstanding_liability.write(key, outstanding - amount_u256);
            self.token_outstanding_liability.write(token, token_outstanding - amount_u256);
        }

        fn resolve_asset(self: @ContractState, token: ContractAddress) -> SupportedAsset {
            if token == self.usdc.read() {
                return SupportedAsset::Usdc;
            }
            if token == self.strk.read() {
                return SupportedAsset::Strk;
            }
            core::panic_with_felt252(iwa_errors::UNSUPPORTED_ASSET)
        }

        fn assert_exists(self: @ContractState, circle_id: u32) {
            assert(self.exists.read(circle_id), iwa_errors::CIRCLE_NOT_FOUND);
        }

        fn read_record(self: @ContractState, circle_id: u32) -> CircleRecord {
            self.assert_exists(circle_id);
            self.circles.read(circle_id)
        }

        fn find_invite_slot(self: @ContractState, circle_id: u32, member_ref: felt252) -> u8 {
            let len = self.payout_order_len.read(circle_id);
            let mut slot: u8 = 0;
            while slot < len {
                if self.payout_order.read((circle_id, slot)) == member_ref {
                    return slot;
                }
                slot += 1;
            }
            core::panic_with_felt252(iwa_errors::NOT_MEMBER)
        }

        fn store_payout_order(
            ref self: ContractState, circle_id: u32, order: Span<felt252>, member_limit: u8,
        ) {
            let mut slot: u8 = 0;
            let mut i: u32 = 0;
            while i < order.len() {
                self.payout_order.write((circle_id, slot), *order.at(i));
                slot += 1;
                i += 1;
            }
            self.payout_order_len.write(circle_id, member_limit);
        }

        fn create_round_obligations(
            ref self: ContractState, circle_id: u32, record: CircleRecord, round_started_at: u64,
        ) {
            let due_at = round_started_at + record.cadence_seconds;
            let grace_ends_at = due_at + record.grace_period_seconds;
            let mut slot: u8 = 0;
            while slot < record.member_limit {
                let member_ref = self.payout_order.read((circle_id, slot));
                assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);
                let key = (circle_id, record.current_round, member_ref);
                assert(!self.obligation_exists.read(key), iwa_errors::ALREADY_SATISFIED);
                self
                    .obligations
                    .write(
                        key,
                        ContributionObligation {
                            circle_id,
                            round: record.current_round,
                            member_ref,
                            asset: record.asset,
                            required_amount: record.contribution_amount,
                            due_at,
                            grace_ends_at,
                            status: ContributionStatus::Pending,
                        },
                    );
                self.obligation_exists.write(key, true);
                slot += 1;
            }
        }
    }

    fn validate_payout_order(order: Span<felt252>, member_limit: u8) {
        assert(order.len() == member_limit.into(), iwa_errors::INVALID_CONFIG);
        let n = order.len();
        let mut i: u32 = 0;
        while i < n {
            let member_ref = *order.at(i);
            assert(member_ref != 0, iwa_errors::INVALID_CONFIG);
            let mut j = i + 1;
            while j < n {
                assert(*order.at(j) != member_ref, iwa_errors::INVALID_CONFIG);
                j += 1;
            }
            i += 1;
        }
    }
}

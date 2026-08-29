// IwaCircle — circle, contribution, cure, and payout accounting.
// Accounting state does not assert token settlement. No token calls,
// financial completion, pause, or STRK20 helper are implemented.

use starknet::ContractAddress;
use super::iwa_types::{
    CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState, PayoutState,
    RoundLiability, SettlementConfig, SupportedAsset,
};

#[derive(Copy, Drop, Serde)]
pub struct CircleView {
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
pub trait IIwaCircle<TContractState> {
    fn create_circle(
        ref self: TContractState,
        token: ContractAddress,
        contribution_amount: u128,
        cadence_seconds: u64,
        grace_period_seconds: u64,
        member_limit: u8,
        payout_order: Span<felt252>,
    ) -> u32;
    fn get_circle(self: @TContractState, circle_id: u32) -> CircleView;
    fn get_payout_order(self: @TContractState, circle_id: u32) -> Array<felt252>;
    fn get_cure_config(self: @TContractState, circle_id: u32) -> CureConfig;
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
    /// One-time deployment wiring. The setup authority is cleared on success
    /// and has no other privileged capability.
    fn initialize_settlement_helper(ref self: TContractState, helper: ContractAddress);
    fn get_round_liability(self: @TContractState, circle_id: u32, round: u32) -> RoundLiability;
    fn get_round_unresolved_deficit(self: @TContractState, circle_id: u32, round: u32) -> u128;
    fn get_token_outstanding_liability(self: @TContractState, token: ContractAddress) -> u256;
    /// Financial contribution transition reserved for the immutable helper.
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
    /// Permissionless post-grace finalization of an unpaid obligation.
    /// The outcome derives only from immutable obligation state and the
    /// contract-side block timestamp, so the caller has no discretion over
    /// the member, status, deadline, amount, or asset. No token movement.
    fn finalize_contribution_default(
        ref self: TContractState, circle_id: u32, round: u32, member_ref: felt252,
    ) -> ContributionStatus;
    fn get_cure_state(
        self: @TContractState, circle_id: u32, round: u32, member_ref: felt252,
    ) -> CureState;
    fn is_cure_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    /// Financial cure transition reserved for the immutable helper.
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
    fn get_payout_state(self: @TContractState, circle_id: u32, round: u32) -> PayoutState;
    /// Stores one deterministic payout-accounting result for the current
    /// ready round, then advances to the next round when one remains.
    fn finalize_round_payout_accounting(
        ref self: TContractState, circle_id: u32, round: u32,
    ) -> PayoutState;
    fn is_payout_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    /// Records the scheduled member's authorization of exact payout
    /// settlement accounting. No token movement is asserted.
    fn authorize_payout_settlement(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> PayoutState;
    fn is_payout_settlement_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    fn settle_payout_from_helper(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        token: ContractAddress,
        open_note_id: felt252,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> PayoutState;
    fn get_recovery_amount(self: @TContractState, circle_id: u32, round: u32) -> u128;
    fn is_recovery_settlement_nonce_consumed(
        self: @TContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
    ) -> bool;
    fn settle_recovery_from_helper(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        token: ContractAddress,
        open_note_id: felt252,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    ) -> PayoutState;
    fn is_final_settlement_prepared(self: @TContractState, circle_id: u32) -> bool;
    /// Fixes terminal settlement/recovery accounting and closes cure windows.
    /// The circle remains short of financial completion until Task 8.
    fn prepare_final_settlement(ref self: TContractState, circle_id: u32);
}

#[starknet::contract]
pub mod IwaCircle {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::super::iwa_errors;
    use super::super::iwa_events::{
        CircleActivated, CircleCreated, ContributionStateUpdated, CureAccountingSettled,
        FinalSettlementPrepared, MemberJoined, PayoutAccountingPrepared, PayoutSettlementAuthorized,
        SettlementHelperInitialized,
    };
    use super::super::iwa_types::{
        CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState,
        PayoutState, PayoutStatus, RoundLiability, SettlementConfig, SupportedAsset,
        invite_commitment, is_valid_auth_public_key, locked_cure_config,
        verify_contribution_settlement_authorization, verify_cure_settlement_authorization,
        verify_payout_authorization, verify_payout_settlement_authorization,
        verify_recovery_settlement_authorization,
    };
    use super::{CircleView, IIwaCircle};

    /// Upper bound on circle size. Final settlement is O(member_limit^2) in
    /// storage reads, and it has no resumable path, so the size must stay
    /// comfortably executable in a single transaction.
    const MAX_MEMBER_LIMIT: u8 = 32;

    /// Largest value representable in `u128`, as `u256`, for the widened
    /// scheduled-payout overflow check in `create_circle`.
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
        payout_states: Map<(u32, u32), PayoutState>,
        payout_nonces: Map<(u32, felt252, felt252), bool>,
        final_settlement_prepared: Map<u32, bool>,
        round_settled_inflows: Map<(u32, u32), u256>,
        round_settled_outflows: Map<(u32, u32), u256>,
        round_outstanding_liability: Map<(u32, u32), u256>,
        payout_settlement_nonces: Map<(u32, felt252, felt252), bool>,
        recovery_amounts: Map<(u32, u32), u128>,
        recovery_amount_exists: Map<(u32, u32), bool>,
        recovery_settlement_nonces: Map<(u32, felt252, felt252), bool>,
        token_outstanding_liability: Map<ContractAddress, u256>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        CircleCreated: CircleCreated,
        MemberJoined: MemberJoined,
        CircleActivated: CircleActivated,
        ContributionStateUpdated: ContributionStateUpdated,
        CureAccountingSettled: CureAccountingSettled,
        PayoutAccountingPrepared: PayoutAccountingPrepared,
        PayoutSettlementAuthorized: PayoutSettlementAuthorized,
        FinalSettlementPrepared: FinalSettlementPrepared,
        SettlementHelperInitialized: SettlementHelperInitialized,
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
    impl IwaCircleImpl of IIwaCircle<ContractState> {
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
            // Final settlement preparation walks rounds x payout slots, so an
            // unbounded member_limit could make that terminal call unexecutable
            // and strand the circle. The cap keeps it bounded.
            assert(
                member_limit >= 2 && member_limit <= MAX_MEMBER_LIMIT, iwa_errors::INVALID_CONFIG,
            );
            assert(cadence_seconds > 0, iwa_errors::INVALID_CONFIG);
            assert(grace_period_seconds > 0, iwa_errors::INVALID_CONFIG);
            validate_payout_order(payout_order, member_limit);
            // IWA-07: the scheduled payout for a full round is
            // `contribution_amount * member_limit`. Reject any configuration whose
            // product cannot be represented in u128, so an impossible circle fails
            // at creation instead of at payout time.
            //
            // The check is deliberately explicit. It previously relied on the
            // overflow panic of an otherwise unused multiplication, which a routine
            // "remove the unused binding" cleanup could have silently deleted along
            // with the guard. The widened product cannot itself overflow: the
            // operands are bounded by u128::MAX and MAX_MEMBER_LIMIT.
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

        fn get_circle(self: @ContractState, circle_id: u32) -> CircleView {
            let record = self.read_record(circle_id);
            CircleView {
                id: circle_id,
                asset: record.asset,
                contribution_amount: record.contribution_amount,
                cadence_seconds: record.cadence_seconds,
                grace_period_seconds: record.grace_period_seconds,
                member_limit: record.member_limit,
                current_round: record.current_round,
                status: record.status,
                created_at: record.created_at,
                organizer: record.organizer,
                payout_order_locked: record.payout_order_locked,
                joined_count: record.joined_count,
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

            // Every check precedes both writes. Starknet revert atomicity also
            // rolls both back together if a later operation fails.
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

            // Only an unresolved obligation may default. ON_TIME,
            // LATE_WITHIN_GRACE, and MISSED_DEFAULT are historical and are
            // never rewritten, by any caller (INV-004).
            assert(obligation.status == ContributionStatus::Pending, iwa_errors::HISTORY_IMMUTABLE);

            // Same contract-side clock the classifier uses, compared against the
            // deadline stored on the obligation at round creation. Strictly
            // after `grace_ends_at`; the boundary itself is still curable by a
            // LATE_WITHIN_GRACE contribution (INV-018).
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

            // All eligibility, amount, window, replay, and signature checks
            // precede both accounting writes. Reverts roll both back atomically.
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

        fn get_payout_state(self: @ContractState, circle_id: u32, round: u32) -> PayoutState {
            self.assert_exists(circle_id);
            let key = (circle_id, round);
            assert(self.payout_exists.read(key), iwa_errors::PAYOUT_LOCKED);
            self.payout_states.read(key)
        }

        fn finalize_round_payout_accounting(
            ref self: ContractState, circle_id: u32, round: u32,
        ) -> PayoutState {
            let mut record = self.read_record(circle_id);
            let payout_key = (circle_id, round);
            assert(!self.payout_exists.read(payout_key), iwa_errors::PAYOUT_ALREADY_PREPARED);
            assert(record.status == CircleStatus::Active, iwa_errors::WRONG_ROUND);
            assert(round == record.current_round, iwa_errors::WRONG_ROUND);

            // The immutable payout order is both the required-member set and
            // the sole recipient schedule. Every obligation must be final.
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
                round_unresolved_deficit <= scheduled_payout_amount,
                iwa_errors::LIABILITY_INVARIANT,
            );
            let funded_amount: u256 = (scheduled_payout_amount - round_unresolved_deficit).into();
            assert(
                self.round_outstanding_liability.read((circle_id, round)) == funded_amount,
                iwa_errors::LIABILITY_INVARIANT,
            );
            let payout_status = if round_unresolved_deficit > 0 {
                PayoutStatus::DeferredLocked
            } else {
                PayoutStatus::Scheduled
            };
            let payout = PayoutState {
                circle_id,
                round,
                scheduled_member_ref,
                amount: scheduled_payout_amount,
                status: payout_status,
            };

            // Persist the independent claim before advancing. Revert
            // atomicity prevents either state from being committed alone.
            self.payout_states.write(payout_key, payout);
            self.payout_exists.write(payout_key, true);
            self
                .emit(
                    PayoutAccountingPrepared {
                        circle_id, round, scheduled_member_ref, status: payout_status,
                    },
                );

            if round < record.member_limit.into() {
                record.current_round += 1;
                self.create_round_obligations(circle_id, record, get_block_timestamp());
                self.circles.write(circle_id, record);
            }
            payout
        }

        fn is_payout_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.payout_nonces.read((circle_id, member_ref, nonce))
        }

        fn authorize_payout_settlement(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> PayoutState {
            self.assert_exists(circle_id);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);

            let is_scheduled = payout.status == PayoutStatus::Scheduled;
            let is_cured_deferred = payout.status == PayoutStatus::DeferredLocked
                && self
                    .calculate_round_unresolved_deficit(
                        circle_id, round, self.read_record(circle_id).member_limit,
                    ) == 0;
            assert(is_scheduled || is_cured_deferred, iwa_errors::PAYOUT_NOT_AUTHORIZABLE);

            let nonce_key = (circle_id, payout.scheduled_member_ref, nonce);
            assert(!self.payout_nonces.read(nonce_key), iwa_errors::PAYOUT_NONCE_USED);
            let auth_key = self.member_auth_keys.read((circle_id, payout.scheduled_member_ref));
            assert(
                verify_payout_authorization(
                    auth_key,
                    circle_id,
                    round,
                    payout.scheduled_member_ref,
                    payout.amount,
                    nonce,
                    signature_r,
                    signature_s,
                ),
                iwa_errors::INVALID_SIGNATURE,
            );

            // Every eligibility and signature check precedes both writes.
            // Starknet revert atomicity prevents partial nonce/state commits.
            payout.status = PayoutStatus::SettlementAuthorized;
            self.payout_states.write(payout_key, payout);
            self.payout_nonces.write(nonce_key, true);
            self
                .emit(
                    PayoutSettlementAuthorized {
                        circle_id, round, scheduled_member_ref: payout.scheduled_member_ref,
                    },
                );
            payout
        }

        fn is_final_settlement_prepared(self: @ContractState, circle_id: u32) -> bool {
            self.assert_exists(circle_id);
            self.final_settlement_prepared.read(circle_id)
        }

        fn is_payout_settlement_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.payout_settlement_nonces.read((circle_id, member_ref, nonce))
        }

        fn settle_payout_from_helper(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            token: ContractAddress,
            open_note_id: felt252,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> PayoutState {
            self.assert_settlement_helper();
            assert(open_note_id != 0, iwa_errors::INVALID_OPEN_NOTE);
            let record = self.read_record(circle_id);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);
            assert(
                payout.status == PayoutStatus::SettlementAuthorized,
                iwa_errors::PAYOUT_NOT_AUTHORIZABLE,
            );
            assert(
                self.calculate_round_unresolved_deficit(circle_id, round, record.member_limit) == 0,
                iwa_errors::PAYOUT_LOCKED,
            );

            let nonce_key = (circle_id, payout.scheduled_member_ref, nonce);
            assert(!self.payout_settlement_nonces.read(nonce_key), iwa_errors::PAYOUT_NONCE_USED);
            let auth_key = self.member_auth_keys.read((circle_id, payout.scheduled_member_ref));
            assert(
                verify_payout_settlement_authorization(
                    auth_key,
                    circle_id,
                    round,
                    payout.scheduled_member_ref,
                    self.settlement_helper.read(),
                    self.privacy_pool.read(),
                    token,
                    payout.amount,
                    open_note_id,
                    nonce,
                    signature_r,
                    signature_s,
                ),
                iwa_errors::INVALID_SIGNATURE,
            );
            self.assert_round_can_debit(circle_id, round, payout.amount);

            payout.status = PayoutStatus::Paid;
            self.payout_states.write(payout_key, payout);
            self.payout_settlement_nonces.write(nonce_key, true);
            self.debit_round_liability(circle_id, round, payout.amount);
            payout
        }

        fn get_recovery_amount(self: @ContractState, circle_id: u32, round: u32) -> u128 {
            self.assert_exists(circle_id);
            assert(
                self.recovery_amount_exists.read((circle_id, round)),
                iwa_errors::RECOVERY_NOT_READY,
            );
            self.recovery_amounts.read((circle_id, round))
        }

        fn is_recovery_settlement_nonce_consumed(
            self: @ContractState, circle_id: u32, member_ref: felt252, nonce: felt252,
        ) -> bool {
            self.assert_exists(circle_id);
            self.recovery_settlement_nonces.read((circle_id, member_ref, nonce))
        }

        fn settle_recovery_from_helper(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            token: ContractAddress,
            open_note_id: felt252,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> PayoutState {
            self.assert_settlement_helper();
            assert(open_note_id != 0, iwa_errors::INVALID_OPEN_NOTE);
            let record = self.read_record(circle_id);
            assert(token == self.token_for_asset(record.asset), iwa_errors::UNSUPPORTED_ASSET);
            let payout_key = (circle_id, round);
            assert(self.payout_exists.read(payout_key), iwa_errors::PAYOUT_LOCKED);
            let mut payout = self.payout_states.read(payout_key);
            assert(payout.status == PayoutStatus::RecoveryPending, iwa_errors::RECOVERY_NOT_READY);
            assert(self.recovery_amount_exists.read(payout_key), iwa_errors::RECOVERY_NOT_READY);
            let recovery_amount = self.recovery_amounts.read(payout_key);

            let nonce_key = (circle_id, payout.scheduled_member_ref, nonce);
            assert(
                !self.recovery_settlement_nonces.read(nonce_key), iwa_errors::RECOVERY_NONCE_USED,
            );
            let auth_key = self.member_auth_keys.read((circle_id, payout.scheduled_member_ref));
            assert(
                verify_recovery_settlement_authorization(
                    auth_key,
                    circle_id,
                    round,
                    payout.scheduled_member_ref,
                    self.settlement_helper.read(),
                    self.privacy_pool.read(),
                    token,
                    recovery_amount,
                    open_note_id,
                    nonce,
                    signature_r,
                    signature_s,
                ),
                iwa_errors::INVALID_SIGNATURE,
            );
            self.assert_round_can_debit(circle_id, round, recovery_amount);

            payout.status = PayoutStatus::Recovered;
            self.payout_states.write(payout_key, payout);
            self.recovery_settlement_nonces.write(nonce_key, true);
            self.debit_round_liability(circle_id, round, recovery_amount);
            payout
        }

        fn prepare_final_settlement(ref self: ContractState, circle_id: u32) {
            let mut record = self.read_record(circle_id);
            assert(
                !self.final_settlement_prepared.read(circle_id), iwa_errors::FINAL_ALREADY_PREPARED,
            );
            assert(record.status == CircleStatus::Active, iwa_errors::FINAL_NOT_READY);
            let final_round: u32 = record.member_limit.into();
            assert(self.payout_exists.read((circle_id, final_round)), iwa_errors::FINAL_NOT_READY);

            // Preflight every payout before any write. Scheduled payouts and
            // cured deferred payouts remain rightful authorization claims and
            // cannot be silently converted to recovery or discarded.
            let mut round: u32 = 1;
            while round <= final_round {
                let payout = self.payout_states.read((circle_id, round));
                if payout.status == PayoutStatus::Scheduled {
                    core::panic_with_felt252(iwa_errors::FINAL_NOT_READY);
                }
                if payout.status == PayoutStatus::DeferredLocked {
                    assert(
                        self
                            .calculate_round_unresolved_deficit(
                                circle_id, round, record.member_limit,
                            ) > 0,
                        iwa_errors::FINAL_NOT_READY,
                    );
                } else {
                    assert(
                        payout.status == PayoutStatus::SettlementAuthorized
                            || payout.status == PayoutStatus::Paid,
                        iwa_errors::FINAL_NOT_READY,
                    );
                }
                round += 1;
            }

            // All terminal requirements are now deterministic. Uncured
            // deferred entitlements retain their original recipient/amount.
            round = 1;
            while round <= final_round {
                let payout_key = (circle_id, round);
                let mut payout = self.payout_states.read(payout_key);
                if payout.status == PayoutStatus::DeferredLocked {
                    let unresolved = self
                        .calculate_round_unresolved_deficit(circle_id, round, record.member_limit);
                    assert(unresolved <= payout.amount, iwa_errors::LIABILITY_INVARIANT);
                    let recovery_amount = payout.amount - unresolved;
                    let recovery_amount_u256: u256 = recovery_amount.into();
                    assert(
                        self.round_outstanding_liability.read(payout_key) == recovery_amount_u256,
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
                                PayoutStatus::NoFundedRecovery
                            } else {
                                PayoutStatus::RecoveryPending
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
            self.emit(FinalSettlementPrepared { circle_id });
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

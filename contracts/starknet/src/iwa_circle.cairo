// IwaCircle — circle, contribution, cure, and payout accounting.
// Accounting state does not assert token settlement. No token calls,
// financial completion, pause, or STRK20 helper are implemented.

use starknet::ContractAddress;
use super::iwa_types::{
    CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState, PayoutState,
    SupportedAsset,
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
    /// Records authenticated obligation satisfaction only. Token settlement
    /// is deliberately absent until the verified STRK20 helper integration.
    fn satisfy_contribution(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
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
    /// Records authenticated deficit settlement accounting only. No token
    /// movement is asserted until Task 8 binds this transition to STRK20.
    fn cure_default(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
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
    };
    use super::super::iwa_types::{
        CircleStatus, ContributionObligation, ContributionStatus, CureConfig, CureState,
        PayoutState, PayoutStatus, SupportedAsset, invite_commitment, is_valid_auth_public_key,
        locked_cure_config, verify_contribution_authorization, verify_cure_authorization,
        verify_payout_authorization,
    };
    use super::{CircleView, IIwaCircle};

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
    }

    #[constructor]
    fn constructor(ref self: ContractState, usdc: ContractAddress, strk: ContractAddress) {
        assert(!usdc.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(!strk.is_zero(), iwa_errors::INVALID_CONFIG);
        assert(usdc != strk, iwa_errors::INVALID_CONFIG);
        self.usdc.write(usdc);
        self.strk.write(strk);
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
            assert(member_limit >= 2, iwa_errors::INVALID_CONFIG);
            assert(cadence_seconds > 0, iwa_errors::INVALID_CONFIG);
            assert(grace_period_seconds > 0, iwa_errors::INVALID_CONFIG);
            validate_payout_order(payout_order, member_limit);

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
            let member_ref = invite_commitment(invite_secret);
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

        fn satisfy_contribution(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            amount: u128,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> ContributionStatus {
            let record = self.read_record(circle_id);
            assert(record.status == CircleStatus::Active, iwa_errors::WRONG_ROUND);
            assert(round == record.current_round, iwa_errors::WRONG_ROUND);
            assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);
            assert(amount == record.contribution_amount, iwa_errors::WRONG_AMOUNT);

            let obligation_key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND);
            let mut obligation = self.obligations.read(obligation_key);
            let nonce_key = (circle_id, member_ref, nonce);
            assert(!self.contribution_nonces.read(nonce_key), iwa_errors::NONCE_USED);
            assert(obligation.status == ContributionStatus::Pending, iwa_errors::ALREADY_SATISFIED);

            let auth_key = self.member_auth_keys.read((circle_id, member_ref));
            assert(
                verify_contribution_authorization(
                    auth_key,
                    circle_id,
                    round,
                    member_ref,
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

        fn cure_default(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) -> CureState {
            self.assert_exists(circle_id);
            let obligation_key = (circle_id, round, member_ref);
            assert(self.obligation_exists.read(obligation_key), iwa_errors::OBLIGATION_NOT_FOUND);
            let obligation = self.obligations.read(obligation_key);
            assert(
                obligation.status == ContributionStatus::MissedDefault,
                iwa_errors::CURE_NOT_ELIGIBLE,
            );
            assert(self.joined.read((circle_id, member_ref)), iwa_errors::NOT_MEMBER);

            let nonce_key = (circle_id, member_ref, nonce);
            assert(!self.cure_nonces.read(nonce_key), iwa_errors::CURE_NONCE_USED);
            assert(!self.cured_deficits.read(obligation_key), iwa_errors::ALREADY_CURED);
            assert(!self.cure_windows_closed.read(obligation_key), iwa_errors::CURE_WINDOW_CLOSED);

            let auth_key = self.member_auth_keys.read((circle_id, member_ref));
            assert(
                verify_cure_authorization(
                    auth_key,
                    circle_id,
                    round,
                    member_ref,
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
            let recipient_key = (circle_id, round, scheduled_member_ref);
            let recipient_obligation = self.obligations.read(recipient_key);
            let unresolved_deficit = recipient_obligation
                .status == ContributionStatus::MissedDefault
                && !self.cured_deficits.read(recipient_key);
            let payout_status = if unresolved_deficit {
                PayoutStatus::DeferredLocked
            } else {
                PayoutStatus::Scheduled
            };
            let member_count: u128 = record.member_limit.into();
            let payout = PayoutState {
                circle_id,
                round,
                scheduled_member_ref,
                amount: record.contribution_amount * member_count,
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
                && self.cured_deficits.read((circle_id, round, payout.scheduled_member_ref));
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
                        !self.cured_deficits.read((circle_id, round, payout.scheduled_member_ref)),
                        iwa_errors::FINAL_NOT_READY,
                    );
                } else {
                    assert(
                        payout.status == PayoutStatus::SettlementAuthorized,
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
                    payout.status = PayoutStatus::RecoveryPending;
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

// IwaCircle — creation (6A) and invite-list membership (6B).
// No contribution, payout, pause, cure execution, or STRK20 helper.

use starknet::ContractAddress;
use super::iwa_types::{CircleStatus, CureConfig, SupportedAsset};

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
    fn join_circle(ref self: TContractState, circle_id: u32, invite_secret: felt252) -> u8;
    fn is_member(self: @TContractState, circle_id: u32, member_ref: felt252) -> bool;
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
    use super::super::iwa_events::{CircleActivated, CircleCreated, MemberJoined};
    use super::super::iwa_types::{
        CircleStatus, CureConfig, SupportedAsset, invite_commitment, locked_cure_config,
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
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        CircleCreated: CircleCreated,
        MemberJoined: MemberJoined,
        CircleActivated: CircleActivated,
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

        fn join_circle(ref self: ContractState, circle_id: u32, invite_secret: felt252) -> u8 {
            let mut record = self.read_record(circle_id);
            assert(record.status == CircleStatus::OpenForMembers, iwa_errors::JOIN_CLOSED);
            assert(invite_secret != 0, iwa_errors::INVALID_CONFIG);
            let member_ref = invite_commitment(invite_secret);
            let slot = self.find_invite_slot(circle_id, member_ref);
            assert(!self.joined.read((circle_id, member_ref)), iwa_errors::ALREADY_MEMBER);
            assert(record.joined_count < record.member_limit, iwa_errors::CIRCLE_FULL);

            self.joined.write((circle_id, member_ref), true);
            record.joined_count += 1;
            let activating = record.joined_count == record.member_limit;
            if activating {
                record.status = CircleStatus::Active;
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

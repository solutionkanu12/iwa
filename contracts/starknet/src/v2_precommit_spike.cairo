//! V2 private-payout capability spike — PRECOMMITTED DESTINATION NOTE.
//!
//! Feature-gated (`v2_precommit_spike`). NOT V1, NOT production, NOT deployed.
//! Compiled only for the capability test
//! `tests/test_precommitted_note_payout_v2.cairo`.
//!
//! Purpose: prove, against the GENUINE pinned STRK20 pool, that an Iwa payout
//! can settle privately to a destination the scheduled member committed to
//! BEFORE the STRK20 payout transaction was assembled — with:
//!   * the amount taken from trusted circle state, never calldata
//!   * the destination taken from a member-auth-key-signed pre-registration,
//!     never calldata and never an assembly-time signature
//!   * no organizer/admin/backend involvement
//!   * single-use nonce + monotonic epoch + one-shot payout state
//!   * full revert of registration + settlement on any failure
//!
//! This is the "candidate P" mechanism from
//! `docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`. It uses only STRK20 Wallet
//! API methods that ship in `@starknet-io/types-js` 0.10.3
//! (`wallet_strk20PrepareInvoke`, `wallet_signTypedData`,
//! `wallet_strk20InvokeTransaction` / `wallet_addInvokeTransaction`).

use core::ec::stark_curve;
use core::ecdsa::check_ecdsa_signature;
use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;
use crate::iwa_types::is_valid_auth_public_key;

pub const REGISTER_DEST_TAG: felt252 = 'IWA_PAYOUT_DEST_V2';

#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct PayoutRecordV2 {
    pub scheduled_member_ref: felt252,
    pub member_public_key: felt252,
    pub amount: u128,
    pub authorized: bool,
    pub paid: bool,
}

#[starknet::interface]
pub trait IMockCircleV2<TContractState> {
    /// Test setup: fix the round's scheduled recipient, their auth public key,
    /// and the state-derived payout amount.
    fn set_scheduled(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        member_public_key: felt252,
        amount: u128,
    );
    /// Models the member's own "authorize my payout, amount X" step.
    fn authorize(ref self: TContractState, circle_id: u32, round: u32);
    fn get_payout(self: @TContractState, circle_id: u32, round: u32) -> PayoutRecordV2;
    fn member_public_key(self: @TContractState, circle_id: u32, member_ref: felt252) -> felt252;
    /// Helper-only terminal transition. No admin, no organizer path.
    fn mark_paid(ref self: TContractState, circle_id: u32, round: u32);
    fn set_helper(ref self: TContractState, helper: ContractAddress);
}

#[starknet::interface]
pub trait IPayoutDestinationRegistrarV2<TContractState> {
    /// The scheduled member pre-registers the STRK20 open-note id their wallet
    /// will create for the payout. Authenticated by the member's Iwa auth key
    /// over `poseidon([REGISTER_DEST_TAG, circle_id, round, member_ref,
    /// note_id, dest_epoch, nonce])`. The public key is read from circle state,
    /// not supplied by the caller. Single-use nonce, strictly increasing epoch.
    fn register_destination(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        note_id: felt252,
        dest_epoch: u64,
        nonce: felt252,
        signature_r: felt252,
        signature_s: felt252,
    );
    fn registered_note(self: @TContractState, circle_id: u32, round: u32) -> felt252;
    fn current_epoch(self: @TContractState, circle_id: u32, member_ref: felt252) -> u64;
    fn is_nonce_used(self: @TContractState, member_ref: felt252, nonce: felt252) -> bool;
}

#[starknet::interface]
pub trait IPrecommitPayoutHelperV2<TContractState> {
    /// Driven ONLY by the STRK20 pool. Calldata carries no amount and no
    /// signature: the amount is read from circle state and the destination
    /// from the registrar.
    fn privacy_invoke(
        ref self: TContractState,
        circle_id: u32,
        round: u32,
        member_ref: felt252,
        token: ContractAddress,
        open_note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
    fn get_registrar(self: @TContractState) -> ContractAddress;
}

pub fn register_dest_hash(
    circle_id: u32, round: u32, member_ref: felt252, note_id: felt252, dest_epoch: u64, nonce: felt252,
) -> felt252 {
    core::poseidon::poseidon_hash_span(
        array![
            REGISTER_DEST_TAG, circle_id.into(), round.into(), member_ref, note_id,
            dest_epoch.into(), nonce,
        ]
            .span(),
    )
}

/// Canonical Stark-curve ECDSA check (range + low-s), matching the convention
/// `iwa_types::verify_settlement_hash` already enforces for V1.
pub fn verify_member_signature(
    public_key: felt252, message_hash: felt252, signature_r: felt252, signature_s: felt252,
) -> bool {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let r: u256 = signature_r.into();
    let s: u256 = signature_s.into();
    if !is_valid_auth_public_key(public_key)
        || signature_r == 0
        || signature_s == 0
        || r >= ORDER_U256
        || s >= ORDER_U256
        || s > ORDER_U256 / 2 {
        return false;
    }
    check_ecdsa_signature(message_hash, public_key, signature_r, signature_s)
}

#[starknet::contract]
pub mod MockCircleV2 {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::{IMockCircleV2, PayoutRecordV2};

    #[storage]
    struct Storage {
        helper: ContractAddress,
        payouts: Map<(u32, u32), PayoutRecordV2>,
        member_key: Map<(u32, felt252), felt252>,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl Impl of IMockCircleV2<ContractState> {
        fn set_scheduled(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            member_public_key: felt252,
            amount: u128,
        ) {
            self
                .payouts
                .write(
                    (circle_id, round),
                    PayoutRecordV2 {
                        scheduled_member_ref: member_ref,
                        member_public_key,
                        amount,
                        authorized: false,
                        paid: false,
                    },
                );
            self.member_key.write((circle_id, member_ref), member_public_key);
        }

        fn authorize(ref self: ContractState, circle_id: u32, round: u32) {
            let mut rec = self.payouts.read((circle_id, round));
            rec.authorized = true;
            self.payouts.write((circle_id, round), rec);
        }

        fn get_payout(self: @ContractState, circle_id: u32, round: u32) -> PayoutRecordV2 {
            self.payouts.read((circle_id, round))
        }

        fn member_public_key(
            self: @ContractState, circle_id: u32, member_ref: felt252,
        ) -> felt252 {
            self.member_key.read((circle_id, member_ref))
        }

        fn mark_paid(ref self: ContractState, circle_id: u32, round: u32) {
            assert(get_caller_address() == self.helper.read(), 'NOT_HELPER');
            let mut rec = self.payouts.read((circle_id, round));
            assert(!rec.paid, 'ALREADY_PAID');
            rec.paid = true;
            self.payouts.write((circle_id, round), rec);
        }

        fn set_helper(ref self: ContractState, helper: ContractAddress) {
            assert(self.helper.read().is_zero(), 'HELPER_SET');
            self.helper.write(helper);
        }
    }
}

#[starknet::contract]
pub mod PayoutDestinationRegistrarV2 {
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::ContractAddress;
    use super::{
        IMockCircleV2Dispatcher, IMockCircleV2DispatcherTrait, IPayoutDestinationRegistrarV2,
        register_dest_hash, verify_member_signature,
    };

    #[storage]
    struct Storage {
        circle: ContractAddress,
        registered: Map<(u32, u32), felt252>,
        epoch: Map<(u32, felt252), u64>,
        nonce_used: Map<(felt252, felt252), bool>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, circle: ContractAddress) {
        self.circle.write(circle);
    }

    #[abi(embed_v0)]
    impl Impl of IPayoutDestinationRegistrarV2<ContractState> {
        fn register_destination(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            note_id: felt252,
            dest_epoch: u64,
            nonce: felt252,
            signature_r: felt252,
            signature_s: felt252,
        ) {
            assert(note_id != 0, 'ZERO_NOTE');
            // Public key from trusted circle state, never the caller.
            let circle = IMockCircleV2Dispatcher { contract_address: self.circle.read() };
            let pubkey = circle.member_public_key(circle_id, member_ref);
            assert(pubkey != 0, 'UNKNOWN_MEMBER');

            let hash = register_dest_hash(
                circle_id, round, member_ref, note_id, dest_epoch, nonce,
            );
            assert(
                verify_member_signature(pubkey, hash, signature_r, signature_s),
                'BAD_MEMBER_SIGNATURE',
            );

            // Strictly increasing epoch: a stale registration cannot win.
            assert(dest_epoch > self.epoch.read((circle_id, member_ref)), 'STALE_EPOCH');
            // Single-use nonce in the member's namespace.
            assert(!self.nonce_used.read((member_ref, nonce)), 'NONCE_USED');

            self.epoch.write((circle_id, member_ref), dest_epoch);
            self.nonce_used.write((member_ref, nonce), true);
            self.registered.write((circle_id, round), note_id);
        }

        fn registered_note(self: @ContractState, circle_id: u32, round: u32) -> felt252 {
            self.registered.read((circle_id, round))
        }

        fn current_epoch(self: @ContractState, circle_id: u32, member_ref: felt252) -> u64 {
            self.epoch.read((circle_id, member_ref))
        }

        fn is_nonce_used(self: @ContractState, member_ref: felt252, nonce: felt252) -> bool {
            self.nonce_used.read((member_ref, nonce))
        }
    }
}

#[starknet::contract]
pub mod PrecommitPayoutHelperV2 {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{
        IMockCircleV2Dispatcher, IMockCircleV2DispatcherTrait, IPayoutDestinationRegistrarV2Dispatcher,
        IPayoutDestinationRegistrarV2DispatcherTrait, IPrecommitPayoutHelperV2,
    };

    #[storage]
    struct Storage {
        pool: ContractAddress,
        registrar: ContractAddress,
        circle: ContractAddress,
        usdc: ContractAddress,
        strk: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        registrar: ContractAddress,
        circle: ContractAddress,
        usdc: ContractAddress,
        strk: ContractAddress,
    ) {
        assert(!pool.is_zero() && !registrar.is_zero() && !circle.is_zero(), 'BAD_CONFIG');
        assert(!usdc.is_zero() && !strk.is_zero() && usdc != strk, 'BAD_CONFIG');
        self.pool.write(pool);
        self.registrar.write(registrar);
        self.circle.write(circle);
        self.usdc.write(usdc);
        self.strk.write(strk);
    }

    #[abi(embed_v0)]
    impl Impl of IPrecommitPayoutHelperV2<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            circle_id: u32,
            round: u32,
            member_ref: felt252,
            token: ContractAddress,
            open_note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // 1. Only the pinned STRK20 pool may drive settlement.
            assert(get_caller_address() == self.pool.read(), 'NOT_PRIVACY_POOL');
            assert(
                token == self.usdc.read() || token == self.strk.read(), 'UNSUPPORTED_TOKEN',
            );
            assert(open_note_id != 0, 'ZERO_NOTE');

            // 2. Amount + recipient come from circle state, NOT calldata.
            let circle = IMockCircleV2Dispatcher { contract_address: self.circle.read() };
            let payout = circle.get_payout(circle_id, round);
            assert(payout.authorized && !payout.paid, 'WRONG_STATE');
            assert(member_ref == payout.scheduled_member_ref, 'WRONG_MEMBER');
            let amount = payout.amount;
            assert(amount != 0, 'ZERO_AMOUNT');

            // 3. Destination note comes from the member's pre-registration.
            let registrar = IPayoutDestinationRegistrarV2Dispatcher {
                contract_address: self.registrar.read(),
            };
            assert(
                open_note_id == registrar.registered_note(circle_id, round),
                'DESTINATION_MISMATCH',
            );

            // 4. Parked pot must actually be present.
            let erc20 = IERC20Dispatcher { contract_address: token };
            let held = erc20.balance_of(get_contract_address());
            assert(held >= amount.into(), 'UNDERFUNDED');

            // 5. Exact, single-shot approval for the pool pull.
            let pool = self.pool.read();
            assert(erc20.allowance(get_contract_address(), pool) == 0, 'STALE_ALLOWANCE');
            assert(erc20.approve(pool, amount.into()), 'APPROVE_FAILED');

            // 6. Terminal state transition (helper-only on the circle side).
            circle.mark_paid(circle_id, round);

            array![OpenNoteDeposit { note_id: open_note_id, token, amount }].span()
        }

        fn get_registrar(self: @ContractState) -> ContractAddress {
            self.registrar.read()
        }
    }
}

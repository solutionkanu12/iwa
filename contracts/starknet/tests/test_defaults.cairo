// Task 6E — post-grace contribution default finalization.
// Finalization is permissionless and derives only from immutable obligation
// state plus the contract-side block timestamp. No token movement here.

use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    ContributionStatus, SupportedAsset, contribution_settlement_authorization_hash,
    invite_commitment,
};
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address,
};
use starknet::ContractAddress;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const SECRET_3: felt252 = 'secret-3';
const AMOUNT: u128 = 5_000_000;
const CADENCE: u64 = 100;
const GRACE: u64 = 50;
const ACTIVATED_AT: u64 = 1_000;
const DUE_AT: u64 = ACTIVATED_AT + CADENCE;
const GRACE_ENDS_AT: u64 = DUE_AT + GRACE;

fn usdc() -> ContractAddress {
    0x111.try_into().unwrap()
}
fn strk() -> ContractAddress {
    0x222.try_into().unwrap()
}
fn settlement_helper() -> ContractAddress {
    0x444.try_into().unwrap()
}
fn privacy_pool() -> ContractAddress {
    0x555.try_into().unwrap()
}
fn organizer() -> ContractAddress {
    0xabc.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0xfeed.try_into().unwrap()
}
fn key(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}
fn canonical_s(signature_s: felt252) -> felt252 {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let s: u256 = signature_s.into();
    if s > ORDER_U256 / 2 {
        stark_curve::ORDER - signature_s
    } else {
        signature_s
    }
}
fn deploy() -> IIwaCircleDispatcher {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    strk().serialize(ref calldata);
    privacy_pool().serialize(ref calldata);
    settlement_helper().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    let dispatcher = IIwaCircleDispatcher { contract_address: address };
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.initialize_settlement_helper(settlement_helper());
    dispatcher
}
fn order() -> Array<felt252> {
    array![invite_commitment(SECRET_1), invite_commitment(SECRET_2), invite_commitment(SECRET_3)]
}
fn activate(dispatcher: IIwaCircleDispatcher) -> u32 {
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = dispatcher.create_circle(usdc(), AMOUNT, CADENCE, GRACE, 3, order().span());
    dispatcher.join_circle(id, SECRET_1, key(0x101).public_key);
    dispatcher.join_circle(id, SECRET_2, key(0x102).public_key);
    start_cheat_block_timestamp(dispatcher.contract_address, ACTIVATED_AT);
    dispatcher.join_circle(id, SECRET_3, key(0x103).public_key);
    id
}
fn satisfy(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    member_ref: felt252,
    member_key: StarkCurveKeyPair,
    nonce: felt252,
) -> ContributionStatus {
    let hash = contribution_settlement_authorization_hash(
        id, 1, member_ref, settlement_helper(), privacy_pool(), usdc(), AMOUNT, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(member_key, hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(
            id, 1, member_ref, usdc(), AMOUNT, nonce, r, canonical_s(raw_s),
        )
}
fn at(dispatcher: IIwaCircleDispatcher, now: u64) {
    start_cheat_block_timestamp(dispatcher.contract_address, now);
}

#[test]
#[should_panic(expected: ('IWA: grace not expired', 'ENTRYPOINT_FAILED'))]
fn pending_cannot_default_before_due_at() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, DUE_AT - 1);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: grace not expired', 'ENTRYPOINT_FAILED'))]
fn pending_cannot_default_at_due_at() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, DUE_AT);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: grace not expired', 'ENTRYPOINT_FAILED'))]
fn pending_cannot_default_during_grace() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, DUE_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: grace not expired', 'ENTRYPOINT_FAILED'))]
fn grace_ends_at_boundary_remains_not_defaulted() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}

#[test]
fn first_timestamp_after_grace_produces_missed_default() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    assert(
        dispatcher
            .finalize_contribution_default(id, 1, member_ref) == ContributionStatus::MissedDefault,
        'defaulted',
    );
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_ref)
            .status == ContributionStatus::MissedDefault,
        'stored',
    );
}

#[test]
#[should_panic(expected: ('IWA: history immutable', 'ENTRYPOINT_FAILED'))]
fn on_time_cannot_be_defaulted() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, DUE_AT);
    assert(satisfy(dispatcher, id, member_ref, key(0x101), 31) == ContributionStatus::OnTime, 'on');
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
}

#[test]
#[should_panic(expected: ('IWA: history immutable', 'ENTRYPOINT_FAILED'))]
fn late_within_grace_cannot_be_defaulted() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_2);
    at(dispatcher, GRACE_ENDS_AT);
    assert(
        satisfy(dispatcher, id, member_ref, key(0x102), 32) == ContributionStatus::LateWithinGrace,
        'late',
    );
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
}

#[test]
#[should_panic(expected: ('IWA: history immutable', 'ENTRYPOINT_FAILED'))]
fn repeated_default_finalization_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
}

#[test]
#[should_panic(expected: ('IWA: already satisfied', 'ENTRYPOINT_FAILED'))]
fn missed_default_cannot_be_rewritten_by_contribution() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
    at(dispatcher, DUE_AT);
    satisfy(dispatcher, id, member_ref, key(0x101), 33);
}

#[test]
#[should_panic(expected: ('IWA: obligation not found', 'ENTRYPOINT_FAILED'))]
fn unknown_obligation_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, 0xdead);
}

#[test]
#[should_panic(expected: ('IWA: obligation not found', 'ENTRYPOINT_FAILED'))]
fn unknown_round_obligation_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 2, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: circle not found', 'ENTRYPOINT_FAILED'))]
fn unknown_circle_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id + 1, 1, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: grace not expired', 'ENTRYPOINT_FAILED'))]
fn organizer_cannot_early_default() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}

#[test]
#[should_panic(expected: ('IWA: history immutable', 'ENTRYPOINT_FAILED'))]
fn organizer_cannot_erase_a_default() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    dispatcher.finalize_contribution_default(id, 1, member_ref);
}

#[test]
fn unrelated_caller_may_finalize_after_grace() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    start_cheat_caller_address(dispatcher.contract_address, stranger());
    assert(
        dispatcher
            .finalize_contribution_default(id, 1, member_ref) == ContributionStatus::MissedDefault,
        'stranger finalized',
    );
}

#[test]
fn default_leaves_payout_order_and_membership_unchanged() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let before = dispatcher.get_payout_order(id);
    let count = dispatcher.get_circle(id).joined_count;
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
    assert(dispatcher.get_payout_order(id) == before, 'order unchanged');
    assert(dispatcher.get_circle(id).joined_count == count, 'count unchanged');
    assert(dispatcher.is_member(id, invite_commitment(SECRET_1)), 'still member');
    assert(dispatcher.is_member(id, invite_commitment(SECRET_2)), 'peer still member');
}

#[test]
fn default_leaves_locked_asset_amount_and_deadlines_unchanged() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
    let after = dispatcher.get_contribution_obligation(id, 1, member_ref);
    assert(after.circle_id == id, 'circle');
    assert(after.round == 1, 'round');
    assert(after.member_ref == member_ref, 'member');
    assert(after.asset == SupportedAsset::Usdc, 'asset unchanged');
    assert(after.required_amount == AMOUNT, 'amount unchanged');
    assert(after.due_at == DUE_AT, 'due unchanged');
    assert(after.grace_ends_at == GRACE_ENDS_AT, 'grace unchanged');
}

#[test]
fn default_of_one_member_does_not_touch_peer_obligations() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, invite_commitment(SECRET_2))
            .status == ContributionStatus::Pending,
        'peer still pending',
    );
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, invite_commitment(SECRET_3))
            .status == ContributionStatus::Pending,
        'peer3 pending',
    );
}

#[test]
fn default_does_not_consume_a_contribution_nonce() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    at(dispatcher, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
    assert(!dispatcher.is_contribution_nonce_consumed(id, member_ref, 34), 'no nonce consumed');
}

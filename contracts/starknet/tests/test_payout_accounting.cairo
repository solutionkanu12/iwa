// Deterministic payout/deferred accounting only. No token movement.

use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    ContributionStatus, PayoutStatus, contribution_authorization_hash, cure_authorization_hash,
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
use starknet::syscalls::call_contract_syscall;

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
fn organizer() -> ContractAddress {
    0xabc.try_into().unwrap()
}
fn member_caller() -> ContractAddress {
    0xbeef.try_into().unwrap()
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
    let (address, _) = contract.deploy(@calldata).unwrap();
    IIwaCircleDispatcher { contract_address: address }
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
    round: u32,
    member_ref: felt252,
    member_key: StarkCurveKeyPair,
    nonce: felt252,
) {
    let hash = contribution_authorization_hash(id, round, member_ref, AMOUNT, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(member_key, hash).unwrap();
    dispatcher.satisfy_contribution(id, round, member_ref, AMOUNT, nonce, r, canonical_s(raw_s));
}
fn satisfy_round_one(dispatcher: IIwaCircleDispatcher, id: u32) {
    start_cheat_block_timestamp(dispatcher.contract_address, DUE_AT);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_1), key(0x101), 71);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_2), key(0x102), 72);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_3), key(0x103), 73);
}
fn satisfy_round_two(dispatcher: IIwaCircleDispatcher, id: u32) {
    satisfy(dispatcher, id, 2, invite_commitment(SECRET_1), key(0x101), 81);
    satisfy(dispatcher, id, 2, invite_commitment(SECRET_2), key(0x102), 82);
    satisfy(dispatcher, id, 2, invite_commitment(SECRET_3), key(0x103), 83);
}
fn default_scheduled_recipient(dispatcher: IIwaCircleDispatcher, id: u32) {
    start_cheat_block_timestamp(dispatcher.contract_address, DUE_AT);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_2), key(0x102), 74);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_3), key(0x103), 75);
    start_cheat_block_timestamp(dispatcher.contract_address, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, invite_commitment(SECRET_1));
}
fn cure_scheduled_recipient(dispatcher: IIwaCircleDispatcher, id: u32) {
    let member_ref = invite_commitment(SECRET_1);
    let hash = cure_authorization_hash(id, 1, member_ref, AMOUNT, 76);
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    dispatcher.cure_default(id, 1, member_ref, 76, r, canonical_s(raw_s));
}
fn missing_entrypoint(address: ContractAddress, selector: felt252, calldata: Span<felt252>) {
    match call_contract_syscall(address, selector, calldata) {
        Result::Ok(_) => { core::panic_with_felt252('mutator must not exist'); },
        Result::Err(data) => { assert(*data.at(0) == 'ENTRYPOINT_NOT_FOUND', 'missing'); },
    }
}

#[test]
#[should_panic(expected: ('IWA: round not ready', 'ENTRYPOINT_FAILED'))]
fn payout_accounting_rejects_any_pending_obligation() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, DUE_AT);
    satisfy(dispatcher, id, 1, invite_commitment(SECRET_1), key(0x101), 77);
    dispatcher.finalize_round_payout_accounting(id, 1);
}

#[test]
fn scheduled_recipient_comes_from_immutable_payout_order() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    satisfy_round_one(dispatcher, id);
    let payout = dispatcher.finalize_round_payout_accounting(id, 1);
    assert(payout.scheduled_member_ref == *order().at(0), 'slot zero');
    assert(payout.status == PayoutStatus::Scheduled, 'ready');
}

#[test]
fn next_round_recipient_comes_from_next_immutable_slot() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    satisfy_round_one(dispatcher, id);
    dispatcher.finalize_round_payout_accounting(id, 1);
    satisfy_round_two(dispatcher, id);
    let payout = dispatcher.finalize_round_payout_accounting(id, 2);
    assert(payout.scheduled_member_ref == *order().at(1), 'slot one');
}

#[test]
fn eligible_recipient_payout_becomes_accounting_ready() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    satisfy_round_one(dispatcher, id);
    dispatcher.finalize_round_payout_accounting(id, 1);
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::Scheduled, 'scheduled');
}

#[test]
fn unresolved_default_is_deferred_and_never_redirected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    default_scheduled_recipient(dispatcher, id);
    let payout = dispatcher.finalize_round_payout_accounting(id, 1);
    assert(payout.status == PayoutStatus::DeferredLocked, 'deferred');
    assert(payout.scheduled_member_ref == invite_commitment(SECRET_1), 'not redirected');
}

#[test]
fn progression_preserves_deferred_claim_and_creates_next_obligations_once() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    default_scheduled_recipient(dispatcher, id);
    dispatcher.finalize_round_payout_accounting(id, 1);
    assert(dispatcher.get_circle(id).current_round == 2, 'advanced');
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::DeferredLocked, 'preserved');
    let next = dispatcher.get_contribution_obligation(id, 2, invite_commitment(SECRET_2));
    assert(next.status == ContributionStatus::Pending, 'next obligation');
}

#[test]
fn cured_default_is_recognized_without_rewriting_history() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_scheduled_recipient(dispatcher, id);
    cure_scheduled_recipient(dispatcher, id);
    let cure_before = dispatcher.get_cure_state(id, 1, member_ref);
    let payout = dispatcher.finalize_round_payout_accounting(id, 1);
    assert(payout.status == PayoutStatus::Scheduled, 'cure recognized');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_ref)
            .status == ContributionStatus::MissedDefault,
        'default history kept',
    );
    assert(dispatcher.get_cure_state(id, 1, member_ref) == cure_before, 'cure unchanged');
}

#[test]
#[should_panic(expected: ('IWA: payout already prepared', 'ENTRYPOINT_FAILED'))]
fn duplicate_payout_transition_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    satisfy_round_one(dispatcher, id);
    dispatcher.finalize_round_payout_accounting(id, 1);
    dispatcher.finalize_round_payout_accounting(id, 1);
}

#[test]
fn payout_accounting_preserves_order_membership_and_contribution_history() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    satisfy_round_one(dispatcher, id);
    let order_before = dispatcher.get_payout_order(id);
    let obligation_before = dispatcher
        .get_contribution_obligation(id, 1, invite_commitment(SECRET_1));
    dispatcher.finalize_round_payout_accounting(id, 1);
    assert(dispatcher.get_payout_order(id) == order_before, 'order');
    assert(dispatcher.is_member(id, invite_commitment(SECRET_1)), 'membership');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, invite_commitment(SECRET_1)) == obligation_before,
        'history',
    );
}

#[test]
fn organizer_and_member_have_no_recipient_override_api() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    invite_commitment(SECRET_2).serialize(ref calldata);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    missing_entrypoint(dispatcher.contract_address, selector!("redirect_payout"), calldata.span());
    start_cheat_caller_address(dispatcher.contract_address, member_caller());
    missing_entrypoint(
        dispatcher.contract_address, selector!("set_payout_recipient"), calldata.span(),
    );
}

#[test]
fn unrelated_caller_cannot_release_a_deferred_payout() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    default_scheduled_recipient(dispatcher, id);
    dispatcher.finalize_round_payout_accounting(id, 1);
    start_cheat_caller_address(dispatcher.contract_address, stranger());
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    missing_entrypoint(
        dispatcher.contract_address, selector!("release_deferred_payout"), calldata.span(),
    );
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::DeferredLocked, 'locked');
}

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
use starknet::syscalls::call_contract_syscall;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const SECRET_3: felt252 = 'secret-3';
const AMOUNT: u128 = 5_000_000;
const CADENCE: u64 = 100;
const GRACE: u64 = 50;
const ACTIVATED_AT: u64 = 1_000;

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
fn sign(
    keypair: StarkCurveKeyPair,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = contribution_settlement_authorization_hash(
        circle_id, round, member_ref, settlement_helper(), privacy_pool(), usdc(), amount, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(keypair, hash).unwrap();
    (r, canonical_s(raw_s))
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
    let (r, s) = sign(member_key, id, 1, member_ref, AMOUNT, nonce);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, nonce, r, s)
}

#[test]
fn pending_obligation_exists_with_locked_terms() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let obligation = dispatcher.get_contribution_obligation(id, 1, invite_commitment(SECRET_1));
    assert(obligation.circle_id == id, 'circle');
    assert(obligation.round == 1, 'round');
    assert(obligation.asset == SupportedAsset::Usdc, 'locked asset');
    assert(obligation.required_amount == AMOUNT, 'locked amount');
    assert(obligation.due_at == ACTIVATED_AT + CADENCE, 'due');
    assert(obligation.grace_ends_at == ACTIVATED_AT + CADENCE + GRACE, 'grace');
    assert(obligation.status == ContributionStatus::Pending, 'pending');
}

#[test]
fn valid_authenticated_current_round_satisfaction_is_on_time_and_consumes_nonce() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    start_cheat_block_timestamp(dispatcher.contract_address, ACTIVATED_AT + CADENCE);
    assert(
        satisfy(dispatcher, id, member_ref, key(0x101), 7) == ContributionStatus::OnTime, 'on time',
    );
    assert(dispatcher.is_contribution_nonce_consumed(id, member_ref, 7), 'nonce consumed');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_ref)
            .status == ContributionStatus::OnTime,
        'stored',
    );
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn invalid_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    let (r, s) = sign(key(0x999), id, 1, member_ref, AMOUNT, 8);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 8, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_member_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_2);
    let (r, s) = sign(key(0x101), id, 1, member_ref, AMOUNT, 9);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 9, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_circle_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    let (r, s) = sign(key(0x101), id + 1, 1, member_ref, AMOUNT, 10);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 10, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_round_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    let (r, s) = sign(key(0x101), id, 2, member_ref, AMOUNT, 11);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 11, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_amount_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    let (r, s) = sign(key(0x101), id, 1, member_ref, AMOUNT + 1, 12);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 12, r, s);
}

#[test]
#[should_panic(expected: ('IWA: wrong amount', 'ENTRYPOINT_FAILED'))]
fn zero_amount_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(id, 1, invite_commitment(SECRET_1), usdc(), 0, 13, 1, 1);
}

#[test]
#[should_panic(expected: ('IWA: wrong amount', 'ENTRYPOINT_FAILED'))]
fn under_or_over_amount_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(
            id, 1, invite_commitment(SECRET_1), usdc(), AMOUNT + 1, 14, 1, 1,
        );
}

#[test]
#[should_panic(expected: ('IWA: not member', 'ENTRYPOINT_FAILED'))]
fn unknown_member_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher.settle_contribution_from_helper(id, 1, 0xdead, usdc(), AMOUNT, 15, 1, 1);
}

#[test]
#[should_panic(expected: ('IWA: wrong round', 'ENTRYPOINT_FAILED'))]
fn future_round_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(
            id, 2, invite_commitment(SECRET_1), usdc(), AMOUNT, 16, 1, 1,
        );
}

#[test]
#[should_panic(expected: ('IWA: wrong round', 'ENTRYPOINT_FAILED'))]
fn past_or_non_current_round_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(
            id, 0, invite_commitment(SECRET_1), usdc(), AMOUNT, 17, 1, 1,
        );
}

#[test]
fn failed_transaction_does_not_consume_nonce() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    member_ref.serialize(ref calldata);
    usdc().serialize(ref calldata);
    AMOUNT.serialize(ref calldata);
    18.serialize(ref calldata);
    1.serialize(ref calldata);
    1.serialize(ref calldata);
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    let bad = call_contract_syscall(
        dispatcher.contract_address, selector!("settle_contribution_from_helper"), calldata.span(),
    );
    assert(bad.is_err(), 'invalid signature failed');
    assert(!dispatcher.is_contribution_nonce_consumed(id, member_ref, 18), 'nonce unused');
    assert(
        satisfy(dispatcher, id, member_ref, key(0x101), 18) == ContributionStatus::OnTime,
        'retry succeeds',
    );
}

#[test]
#[should_panic(expected: ('IWA: nonce used', 'ENTRYPOINT_FAILED'))]
fn reused_nonce_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    satisfy(dispatcher, id, member_ref, key(0x101), 19);
    let (r, s) = sign(key(0x101), id, 1, member_ref, AMOUNT, 19);
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 19, r, s);
}

#[test]
#[should_panic(expected: ('IWA: already satisfied', 'ENTRYPOINT_FAILED'))]
fn duplicate_satisfaction_fails_even_with_fresh_nonce() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    satisfy(dispatcher, id, member_ref, key(0x101), 20);
    let (r, s) = sign(key(0x101), id, 1, member_ref, AMOUNT, 21);
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 21, r, s);
}

#[test]
fn late_within_grace_is_classified_at_inclusive_boundary() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ACTIVATED_AT + CADENCE + GRACE);
    assert(
        satisfy(
            dispatcher, id, invite_commitment(SECRET_2), key(0x102), 22,
        ) == ContributionStatus::LateWithinGrace,
        'late',
    );
}

#[test]
fn contribution_does_not_change_payout_order_or_membership() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let before = dispatcher.get_payout_order(id);
    let count = dispatcher.get_circle(id).joined_count;
    satisfy(dispatcher, id, invite_commitment(SECRET_1), key(0x101), 23);
    assert(dispatcher.get_payout_order(id) == before, 'order unchanged');
    assert(dispatcher.get_circle(id).joined_count == count, 'count unchanged');
    assert(dispatcher.is_member(id, invite_commitment(SECRET_1)), 'membership unchanged');
}

#[test]
#[should_panic(expected: ('IWA: helper only', 'ENTRYPOINT_FAILED'))]
fn organizer_has_no_contribution_bypass() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let member_ref = invite_commitment(SECRET_1);
    let (r, s) = sign(key(0x999), id, 1, member_ref, AMOUNT, 24);
    dispatcher.settle_contribution_from_helper(id, 1, member_ref, usdc(), AMOUNT, 24, r, s);
}

// Task 6F — authenticated cure accounting for historical defaults.
// No ERC-20 or STRK20 settlement occurs in this test surface.

use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    ContributionStatus, SupportedAsset, contribution_authorization_hash, cure_authorization_hash,
    invite_commitment, verify_contribution_authorization, verify_cure_authorization,
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
fn sign_cure(
    keypair: StarkCurveKeyPair,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = cure_authorization_hash(circle_id, round, member_ref, amount, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(keypair, hash).unwrap();
    (r, canonical_s(raw_s))
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
fn default_member(dispatcher: IIwaCircleDispatcher, id: u32, member_ref: felt252) {
    start_cheat_block_timestamp(dispatcher.contract_address, GRACE_ENDS_AT + 1);
    dispatcher.finalize_contribution_default(id, 1, member_ref);
}
fn satisfy(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    member_ref: felt252,
    member_key: StarkCurveKeyPair,
    nonce: felt252,
    now: u64,
) -> ContributionStatus {
    let hash = contribution_authorization_hash(id, 1, member_ref, AMOUNT, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(member_key, hash).unwrap();
    start_cheat_block_timestamp(dispatcher.contract_address, now);
    dispatcher.satisfy_contribution(id, 1, member_ref, AMOUNT, nonce, r, canonical_s(raw_s))
}
fn cure(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    member_ref: felt252,
    member_key: StarkCurveKeyPair,
    nonce: felt252,
) {
    let (r, s) = sign_cure(member_key, id, 1, member_ref, AMOUNT, nonce);
    dispatcher.cure_default(id, 1, member_ref, nonce, r, s);
}

#[test]
fn missed_default_is_curable_and_preserves_history() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    cure(dispatcher, id, member_ref, key(0x101), 41);
    let obligation = dispatcher.get_contribution_obligation(id, 1, member_ref);
    let cure_state = dispatcher.get_cure_state(id, 1, member_ref);
    assert(obligation.status == ContributionStatus::MissedDefault, 'history kept');
    assert(cure_state.deficit_settled, 'deficit settled');
    assert(cure_state.deficit_amount == AMOUNT, 'stored deficit');
    assert(cure_state.window_open, 'window open');
}

#[test]
#[should_panic(expected: ('IWA: cure not eligible', 'ENTRYPOINT_FAILED'))]
fn pending_is_not_curable() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    cure(dispatcher, id, invite_commitment(SECRET_1), key(0x101), 42);
}

#[test]
#[should_panic(expected: ('IWA: cure not eligible', 'ENTRYPOINT_FAILED'))]
fn on_time_is_not_curable() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    satisfy(dispatcher, id, member_ref, key(0x101), 43, DUE_AT);
    cure(dispatcher, id, member_ref, key(0x101), 44);
}

#[test]
#[should_panic(expected: ('IWA: cure not eligible', 'ENTRYPOINT_FAILED'))]
fn late_within_grace_is_not_curable() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    satisfy(dispatcher, id, member_ref, key(0x101), 45, GRACE_ENDS_AT);
    cure(dispatcher, id, member_ref, key(0x101), 46);
}

#[test]
#[should_panic(expected: ('IWA: obligation not found', 'ENTRYPOINT_FAILED'))]
fn nonexistent_obligation_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let (r, s) = sign_cure(key(0x101), id, 2, invite_commitment(SECRET_1), AMOUNT, 47);
    dispatcher.cure_default(id, 2, invite_commitment(SECRET_1), 47, r, s);
}

#[test]
fn exact_stored_amount_is_authoritative() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    assert(dispatcher.get_cure_state(id, 1, member_ref).deficit_amount == AMOUNT, 'exact');
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn invalid_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    dispatcher.cure_default(id, 1, member_ref, 48, 1, 1);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_member_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_2);
    default_member(dispatcher, id, member_ref);
    let (r, s) = sign_cure(key(0x101), id, 1, member_ref, AMOUNT, 49);
    dispatcher.cure_default(id, 1, member_ref, 49, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_circle_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let (r, s) = sign_cure(key(0x101), id + 1, 1, member_ref, AMOUNT, 50);
    dispatcher.cure_default(id, 1, member_ref, 50, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_round_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let (r, s) = sign_cure(key(0x101), id, 2, member_ref, AMOUNT, 51);
    dispatcher.cure_default(id, 1, member_ref, 51, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_amount_authorization_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let (r, s) = sign_cure(key(0x101), id, 1, member_ref, AMOUNT + 1, 52);
    dispatcher.cure_default(id, 1, member_ref, 52, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn contribution_domain_signature_is_rejected_for_cure() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let hash = contribution_authorization_hash(id, 1, member_ref, AMOUNT, 53);
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    dispatcher.cure_default(id, 1, member_ref, 53, r, canonical_s(raw_s));
}

#[test]
fn cure_and_contribution_domains_are_not_cross_replayable() {
    let member_ref = invite_commitment(SECRET_1);
    let keypair = key(0x101);
    let (cure_r, cure_s) = sign_cure(keypair, 1, 1, member_ref, AMOUNT, 54);
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 1, member_ref, AMOUNT, 54, cure_r, cure_s,
        ),
        'cure not contribution',
    );
    let contribution_hash = contribution_authorization_hash(1, 1, member_ref, AMOUNT, 55);
    let (contribution_r, raw_s) = StarkCurveSignerImpl::sign(keypair, contribution_hash).unwrap();
    assert(
        !verify_cure_authorization(
            keypair.public_key, 1, 1, member_ref, AMOUNT, 55, contribution_r, canonical_s(raw_s),
        ),
        'contribution not cure',
    );
}

#[test]
fn nonce_is_consumed_on_success() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    cure(dispatcher, id, member_ref, key(0x101), 56);
    assert(dispatcher.is_cure_nonce_consumed(id, member_ref, 56), 'consumed');
}

#[test]
fn failed_cure_does_not_consume_nonce_or_settle_deficit() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    member_ref.serialize(ref calldata);
    57.serialize(ref calldata);
    1.serialize(ref calldata);
    1.serialize(ref calldata);
    let result = call_contract_syscall(
        dispatcher.contract_address, selector!("cure_default"), calldata.span(),
    );
    assert(result.is_err(), 'failed');
    assert(!dispatcher.is_cure_nonce_consumed(id, member_ref, 57), 'nonce unused');
    assert(!dispatcher.get_cure_state(id, 1, member_ref).deficit_settled, 'unsettled');
}

#[test]
#[should_panic(expected: ('IWA: cure nonce used', 'ENTRYPOINT_FAILED'))]
fn reused_nonce_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    cure(dispatcher, id, member_ref, key(0x101), 58);
    let (r, s) = sign_cure(key(0x101), id, 1, member_ref, AMOUNT, 58);
    dispatcher.cure_default(id, 1, member_ref, 58, r, s);
}

#[test]
#[should_panic(expected: ('IWA: already cured', 'ENTRYPOINT_FAILED'))]
fn double_cure_with_fresh_nonce_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    cure(dispatcher, id, member_ref, key(0x101), 59);
    cure(dispatcher, id, member_ref, key(0x101), 60);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn organizer_has_no_bypass() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let (r, s) = sign_cure(key(0x999), id, 1, member_ref, AMOUNT, 61);
    dispatcher.cure_default(id, 1, member_ref, 61, r, s);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn unrelated_caller_has_no_bypass() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    start_cheat_caller_address(dispatcher.contract_address, stranger());
    let (r, s) = sign_cure(key(0x999), id, 1, member_ref, AMOUNT, 62);
    dispatcher.cure_default(id, 1, member_ref, 62, r, s);
}

#[test]
fn cure_changes_only_deficit_settlement_state() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let member_ref = invite_commitment(SECRET_1);
    default_member(dispatcher, id, member_ref);
    let order_before = dispatcher.get_payout_order(id);
    let circle_before = dispatcher.get_circle(id);
    let obligation_before = dispatcher.get_contribution_obligation(id, 1, member_ref);
    cure(dispatcher, id, member_ref, key(0x101), 63);
    let obligation_after = dispatcher.get_contribution_obligation(id, 1, member_ref);
    assert(dispatcher.get_payout_order(id) == order_before, 'order unchanged');
    assert(dispatcher.get_circle(id).joined_count == circle_before.joined_count, 'members');
    assert(dispatcher.is_member(id, member_ref), 'membership unchanged');
    assert(obligation_after == obligation_before, 'obligation unchanged');
    assert(obligation_after.asset == SupportedAsset::Usdc, 'asset');
    assert(obligation_after.required_amount == AMOUNT, 'amount');
    assert(obligation_after.due_at == DUE_AT, 'due');
    assert(obligation_after.grace_ends_at == GRACE_ENDS_AT, 'grace');
}

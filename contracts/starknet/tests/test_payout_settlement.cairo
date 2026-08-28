// Authenticated payout and terminal accounting preparation only. No token movement.

use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    CircleStatus, ContributionStatus, PayoutStatus, contribution_authorization_hash,
    contribution_settlement_authorization_hash, cure_authorization_hash,
    cure_settlement_authorization_hash, invite_commitment, payout_authorization_hash,
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
const AMOUNT: u128 = 5_000_000;
const PAYOUT_AMOUNT: u128 = AMOUNT * 2;
const CADENCE: u64 = 100;
const GRACE: u64 = 50;
const ACTIVATED_AT: u64 = 1_000;
const ROUND_1_DUE: u64 = ACTIVATED_AT + CADENCE;
const ROUND_1_GRACE_END: u64 = ROUND_1_DUE + GRACE;

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
fn member_1() -> felt252 {
    invite_commitment(SECRET_1)
}
fn member_2() -> felt252 {
    invite_commitment(SECRET_2)
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

fn activate(dispatcher: IIwaCircleDispatcher) -> u32 {
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = dispatcher
        .create_circle(usdc(), AMOUNT, CADENCE, GRACE, 2, array![member_1(), member_2()].span());
    dispatcher.join_circle(id, SECRET_1, key(0x101).public_key);
    start_cheat_block_timestamp(dispatcher.contract_address, ACTIVATED_AT);
    dispatcher.join_circle(id, SECRET_2, key(0x102).public_key);
    id
}

fn satisfy(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    round: u32,
    member_ref: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) {
    let hash = contribution_settlement_authorization_hash(
        id, round, member_ref, settlement_helper(), privacy_pool(), usdc(), AMOUNT, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_contribution_from_helper(
            id, round, member_ref, usdc(), AMOUNT, nonce, r, canonical_s(raw_s),
        );
}

fn ready_round(dispatcher: IIwaCircleDispatcher, id: u32, round: u32, nonce: felt252) {
    satisfy(dispatcher, id, round, member_1(), key(0x101), nonce);
    satisfy(dispatcher, id, round, member_2(), key(0x102), nonce + 1);
    dispatcher.finalize_round_payout_accounting(id, round);
}

fn sign_payout(
    signer: StarkCurveKeyPair,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = payout_authorization_hash(circle_id, round, member_ref, amount, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn authorize(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    round: u32,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) {
    let member_ref = if round == 1 {
        member_1()
    } else {
        member_2()
    };
    let (r, s) = sign_payout(signer, id, round, member_ref, PAYOUT_AMOUNT, nonce);
    dispatcher.authorize_payout_settlement(id, round, nonce, r, s);
}

fn try_authorize(
    dispatcher: IIwaCircleDispatcher, id: u32, round: u32, nonce: felt252, r: felt252, s: felt252,
) -> bool {
    let mut calldata = array![];
    id.serialize(ref calldata);
    round.serialize(ref calldata);
    nonce.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    call_contract_syscall(
        dispatcher.contract_address, selector!("authorize_payout_settlement"), calldata.span(),
    )
        .is_err()
}

fn try_prepare(dispatcher: IIwaCircleDispatcher, id: u32) -> bool {
    let mut calldata = array![];
    id.serialize(ref calldata);
    call_contract_syscall(
        dispatcher.contract_address, selector!("prepare_final_settlement"), calldata.span(),
    )
        .is_err()
}

fn try_cure(
    dispatcher: IIwaCircleDispatcher, id: u32, round: u32, nonce: felt252, r: felt252, s: felt252,
) -> bool {
    let mut calldata = array![];
    id.serialize(ref calldata);
    round.serialize(ref calldata);
    member_2().serialize(ref calldata);
    usdc().serialize(ref calldata);
    AMOUNT.serialize(ref calldata);
    nonce.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    call_contract_syscall(
        dispatcher.contract_address, selector!("settle_cure_from_helper"), calldata.span(),
    )
        .is_err()
}

fn default_round_two_recipient(dispatcher: IIwaCircleDispatcher, id: u32) {
    satisfy(dispatcher, id, 2, member_1(), key(0x101), 41);
    let grace_end = dispatcher.get_contribution_obligation(id, 2, member_2()).grace_ends_at;
    start_cheat_block_timestamp(dispatcher.contract_address, grace_end + 1);
    dispatcher.finalize_contribution_default(id, 2, member_2());
    dispatcher.finalize_round_payout_accounting(id, 2);
}

fn prepare_final_round(dispatcher: IIwaCircleDispatcher, id: u32) {
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 11);
    authorize(dispatcher, id, 1, key(0x101), 21);
    ready_round(dispatcher, id, 2, 31);
}

#[test]
fn scheduled_payout_requires_correct_member_signature_and_uses_locked_amount() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    let before = dispatcher.get_payout_state(id, 1);
    assert(before.amount == PAYOUT_AMOUNT, 'state amount');
    authorize(dispatcher, id, 1, key(0x101), 10);
    let after = dispatcher.get_payout_state(id, 1);
    assert(after.status == PayoutStatus::SettlementAuthorized, 'authorized');
    assert(after.scheduled_member_ref == before.scheduled_member_ref, 'recipient');
    assert(after.amount == before.amount, 'amount');
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn invalid_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    dispatcher.authorize_payout_settlement(id, 1, 10, 1, 1);
}

#[test]
#[should_panic(expected: ('IWA: invalid signature', 'ENTRYPOINT_FAILED'))]
fn wrong_member_signature_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    authorize(dispatcher, id, 1, key(0x102), 10);
}

#[test]
fn circle_round_amount_and_domain_are_signature_bound() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    let cases = array![
        sign_payout(key(0x101), id + 1, 1, member_1(), PAYOUT_AMOUNT, 10),
        sign_payout(key(0x101), id, 2, member_1(), PAYOUT_AMOUNT, 10),
        sign_payout(key(0x101), id, 1, member_1(), PAYOUT_AMOUNT + 1, 10),
    ];
    let mut i = 0;
    while i < cases.len() {
        let (r, s) = *cases.at(i);
        assert(try_authorize(dispatcher, id, 1, 10, r, s), 'field bound');
        i += 1;
    }
    let cure_hash = cure_authorization_hash(id, 1, member_1(), PAYOUT_AMOUNT, 10);
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), cure_hash).unwrap();
    assert(try_authorize(dispatcher, id, 1, 10, r, canonical_s(raw_s)), 'domain bound');
    let contribution_hash = contribution_authorization_hash(id, 1, member_1(), PAYOUT_AMOUNT, 10);
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), contribution_hash).unwrap();
    assert(
        try_authorize(dispatcher, id, 1, 10, r, canonical_s(raw_s)), 'contribution domain bound',
    );
}

#[test]
fn nonce_is_atomic_and_replay_protected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    assert(try_authorize(dispatcher, id, 1, 15, 1, 1), 'failed');
    assert(!dispatcher.is_payout_nonce_consumed(id, member_1(), 15), 'not consumed');
    authorize(dispatcher, id, 1, key(0x101), 15);
    assert(dispatcher.is_payout_nonce_consumed(id, member_1(), 15), 'consumed');
    let (r, s) = sign_payout(key(0x101), id, 1, member_1(), PAYOUT_AMOUNT, 15);
    assert(try_authorize(dispatcher, id, 1, 15, r, s), 'replay');
}

#[test]
fn double_claim_with_fresh_nonce_is_rejected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    authorize(dispatcher, id, 1, key(0x101), 15);
    let (r, s) = sign_payout(key(0x101), id, 1, member_1(), PAYOUT_AMOUNT, 16);
    assert(try_authorize(dispatcher, id, 1, 16, r, s), 'double');
    assert(!dispatcher.is_payout_nonce_consumed(id, member_1(), 16), 'fresh unused');
}

#[test]
fn caller_identity_gives_no_bypass() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    assert(try_authorize(dispatcher, id, 1, 17, 1, 1), 'organizer');
    start_cheat_caller_address(dispatcher.contract_address, stranger());
    assert(try_authorize(dispatcher, id, 1, 18, 1, 1), 'stranger');
}

#[test]
fn unresolved_deferred_payout_cannot_be_authorized() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    satisfy(dispatcher, id, 1, member_2(), key(0x102), 1);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_GRACE_END + 1);
    dispatcher.finalize_contribution_default(id, 1, member_1());
    dispatcher.finalize_round_payout_accounting(id, 1);
    let (r, s) = sign_payout(key(0x101), id, 1, member_1(), PAYOUT_AMOUNT, 19);
    assert(try_authorize(dispatcher, id, 1, 19, r, s), 'locked');
}

#[test]
fn cured_deferred_entitlement_becomes_authorizable_without_history_rewrite() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    satisfy(dispatcher, id, 1, member_2(), key(0x102), 1);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_GRACE_END + 1);
    dispatcher.finalize_contribution_default(id, 1, member_1());
    dispatcher.finalize_round_payout_accounting(id, 1);
    let cure_hash = cure_settlement_authorization_hash(
        id, 1, member_1(), settlement_helper(), privacy_pool(), usdc(), AMOUNT, 20,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), cure_hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_cure_from_helper(id, 1, member_1(), usdc(), AMOUNT, 20, r, canonical_s(raw_s));
    authorize(dispatcher, id, 1, key(0x101), 21);
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::SettlementAuthorized, 'ok');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::MissedDefault,
        'history',
    );
}

#[test]
fn authorization_preserves_order_contributions_and_cure_state() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    let order = dispatcher.get_payout_order(id);
    let obligation = dispatcher.get_contribution_obligation(id, 1, member_1());
    let cure = dispatcher.get_cure_state(id, 1, member_1());
    authorize(dispatcher, id, 1, key(0x101), 21);
    assert(dispatcher.get_payout_order(id) == order, 'order');
    assert(dispatcher.get_contribution_obligation(id, 1, member_1()) == obligation, 'history');
    assert(dispatcher.get_cure_state(id, 1, member_1()) == cure, 'cure');
}

#[test]
fn non_final_authorization_and_final_round_accounting_do_not_complete_circle() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    prepare_final_round(dispatcher, id);
    assert(dispatcher.get_circle(id).status == CircleStatus::Active, 'not complete');
    authorize(dispatcher, id, 2, key(0x102), 22);
    assert(dispatcher.get_circle(id).status == CircleStatus::Active, 'still active');
}

#[test]
fn final_preparation_enters_settlement_pending_and_never_completed() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    prepare_final_round(dispatcher, id);
    authorize(dispatcher, id, 2, key(0x102), 22);
    dispatcher.prepare_final_settlement(id);
    assert(dispatcher.get_circle(id).status == CircleStatus::SettlementPending, 'pending');
    assert(dispatcher.get_circle(id).status != CircleStatus::Completed, 'not completed');
    assert(dispatcher.is_final_settlement_prepared(id), 'prepared');
}

#[test]
fn unresolved_final_deficit_becomes_recovery_pending_for_same_recipient_and_amount() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    authorize(dispatcher, id, 1, key(0x101), 21);
    default_round_two_recipient(dispatcher, id);
    let before = dispatcher.get_payout_state(id, 2);
    dispatcher.prepare_final_settlement(id);
    let after = dispatcher.get_payout_state(id, 2);
    assert(after.status == PayoutStatus::RecoveryPending, 'recovery');
    assert(after.scheduled_member_ref == before.scheduled_member_ref, 'recipient');
    assert(after.amount == before.amount, 'amount');
    assert(dispatcher.get_circle(id).status == CircleStatus::SettlementPending, 'pending');
}

#[test]
fn final_preparation_closes_cure_window_and_is_replay_protected() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    authorize(dispatcher, id, 1, key(0x101), 21);
    default_round_two_recipient(dispatcher, id);
    dispatcher.prepare_final_settlement(id);
    assert(!dispatcher.get_cure_state(id, 2, member_2()).window_open, 'closed');
    assert(try_prepare(dispatcher, id), 'replay');
    let cure_hash = cure_authorization_hash(id, 2, member_2(), AMOUNT, 50);
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x102), cure_hash).unwrap();
    assert(try_cure(dispatcher, id, 2, 50, r, canonical_s(raw_s)), 'cure closed');
}

#[test]
fn scheduled_or_cured_but_unclaimed_entitlement_blocks_final_preparation() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    prepare_final_round(dispatcher, id);
    assert(try_prepare(dispatcher, id), 'scheduled blocks');
    assert(dispatcher.get_circle(id).status == CircleStatus::Active, 'unchanged');
}

#[test]
fn cured_deferred_entitlement_must_be_authorized_before_final_preparation() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, ROUND_1_DUE);
    ready_round(dispatcher, id, 1, 1);
    authorize(dispatcher, id, 1, key(0x101), 21);
    default_round_two_recipient(dispatcher, id);
    let cure_hash = cure_settlement_authorization_hash(
        id, 2, member_2(), settlement_helper(), privacy_pool(), usdc(), AMOUNT, 51,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x102), cure_hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, settlement_helper());
    dispatcher
        .settle_cure_from_helper(id, 2, member_2(), usdc(), AMOUNT, 51, r, canonical_s(raw_s));
    assert(try_prepare(dispatcher, id), 'claim preserved');
    assert(dispatcher.get_payout_state(id, 2).status == PayoutStatus::DeferredLocked, 'locked');
    assert(dispatcher.get_circle(id).status == CircleStatus::Active, 'unchanged');
}

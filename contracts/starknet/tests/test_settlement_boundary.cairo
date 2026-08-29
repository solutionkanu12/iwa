// Task 8A-S: core helper authority and round-local financial conservation.
// No STRK20 types or token movement exist in this test slice.

use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    ContributionStatus, PayoutStatus, contribution_settlement_authorization_hash,
    cure_settlement_authorization_hash, invite_commitment, payout_authorization_hash,
    payout_settlement_authorization_hash, recovery_settlement_authorization_hash,
    verify_cure_settlement_authorization, verify_payout_settlement_authorization,
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
const POT: u128 = AMOUNT * 2;
const ACTIVATED_AT: u64 = 1_000;
const DUE_AT: u64 = 1_100;

fn usdc() -> ContractAddress {
    0x111.try_into().unwrap()
}
fn strk() -> ContractAddress {
    0x222.try_into().unwrap()
}
fn helper() -> ContractAddress {
    0x333.try_into().unwrap()
}
fn other_helper() -> ContractAddress {
    0x334.try_into().unwrap()
}
fn pool() -> ContractAddress {
    0x444.try_into().unwrap()
}
fn other_pool() -> ContractAddress {
    0x445.try_into().unwrap()
}
fn setup_authority() -> ContractAddress {
    0x666.try_into().unwrap()
}
fn organizer() -> ContractAddress {
    0xabc.try_into().unwrap()
}
fn attacker() -> ContractAddress {
    0xdead.try_into().unwrap()
}
fn member_1() -> felt252 {
    invite_commitment(SECRET_1, key(0x101).public_key)
}
fn member_2() -> felt252 {
    invite_commitment(SECRET_2, key(0x102).public_key)
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

fn deploy_uninitialized() -> IIwaCircleDispatcher {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    strk().serialize(ref calldata);
    pool().serialize(ref calldata);
    setup_authority().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    IIwaCircleDispatcher { contract_address: address }
}

fn deploy() -> IIwaCircleDispatcher {
    let dispatcher = deploy_uninitialized();
    start_cheat_caller_address(dispatcher.contract_address, setup_authority());
    dispatcher.initialize_settlement_helper(helper());
    dispatcher
}

fn deployment_rejected(
    usdc_address: ContractAddress,
    strk_address: ContractAddress,
    pool_address: ContractAddress,
    authority: ContractAddress,
) -> bool {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc_address.serialize(ref calldata);
    strk_address.serialize(ref calldata);
    pool_address.serialize(ref calldata);
    authority.serialize(ref calldata);
    contract.deploy(@calldata).is_err()
}

fn activate(dispatcher: IIwaCircleDispatcher) -> u32 {
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = dispatcher
        .create_circle(usdc(), AMOUNT, 100, 50, 2, array![member_1(), member_2()].span());
    dispatcher.join_circle(id, SECRET_1, key(0x101).public_key);
    start_cheat_block_timestamp(dispatcher.contract_address, ACTIVATED_AT);
    dispatcher.join_circle(id, SECRET_2, key(0x102).public_key);
    id
}

fn sign_contribution(
    signer: StarkCurveKeyPair,
    id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = contribution_settlement_authorization_hash(
        id, round, member_ref, helper(), pool(), usdc(), amount, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn settle_contribution(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    round: u32,
    member_ref: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) {
    let (r, s) = sign_contribution(signer, id, round, member_ref, AMOUNT, nonce);
    start_cheat_caller_address(dispatcher.contract_address, helper());
    dispatcher.settle_contribution_from_helper(id, round, member_ref, usdc(), AMOUNT, nonce, r, s);
}

fn default_member(dispatcher: IIwaCircleDispatcher, id: u32, round: u32, member_ref: felt252) {
    let grace = dispatcher.get_contribution_obligation(id, round, member_ref).grace_ends_at;
    start_cheat_block_timestamp(dispatcher.contract_address, grace + 1);
    dispatcher.finalize_contribution_default(id, round, member_ref);
}

fn sign_cure(
    signer: StarkCurveKeyPair, id: u32, round: u32, member_ref: felt252, nonce: felt252,
) -> (felt252, felt252) {
    let hash = cure_settlement_authorization_hash(
        id, round, member_ref, helper(), pool(), usdc(), AMOUNT, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn settle_cure(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    round: u32,
    member_ref: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) {
    let (r, s) = sign_cure(signer, id, round, member_ref, nonce);
    start_cheat_caller_address(dispatcher.contract_address, helper());
    dispatcher.settle_cure_from_helper(id, round, member_ref, usdc(), AMOUNT, nonce, r, s);
}

fn authorize_payout(
    dispatcher: IIwaCircleDispatcher,
    id: u32,
    round: u32,
    member_ref: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) {
    let hash = payout_authorization_hash(id, round, member_ref, POT, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    dispatcher.authorize_payout_settlement(id, round, nonce, r, canonical_s(raw_s));
}

fn sign_payout_settlement(
    signer: StarkCurveKeyPair,
    id: u32,
    round: u32,
    member_ref: felt252,
    open_note_id: felt252,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = payout_settlement_authorization_hash(
        id, round, member_ref, helper(), pool(), usdc(), POT, open_note_id, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn try_call(dispatcher: IIwaCircleDispatcher, selector: felt252, calldata: Span<felt252>) -> bool {
    call_contract_syscall(dispatcher.contract_address, selector, calldata).is_err()
}

fn contribution_calldata(
    id: u32,
    round: u32,
    member_ref: felt252,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
    r: felt252,
    s: felt252,
) -> Array<felt252> {
    let mut calldata = array![];
    id.serialize(ref calldata);
    round.serialize(ref calldata);
    member_ref.serialize(ref calldata);
    token.serialize(ref calldata);
    amount.serialize(ref calldata);
    nonce.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    calldata
}

#[test]
fn constructor_validates_setup_pool_and_tokens() {
    let zero: ContractAddress = 0.try_into().unwrap();
    assert(deployment_rejected(zero, strk(), pool(), setup_authority()), 'zero usdc');
    assert(deployment_rejected(usdc(), zero, pool(), setup_authority()), 'zero strk');
    assert(deployment_rejected(usdc(), strk(), zero, setup_authority()), 'zero pool');
    assert(deployment_rejected(usdc(), strk(), pool(), zero), 'zero authority');
    assert(deployment_rejected(usdc(), usdc(), pool(), setup_authority()), 'same token');
}

#[test]
fn helper_is_unset_until_setup_authority_initializes_once() {
    let dispatcher = deploy_uninitialized();
    let config = dispatcher.get_settlement_config();
    let zero: ContractAddress = 0.try_into().unwrap();
    assert(config.settlement_helper == zero, 'initially unset');
    assert(config.privacy_pool == pool(), 'pool');
    assert(config.setup_authority == setup_authority(), 'authority');
    assert(!config.helper_initialized, 'unlocked');

    let mut calldata = array![];
    helper().serialize(ref calldata);
    start_cheat_caller_address(dispatcher.contract_address, attacker());
    assert(
        try_call(dispatcher, selector!("initialize_settlement_helper"), calldata.span()),
        'attacker rejected',
    );
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    assert(
        try_call(dispatcher, selector!("initialize_settlement_helper"), calldata.span()),
        'organizer rejected',
    );

    let mut zero_calldata = array![];
    zero.serialize(ref zero_calldata);
    start_cheat_caller_address(dispatcher.contract_address, setup_authority());
    assert(
        try_call(dispatcher, selector!("initialize_settlement_helper"), zero_calldata.span()),
        'zero helper rejected',
    );
    dispatcher.initialize_settlement_helper(helper());

    let locked = dispatcher.get_settlement_config();
    assert(locked.settlement_helper == helper(), 'helper stored');
    assert(locked.setup_authority == zero, 'authority cleared');
    assert(locked.helper_initialized, 'locked');

    let mut replacement = array![];
    other_helper().serialize(ref replacement);
    start_cheat_caller_address(dispatcher.contract_address, setup_authority());
    assert(
        try_call(dispatcher, selector!("initialize_settlement_helper"), replacement.span()),
        'second initialization rejected',
    );
    assert(dispatcher.get_settlement_config() == locked, 'immutable');
    assert(
        try_call(dispatcher, selector!("set_settlement_helper"), replacement.span()),
        'no replacement setter',
    );
}

#[test]
fn financial_settlement_rejects_before_helper_initialization() {
    let dispatcher = deploy_uninitialized();
    let id = activate(dispatcher);
    let (r, s) = sign_contribution(key(0x101), id, 1, member_1(), AMOUNT, 99);
    let calldata = contribution_calldata(id, 1, member_1(), usdc(), AMOUNT, 99, r, s);
    start_cheat_caller_address(dispatcher.contract_address, helper());
    assert(
        try_call(dispatcher, selector!("settle_contribution_from_helper"), calldata.span()),
        'unset helper rejected',
    );
    let cure_calldata = contribution_calldata(id, 1, member_1(), usdc(), AMOUNT, 100, r, s);
    assert(
        try_call(dispatcher, selector!("settle_cure_from_helper"), cure_calldata.span()),
        'unset cure rejected',
    );
    let mut outbound_calldata = array![];
    id.serialize(ref outbound_calldata);
    1_u32.serialize(ref outbound_calldata);
    usdc().serialize(ref outbound_calldata);
    0x999.serialize(ref outbound_calldata);
    101.serialize(ref outbound_calldata);
    r.serialize(ref outbound_calldata);
    s.serialize(ref outbound_calldata);
    assert(
        try_call(dispatcher, selector!("settle_payout_from_helper"), outbound_calldata.span()),
        'unset payout rejected',
    );
    assert(
        try_call(dispatcher, selector!("settle_recovery_from_helper"), outbound_calldata.span()),
        'unset recovery rejected',
    );
    assert(!dispatcher.is_contribution_nonce_consumed(id, member_1(), 99), 'nonce unused');
}

#[test]
fn organizer_can_initialize_only_when_explicitly_chosen_as_setup_authority() {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    strk().serialize(ref calldata);
    pool().serialize(ref calldata);
    organizer().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    let dispatcher = IIwaCircleDispatcher { contract_address: address };

    start_cheat_caller_address(dispatcher.contract_address, organizer());
    dispatcher.initialize_settlement_helper(helper());
    let config = dispatcher.get_settlement_config();
    let zero: ContractAddress = 0.try_into().unwrap();
    assert(config.settlement_helper == helper(), 'helper');
    assert(config.setup_authority == zero, 'authority exhausted');
    assert(config.helper_initialized, 'locked');
}

#[test]
fn public_caller_cannot_financially_settle_contribution() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let (r, s) = sign_contribution(key(0x101), id, 1, member_1(), AMOUNT, 1);
    start_cheat_caller_address(dispatcher.contract_address, attacker());
    let calldata = contribution_calldata(id, 1, member_1(), usdc(), AMOUNT, 1, r, s);
    assert(
        try_call(dispatcher, selector!("settle_contribution_from_helper"), calldata.span()),
        'public rejected',
    );
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::Pending,
        'still pending',
    );
    assert(!dispatcher.is_contribution_nonce_consumed(id, member_1(), 1), 'nonce unused');
}

#[test]
fn helper_settles_exact_contribution_and_credits_only_its_round() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    start_cheat_block_timestamp(dispatcher.contract_address, DUE_AT);
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 2);
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::OnTime,
        'settled',
    );
    let liability = dispatcher.get_round_liability(id, 1);
    assert(liability.token == usdc(), 'token');
    assert(liability.settled_inflows == AMOUNT.into(), 'inflow');
    assert(liability.settled_outflows == 0, 'no outflow');
    assert(liability.outstanding == AMOUNT.into(), 'outstanding');
    assert(dispatcher.get_token_outstanding_liability(usdc()) == AMOUNT.into(), 'token total');
}

#[test]
fn contribution_fields_and_replay_are_enforced_before_writes() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    let (r, s) = sign_contribution(key(0x101), id, 1, member_1(), AMOUNT, 3);
    start_cheat_caller_address(dispatcher.contract_address, helper());
    let bad = array![
        contribution_calldata(id + 1, 1, member_1(), usdc(), AMOUNT, 3, r, s),
        contribution_calldata(id, 2, member_1(), usdc(), AMOUNT, 3, r, s),
        contribution_calldata(id, 1, member_2(), usdc(), AMOUNT, 3, r, s),
        contribution_calldata(id, 1, member_1(), strk(), AMOUNT, 3, r, s),
        contribution_calldata(id, 1, member_1(), usdc(), AMOUNT + 1, 3, r, s),
    ];
    let mut i = 0;
    while i < bad.len() {
        assert(
            try_call(dispatcher, selector!("settle_contribution_from_helper"), bad.at(i).span()),
            'bad field',
        );
        i += 1;
    }
    assert(!dispatcher.is_contribution_nonce_consumed(id, member_1(), 3), 'not consumed');
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 3);
    let (r, s) = sign_contribution(key(0x101), id, 1, member_1(), AMOUNT, 3);
    let replay = contribution_calldata(id, 1, member_1(), usdc(), AMOUNT, 3, r, s);
    assert(
        try_call(dispatcher, selector!("settle_contribution_from_helper"), replay.span()), 'replay',
    );
}

#[test]
fn cure_financial_state_is_helper_only_and_atomic() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    default_member(dispatcher, id, 1, member_1());
    let (r, s) = sign_cure(key(0x101), id, 1, member_1(), 4);
    start_cheat_caller_address(dispatcher.contract_address, attacker());
    let mut calldata = contribution_calldata(id, 1, member_1(), usdc(), AMOUNT, 4, r, s);
    assert(try_call(dispatcher, selector!("settle_cure_from_helper"), calldata.span()), 'public');
    assert(!dispatcher.get_cure_state(id, 1, member_1()).deficit_settled, 'unsettled');
    assert(!dispatcher.is_cure_nonce_consumed(id, member_1(), 4), 'nonce');
    settle_cure(dispatcher, id, 1, member_1(), key(0x101), 4);
    assert(dispatcher.get_cure_state(id, 1, member_1()).deficit_settled, 'cured');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::MissedDefault,
        'history',
    );
    assert(dispatcher.get_round_liability(id, 1).outstanding == AMOUNT.into(), 'funded');
}

#[test]
fn settlement_hashes_bind_helper_pool_token_amount_and_open_note() {
    let payout_hash = payout_settlement_authorization_hash(
        1, 1, member_1(), helper(), pool(), usdc(), POT, 0x999, 5,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), payout_hash).unwrap();
    let s = canonical_s(raw_s);
    assert(
        verify_payout_settlement_authorization(
            key(0x101).public_key, 1, 1, member_1(), helper(), pool(), usdc(), POT, 0x999, 5, r, s,
        ),
        'valid',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key, 1, 1, member_1(), helper(), pool(), usdc(), POT, 0x998, 5, r, s,
        ),
        'note bound',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key,
            1,
            1,
            member_1(),
            other_helper(),
            pool(),
            usdc(),
            POT,
            0x999,
            5,
            r,
            s,
        ),
        'helper bound',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key,
            1,
            1,
            member_1(),
            helper(),
            other_pool(),
            usdc(),
            POT,
            0x999,
            5,
            r,
            s,
        ),
        'pool bound',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key, 1, 1, member_1(), helper(), pool(), strk(), POT, 0x999, 5, r, s,
        ),
        'token bound',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key,
            1,
            1,
            member_1(),
            helper(),
            pool(),
            usdc(),
            POT - 1,
            0x999,
            5,
            r,
            s,
        ),
        'amount bound',
    );
}

#[test]
fn all_financial_domains_are_cross_replay_resistant() {
    let contribution_hash = contribution_settlement_authorization_hash(
        1, 1, member_1(), helper(), pool(), usdc(), AMOUNT, 6,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), contribution_hash).unwrap();
    let s = canonical_s(raw_s);
    assert(
        !verify_cure_settlement_authorization(
            key(0x101).public_key, 1, 1, member_1(), helper(), pool(), usdc(), AMOUNT, 6, r, s,
        ),
        'contribution not cure',
    );
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key,
            1,
            1,
            member_1(),
            helper(),
            pool(),
            usdc(),
            AMOUNT,
            0x999,
            6,
            r,
            s,
        ),
        'contribution not payout',
    );
    let recovery_hash = recovery_settlement_authorization_hash(
        1, 1, member_1(), helper(), pool(), usdc(), AMOUNT, 0x999, 6,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), recovery_hash).unwrap();
    assert(
        !verify_payout_settlement_authorization(
            key(0x101).public_key,
            1,
            1,
            member_1(),
            helper(),
            pool(),
            usdc(),
            AMOUNT,
            0x999,
            6,
            r,
            canonical_s(raw_s),
        ),
        'recovery not payout',
    );
}

#[test]
fn peer_default_locks_full_payout_and_final_recovery_is_round_local() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 7);
    default_member(dispatcher, id, 1, member_2());
    let payout = dispatcher.finalize_round_payout_accounting(id, 1);
    assert(payout.status == PayoutStatus::DeferredLocked, 'any deficit locks');
    assert(payout.scheduled_member_ref == member_1(), 'recipient');
    assert(payout.amount == POT, 'nominal');
    assert(dispatcher.get_round_unresolved_deficit(id, 1) == AMOUNT, 'deficit');
    assert(dispatcher.get_round_liability(id, 1).outstanding == AMOUNT.into(), 'round funded');
}

#[test]
fn payout_financial_settlement_is_helper_only_and_debits_same_round() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 70);
    settle_contribution(dispatcher, id, 1, member_2(), key(0x102), 71);
    dispatcher.finalize_round_payout_accounting(id, 1);
    authorize_payout(dispatcher, id, 1, member_1(), key(0x101), 72);
    let (r, s) = sign_payout_settlement(key(0x101), id, 1, member_1(), 0x999, 73);
    start_cheat_caller_address(dispatcher.contract_address, attacker());
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    usdc().serialize(ref calldata);
    0x999.serialize(ref calldata);
    73.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    assert(try_call(dispatcher, selector!("settle_payout_from_helper"), calldata.span()), 'public');
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::SettlementAuthorized, 'prep');
    assert(!dispatcher.is_payout_settlement_nonce_consumed(id, member_1(), 73), 'nonce');
    start_cheat_caller_address(dispatcher.contract_address, helper());
    dispatcher.settle_payout_from_helper(id, 1, usdc(), 0x999, 73, r, s);
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::Paid, 'paid');
    let liability = dispatcher.get_round_liability(id, 1);
    assert(liability.settled_inflows == POT.into(), 'in');
    assert(liability.settled_outflows == POT.into(), 'out');
    assert(liability.outstanding == 0, 'conserved');
    assert(dispatcher.get_token_outstanding_liability(usdc()) == 0, 'token conserved');
}

#[test]
fn full_payout_cannot_use_another_round_or_unfunded_value() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 74);
    default_member(dispatcher, id, 1, member_2());
    dispatcher.finalize_round_payout_accounting(id, 1);
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::DeferredLocked, 'locked');
    let (r, s) = sign_payout_settlement(key(0x101), id, 1, member_1(), 0x999, 75);
    start_cheat_caller_address(dispatcher.contract_address, helper());
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    usdc().serialize(ref calldata);
    0x999.serialize(ref calldata);
    75.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    assert(
        try_call(dispatcher, selector!("settle_payout_from_helper"), calldata.span()), 'unfunded',
    );
    assert(dispatcher.get_round_liability(id, 1).outstanding == AMOUNT.into(), 'unchanged');
}

#[test]
fn final_recovery_amount_is_immutable_net_funded_and_uses_separate_domain() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    settle_contribution(dispatcher, id, 1, member_1(), key(0x101), 80);
    default_member(dispatcher, id, 1, member_2());
    dispatcher.finalize_round_payout_accounting(id, 1);

    settle_contribution(dispatcher, id, 2, member_1(), key(0x101), 81);
    settle_contribution(dispatcher, id, 2, member_2(), key(0x102), 82);
    dispatcher.finalize_round_payout_accounting(id, 2);
    authorize_payout(dispatcher, id, 2, member_2(), key(0x102), 83);
    dispatcher.prepare_final_settlement(id);

    let payout = dispatcher.get_payout_state(id, 1);
    assert(payout.status == PayoutStatus::RecoveryPending, 'recovery');
    assert(payout.scheduled_member_ref == member_1(), 'recipient');
    assert(payout.amount == POT, 'nominal preserved');
    assert(dispatcher.get_recovery_amount(id, 1) == AMOUNT, 'net funded');

    let recovery_hash = recovery_settlement_authorization_hash(
        id, 1, member_1(), helper(), pool(), usdc(), AMOUNT, 0xaaa, 84,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), recovery_hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, helper());
    dispatcher.settle_recovery_from_helper(id, 1, usdc(), 0xaaa, 84, r, canonical_s(raw_s));
    assert(dispatcher.get_payout_state(id, 1).status == PayoutStatus::Recovered, 'recovered');
    assert(dispatcher.get_recovery_amount(id, 1) == AMOUNT, 'immutable');
    assert(dispatcher.is_recovery_settlement_nonce_consumed(id, member_1(), 84), 'nonce');
    let mut replay_calldata = array![];
    id.serialize(ref replay_calldata);
    1_u32.serialize(ref replay_calldata);
    usdc().serialize(ref replay_calldata);
    0xaaa.serialize(ref replay_calldata);
    84.serialize(ref replay_calldata);
    r.serialize(ref replay_calldata);
    canonical_s(raw_s).serialize(ref replay_calldata);
    assert(
        call_contract_syscall(
            dispatcher.contract_address,
            selector!("settle_recovery_from_helper"),
            replay_calldata.span(),
        )
            .is_err(),
        'replay',
    );
    assert(dispatcher.get_round_liability(id, 1).outstanding == 0, 'round debited');
    assert(dispatcher.get_round_liability(id, 2).outstanding == POT.into(), 'round two untouched');
}

#[test]
fn fully_unfunded_round_has_terminal_zero_recovery_without_nonce_consumption() {
    let dispatcher = deploy();
    let id = activate(dispatcher);
    default_member(dispatcher, id, 1, member_1());
    default_member(dispatcher, id, 1, member_2());
    let round_one = dispatcher.finalize_round_payout_accounting(id, 1);
    assert(round_one.status == PayoutStatus::DeferredLocked, 'initially locked');

    settle_contribution(dispatcher, id, 2, member_1(), key(0x101), 90);
    settle_contribution(dispatcher, id, 2, member_2(), key(0x102), 91);
    dispatcher.finalize_round_payout_accounting(id, 2);
    authorize_payout(dispatcher, id, 2, member_2(), key(0x102), 92);
    dispatcher.prepare_final_settlement(id);

    let terminal = dispatcher.get_payout_state(id, 1);
    assert(terminal.status == PayoutStatus::NoFundedRecovery, 'zero terminal');
    assert(terminal.scheduled_member_ref == member_1(), 'recipient preserved');
    assert(terminal.amount == POT, 'nominal preserved');
    assert(dispatcher.get_recovery_amount(id, 1) == 0, 'zero recovery');
    assert(dispatcher.get_round_unresolved_deficit(id, 1) == POT, 'full deficit');
    assert(dispatcher.get_round_liability(id, 1).outstanding == 0, 'no liability');
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::MissedDefault,
        'first history',
    );
    assert(
        dispatcher
            .get_contribution_obligation(id, 1, member_2())
            .status == ContributionStatus::MissedDefault,
        'second history',
    );

    let nonce = 93;
    let recovery_hash = recovery_settlement_authorization_hash(
        id, 1, member_1(), helper(), pool(), usdc(), 0, 0xaaa, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), recovery_hash).unwrap();
    start_cheat_caller_address(dispatcher.contract_address, helper());
    let mut calldata = array![];
    id.serialize(ref calldata);
    1_u32.serialize(ref calldata);
    usdc().serialize(ref calldata);
    0xaaa.serialize(ref calldata);
    nonce.serialize(ref calldata);
    r.serialize(ref calldata);
    canonical_s(raw_s).serialize(ref calldata);
    assert(
        try_call(dispatcher, selector!("settle_recovery_from_helper"), calldata.span()),
        'zero settlement rejected',
    );
    assert(!dispatcher.is_recovery_settlement_nonce_consumed(id, member_1(), nonce), 'nonce free');
    assert(
        dispatcher.get_payout_state(id, 1).status == PayoutStatus::NoFundedRecovery,
        'cannot reopen',
    );
    let mut final_calldata = array![];
    id.serialize(ref final_calldata);
    assert(
        try_call(dispatcher, selector!("prepare_final_settlement"), final_calldata.span()),
        'final replay rejected',
    );
    assert(
        dispatcher.get_payout_state(id, 1).status == PayoutStatus::NoFundedRecovery,
        'terminal unchanged',
    );
}

#[test]
fn no_generic_financial_setter_exists() {
    let dispatcher = deploy();
    let mut calldata = array![];
    1_u32.serialize(ref calldata);
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    assert(
        try_call(dispatcher, selector!("set_liability"), calldata.span()), 'no liability setter',
    );
    assert(try_call(dispatcher, selector!("mark_paid"), calldata.span()), 'no paid setter');
    assert(
        try_call(dispatcher, selector!("mark_recovered"), calldata.span()), 'no recovery setter',
    );
}

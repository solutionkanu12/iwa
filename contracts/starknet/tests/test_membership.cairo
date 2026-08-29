use core::poseidon::poseidon_hash_span;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{CircleStatus, INVITE_DOMAIN_TAG, invite_commitment};
use snforge_std::signature::stark_curve::StarkCurveKeyPairImpl;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address};
use starknet::ContractAddress;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const SECRET_3: felt252 = 'secret-3';

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

fn auth_key(secret_key: felt252) -> felt252 {
    StarkCurveKeyPairImpl::from_secret_key(secret_key).public_key
}

/// IWA-01: the invite commitment binds the member authentication key.
fn invite(secret: felt252) -> felt252 {
    invite_commitment(secret, auth_key_for(secret))
}

fn auth_key_for(secret: felt252) -> felt252 {
    if secret == SECRET_1 {
        auth_key(0x101)
    } else if secret == SECRET_2 {
        auth_key(0x102)
    } else {
        auth_key(0x103)
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

fn invite_order() -> Array<felt252> {
    array![invite(SECRET_1), invite(SECRET_2), invite(SECRET_3)]
}

fn open_circle(dispatcher: IIwaCircleDispatcher) -> u32 {
    dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, invite_order().span())
}

fn join_all(dispatcher: IIwaCircleDispatcher, id: u32) {
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    dispatcher.join_circle(id, SECRET_2, auth_key(0x102));
    dispatcher.join_circle(id, SECRET_3, auth_key(0x103));
}

#[test]
fn valid_invite_secret_joins() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let commitment = invite(SECRET_2);
    let slot = dispatcher.join_circle(id, SECRET_2, auth_key(0x102));
    assert(slot == 1, 'slot is payout-order index');
    assert(dispatcher.is_member(id, commitment), 'joined as commitment');
    assert(!dispatcher.is_member(id, invite(SECRET_1)), 's1 not yet joined');
    assert(dispatcher.get_circle(id).joined_count == 1, 'count 1');
    assert(dispatcher.get_circle(id).status == CircleStatus::OpenForMembers, 'still open');
}

#[test]
fn invite_commitment_is_domain_separated() {
    let member_key = auth_key(0x101);
    let hashed = invite(SECRET_1);
    assert(hashed != SECRET_1, 'not the preimage');
    assert(hashed != poseidon_hash_span(array![SECRET_1].span()), 'uses domain tag');
    assert(
        hashed != poseidon_hash_span(array![INVITE_DOMAIN_TAG, SECRET_1].span()),
        'key is bound too',
    );
    assert(
        hashed == poseidon_hash_span(array![INVITE_DOMAIN_TAG, SECRET_1, member_key].span()),
        'tag secret and key',
    );
}

#[test]
fn joined_count_increments_exactly_once_per_invite() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    dispatcher.join_circle(id, SECRET_3, auth_key(0x103));
    assert(dispatcher.get_circle(id).joined_count == 2, 'count 2');
}

#[test]
fn payout_order_unchanged_after_join_and_never_stores_secret() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let before: Array<felt252> = dispatcher.get_payout_order(id);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    let after: Array<felt252> = dispatcher.get_payout_order(id);
    assert(*before.at(0) == invite(SECRET_1), 'stores commitment');
    assert(*before.at(0) != SECRET_1, 'secret not stored');
    assert(after.len() == before.len(), 'len');
    assert(*after.at(0) == *before.at(0), 'slot 0');
    assert(*after.at(1) == *before.at(1), 'slot 1');
    assert(*after.at(2) == *before.at(2), 'slot 2');
}

#[test]
fn all_required_valid_invite_claims_activate_the_circle() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    dispatcher.join_circle(id, SECRET_2, auth_key(0x102));
    assert(dispatcher.get_circle(id).status == CircleStatus::OpenForMembers, 'not yet');
    dispatcher.join_circle(id, SECRET_3, auth_key(0x103));
    let circle = dispatcher.get_circle(id);
    assert(circle.status == CircleStatus::Active, 'active');
    assert(circle.joined_count == 3, 'full');
}

#[test]
#[should_panic(expected: ('IWA: not member', 'ENTRYPOINT_FAILED'))]
fn wrong_secret_fails() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, 'wrong-secret', auth_key(0x104));
}

#[test]
#[should_panic(expected: ('IWA: not member', 'ENTRYPOINT_FAILED'))]
fn stored_commitment_cannot_claim_the_slot() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let commitment = invite(SECRET_1);
    dispatcher.join_circle(id, commitment, auth_key(0x101));
}

#[test]
#[should_panic(expected: ('IWA: already member', 'ENTRYPOINT_FAILED'))]
fn duplicate_secret_use_fails() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
}

/// IWA-01: the same secret presented with a different authentication key is not
/// a duplicate join, it is simply not a committed slot at all.
#[test]
#[should_panic(expected: ('IWA: not member', 'ENTRYPOINT_FAILED'))]
fn secret_with_substituted_auth_key_matches_no_slot() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x999));
}

#[test]
#[should_panic(expected: ('IWA: join closed', 'ENTRYPOINT_FAILED'))]
fn join_after_active_fails() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    join_all(dispatcher, id);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
}

#[test]
#[should_panic(expected: ('IWA: join closed', 'ENTRYPOINT_FAILED'))]
fn member_limit_cannot_be_exceeded() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    join_all(dispatcher, id);
    dispatcher.join_circle(id, 'secret-4', auth_key(0x104));
}

#[test]
#[should_panic(expected: ('IWA: not member', 'ENTRYPOINT_FAILED'))]
fn organizer_cannot_bypass_invite_proof() {
    let dispatcher = deploy();
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, 'organizer-pick', auth_key(0x104));
}

#[test]
fn organizer_valid_secret_does_not_reorder_or_bind_caller() {
    let dispatcher = deploy();
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, auth_key(0x101));
    let order: Array<felt252> = dispatcher.get_payout_order(id);
    assert(*order.at(0) == invite(SECRET_1), 'order intact');
    assert(*order.at(1) == invite(SECRET_2), 'no replacement');
    assert(*order.at(0) != SECRET_1, 'secret not in order');
    assert(dispatcher.get_circle(id).status == CircleStatus::OpenForMembers, 'not forced active');
    assert(dispatcher.get_circle(id).joined_count == 1, 'one join only');
    assert(dispatcher.get_circle(id).organizer == organizer(), 'caller is operational only');
}

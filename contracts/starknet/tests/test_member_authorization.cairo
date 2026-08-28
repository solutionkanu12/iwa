use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    contribution_authorization_hash, invite_commitment, is_valid_auth_public_key,
    verify_contribution_authorization,
};
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address};
use starknet::ContractAddress;
use starknet::syscalls::call_contract_syscall;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const SECRET_3: felt252 = 'secret-3';
const MEMBER_REF: felt252 = 0x456;
const AMOUNT: u128 = 5_000_000;
const NONCE: felt252 = 0x789;

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

fn unrelated_caller() -> ContractAddress {
    0xdef.try_into().unwrap()
}

fn key_1() -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(0x12345)
}

fn key_2() -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(0x67890)
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

fn invite_order() -> Array<felt252> {
    array![invite_commitment(SECRET_1), invite_commitment(SECRET_2), invite_commitment(SECRET_3)]
}

fn open_circle(dispatcher: IIwaCircleDispatcher) -> u32 {
    dispatcher.create_circle(usdc(), AMOUNT, 604_800_u64, 86_400_u64, 3_u8, invite_order().span())
}

fn assert_missing_auth_mutator(
    address: ContractAddress, selector: felt252, calldata: Span<felt252>,
) {
    match call_contract_syscall(address, selector, calldata) {
        Result::Ok(_) => { core::panic_with_felt252('auth mutator must not exist'); },
        Result::Err(data) => {
            assert(*data.at(0) == 'ENTRYPOINT_NOT_FOUND', 'entrypoint missing');
        },
    }
}

#[test]
fn valid_invite_registers_auth_public_key_for_member_ref() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let keypair = key_1();
    let slot = dispatcher.join_circle(id, SECRET_1, keypair.public_key);
    assert(slot == 0, 'slot');
    assert(
        dispatcher.get_member_auth_key(id, invite_commitment(SECRET_1)) == keypair.public_key,
        'auth key persisted',
    );
}

#[test]
#[should_panic(expected: ('IWA: invalid auth key', 'ENTRYPOINT_FAILED'))]
fn zero_auth_public_key_is_rejected() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1, 0);
}

#[test]
#[should_panic(expected: ('IWA: invalid auth key', 'ENTRYPOINT_FAILED'))]
fn structurally_invalid_auth_public_key_is_rejected() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let invalid_key = 5;
    assert(!is_valid_auth_public_key(invalid_key), 'fixture invalid');
    dispatcher.join_circle(id, SECRET_1, invalid_key);
}

#[test]
fn auth_public_key_cannot_be_changed_after_join() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let first = key_1();
    dispatcher.join_circle(id, SECRET_1, first.public_key);

    let mut calldata = array![];
    id.serialize(ref calldata);
    invite_commitment(SECRET_1).serialize(ref calldata);
    key_2().public_key.serialize(ref calldata);
    assert_missing_auth_mutator(
        dispatcher.contract_address, selector!("set_member_auth_key"), calldata.span(),
    );
    assert(
        dispatcher.get_member_auth_key(id, invite_commitment(SECRET_1)) == first.public_key,
        'key unchanged',
    );
}

#[test]
fn organizer_cannot_replace_member_auth_public_key() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let first = key_1();
    dispatcher.join_circle(id, SECRET_1, first.public_key);
    start_cheat_caller_address(dispatcher.contract_address, organizer());

    let mut calldata = array![];
    id.serialize(ref calldata);
    invite_commitment(SECRET_1).serialize(ref calldata);
    key_2().public_key.serialize(ref calldata);
    assert_missing_auth_mutator(
        dispatcher.contract_address, selector!("replace_member_auth_key"), calldata.span(),
    );
    assert(
        dispatcher.get_member_auth_key(id, invite_commitment(SECRET_1)) == first.public_key,
        'organizer cannot replace',
    );
}

#[test]
fn unrelated_caller_cannot_replace_member_auth_public_key() {
    let dispatcher = deploy();
    let id = open_circle(dispatcher);
    let first = key_1();
    dispatcher.join_circle(id, SECRET_1, first.public_key);
    start_cheat_caller_address(dispatcher.contract_address, unrelated_caller());

    let mut calldata = array![];
    id.serialize(ref calldata);
    invite_commitment(SECRET_1).serialize(ref calldata);
    key_2().public_key.serialize(ref calldata);
    assert_missing_auth_mutator(
        dispatcher.contract_address, selector!("replace_member_auth_key"), calldata.span(),
    );
    assert(
        dispatcher.get_member_auth_key(id, invite_commitment(SECRET_1)) == first.public_key,
        'caller cannot replace',
    );
}

#[test]
fn joining_with_auth_keys_does_not_change_payout_order() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_2, key_2().public_key);
    let actual: Array<felt252> = dispatcher.get_payout_order(id);
    assert(actual == expected, 'order unchanged');
}

#[test]
fn contribution_authorization_hash_is_deterministic() {
    let first = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    let second = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(first == second, 'deterministic');
}

#[test]
fn changing_circle_id_changes_authorization_hash() {
    let baseline = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(
        baseline != contribution_authorization_hash(2, 2, MEMBER_REF, AMOUNT, NONCE),
        'circle bound',
    );
}

#[test]
fn changing_round_changes_authorization_hash() {
    let baseline = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(
        baseline != contribution_authorization_hash(1, 3, MEMBER_REF, AMOUNT, NONCE), 'round bound',
    );
}

#[test]
fn changing_member_ref_changes_authorization_hash() {
    let baseline = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(
        baseline != contribution_authorization_hash(1, 2, MEMBER_REF + 1, AMOUNT, NONCE),
        'member bound',
    );
}

#[test]
fn changing_amount_changes_authorization_hash() {
    let baseline = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(
        baseline != contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT + 1, NONCE),
        'amount bound',
    );
}

#[test]
fn changing_nonce_changes_authorization_hash() {
    let baseline = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    assert(
        baseline != contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE + 1),
        'nonce bound',
    );
}

#[test]
fn valid_signature_verifies_for_exact_contribution_authorization() {
    let keypair = key_1();
    let hash = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    let (r, raw_s) = StarkCurveSignerImpl::sign(keypair, hash).unwrap();
    let s = canonical_s(raw_s);
    assert(
        verify_contribution_authorization(
            keypair.public_key, 1, 2, MEMBER_REF, AMOUNT, NONCE, r, s,
        ),
        'signature valid',
    );
}

#[test]
fn signature_does_not_verify_when_any_authorized_field_changes() {
    let keypair = key_1();
    let hash = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    let (r, raw_s) = StarkCurveSignerImpl::sign(keypair, hash).unwrap();
    let s = canonical_s(raw_s);
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 2, 2, MEMBER_REF, AMOUNT, NONCE, r, s,
        ),
        'wrong circle',
    );
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 3, MEMBER_REF, AMOUNT, NONCE, r, s,
        ),
        'wrong round',
    );
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 2, MEMBER_REF + 1, AMOUNT, NONCE, r, s,
        ),
        'wrong member',
    );
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 2, MEMBER_REF, AMOUNT + 1, NONCE, r, s,
        ),
        'wrong amount',
    );
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 2, MEMBER_REF, AMOUNT, NONCE + 1, r, s,
        ),
        'wrong nonce',
    );
}

#[test]
fn non_canonical_signature_is_rejected() {
    let keypair = key_1();
    let hash = contribution_authorization_hash(1, 2, MEMBER_REF, AMOUNT, NONCE);
    let (r, raw_s) = StarkCurveSignerImpl::sign(keypair, hash).unwrap();
    let s = canonical_s(raw_s);
    let high_s = stark_curve::ORDER - s;
    assert(
        !verify_contribution_authorization(
            keypair.public_key, 1, 2, MEMBER_REF, AMOUNT, NONCE, r, high_s,
        ),
        'high-s rejected',
    );
}

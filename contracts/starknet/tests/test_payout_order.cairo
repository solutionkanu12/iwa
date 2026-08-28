use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{CircleStatus, invite_commitment};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address};
use starknet::ContractAddress;
use starknet::syscalls::call_contract_syscall;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const SECRET_3: felt252 = 'secret-3';

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
    0xdef.try_into().unwrap()
}

fn deploy() -> IIwaCircleDispatcher {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    strk().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    IIwaCircleDispatcher { contract_address: address }
}

fn invite_order() -> Array<felt252> {
    array![invite_commitment(SECRET_1), invite_commitment(SECRET_2), invite_commitment(SECRET_3)]
}

fn open_circle(dispatcher: IIwaCircleDispatcher) -> u32 {
    dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, invite_order().span())
}

fn assert_same_order(actual: @Array<felt252>, expected: @Array<felt252>) {
    assert(actual.len() == expected.len(), 'order len');
    let mut i: u32 = 0;
    while i < actual.len() {
        assert(actual.at(i) == expected.at(i), 'order slot');
        i += 1;
    }
}

fn assert_no_mutating_entrypoint(
    address: ContractAddress, selector: felt252, calldata: Span<felt252>,
) {
    match call_contract_syscall(address, selector, calldata) {
        Result::Ok(_) => { core::panic_with_felt252('payout mutator must not exist'); },
        Result::Err(data) => {
            assert(*data.at(0) == 'ENTRYPOINT_NOT_FOUND', 'entrypoint missing');
        },
    }
}

#[test]
fn payout_order_matches_creation_input() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, expected.span());
    assert(dispatcher.get_circle(id).payout_order_locked, 'locked at create');
    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
fn payout_order_unchanged_after_one_join() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_2);
    assert(dispatcher.get_circle(id).status == CircleStatus::OpenForMembers, 'still open');
    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
fn payout_order_unchanged_after_activation() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1);
    dispatcher.join_circle(id, SECRET_2);
    dispatcher.join_circle(id, SECRET_3);
    assert(dispatcher.get_circle(id).status == CircleStatus::Active, 'active');
    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
fn creating_another_circle_does_not_mutate_existing_order() {
    let dispatcher = deploy();
    let first_expected = invite_order();
    let first = open_circle(dispatcher);
    let second_order = array![invite_commitment('s-a'), invite_commitment('s-b')];
    let _second = dispatcher.create_circle(strk(), 1_u128, 1_u64, 1_u64, 2_u8, second_order.span());
    let stored: Array<felt252> = dispatcher.get_payout_order(first);
    assert_same_order(@stored, @first_expected);
}

#[test]
fn organizer_cannot_replace_or_reorder_payout_entries() {
    let dispatcher = deploy();
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let expected = invite_order();
    let id = open_circle(dispatcher);

    let mut replace_calldata = array![];
    id.serialize(ref replace_calldata);
    0_u8.serialize(ref replace_calldata);
    invite_commitment('intruder').serialize(ref replace_calldata);
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("set_payout_order"), replace_calldata.span(),
    );
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("replace_payout_entry"), replace_calldata.span(),
    );

    let mut reorder_calldata = array![];
    id.serialize(ref reorder_calldata);
    array![invite_commitment(SECRET_3), invite_commitment(SECRET_2), invite_commitment(SECRET_1)]
        .serialize(ref reorder_calldata);
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("reorder_payout_order"), reorder_calldata.span(),
    );

    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
fn member_cannot_reorder_payout_entries() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = open_circle(dispatcher);
    start_cheat_caller_address(dispatcher.contract_address, member_caller());

    let mut calldata = array![];
    id.serialize(ref calldata);
    array![invite_commitment(SECRET_2), invite_commitment(SECRET_1), invite_commitment(SECRET_3)]
        .serialize(ref calldata);
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("reorder_payout_order"), calldata.span(),
    );

    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
fn no_callable_path_mutates_payout_order_after_creation() {
    let dispatcher = deploy();
    let expected = invite_order();
    let id = open_circle(dispatcher);
    dispatcher.join_circle(id, SECRET_1);

    let mut calldata = array![];
    id.serialize(ref calldata);
    expected.serialize(ref calldata);
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("store_payout_order"), calldata.span(),
    );
    assert_no_mutating_entrypoint(
        dispatcher.contract_address, selector!("set_payout_order_len"), calldata.span(),
    );

    let stored: Array<felt252> = dispatcher.get_payout_order(id);
    assert_same_order(@stored, @expected);
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn duplicate_payout_order_refs_rejected_at_creation() {
    let dispatcher = deploy();
    let dup = invite_commitment(SECRET_1);
    dispatcher.create_circle(usdc(), 1_u128, 1_u64, 1_u64, 2_u8, array![dup, dup].span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn zero_payout_order_ref_rejected_at_creation() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(
            usdc(), 1_u128, 1_u64, 1_u64, 2_u8, array![invite_commitment(SECRET_1), 0].span(),
        );
}

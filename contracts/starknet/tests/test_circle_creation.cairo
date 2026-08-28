use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{CircleStatus, CureAmount, CureEligibility, CureWindow, SupportedAsset};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address,
};
use starknet::ContractAddress;

fn usdc() -> ContractAddress {
    0x111.try_into().unwrap()
}

fn strk() -> ContractAddress {
    0x222.try_into().unwrap()
}

fn unknown_token() -> ContractAddress {
    0x333.try_into().unwrap()
}

fn organizer() -> ContractAddress {
    0xabc.try_into().unwrap()
}

fn deploy() -> IIwaCircleDispatcher {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    strk().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    IIwaCircleDispatcher { contract_address: address }
}

fn valid_order() -> Array<felt252> {
    array!['m1', 'm2', 'm3']
}

fn create_valid(dispatcher: IIwaCircleDispatcher, token: ContractAddress) -> u32 {
    dispatcher
        .create_circle(token, 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, valid_order().span())
}

#[test]
fn valid_circle_creation_succeeds() {
    let dispatcher = deploy();
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    start_cheat_block_timestamp(dispatcher.contract_address, 1_700_000_000);
    let id = create_valid(dispatcher, usdc());
    assert(id == 1, 'first id is 1');

    let circle = dispatcher.get_circle(id);
    assert(circle.id == 1, 'id persisted');
    assert(circle.asset == SupportedAsset::Usdc, 'usdc');
    assert(circle.contribution_amount == 5_000_000_u128, 'amount');
    assert(circle.cadence_seconds == 604_800_u64, 'cadence');
    assert(circle.grace_period_seconds == 86_400_u64, 'grace');
    assert(circle.member_limit == 3_u8, 'limit');
    assert(circle.status == CircleStatus::OpenForMembers, 'open for members');
    assert(circle.current_round == 1, 'round 1');
    assert(circle.created_at == 1_700_000_000, 'created_at');
    assert(circle.organizer == organizer(), 'organizer recorded');
    assert(circle.payout_order_locked, 'order locked at creation');

    let order: Array<felt252> = dispatcher.get_payout_order(id);
    assert(order.len() == 3, 'order len');
    assert(*order.at(0) == 'm1', 'slot 0');
    assert(*order.at(1) == 'm2', 'slot 1');
    assert(*order.at(2) == 'm3', 'slot 2');
}

#[test]
fn strk_circle_creation_succeeds() {
    let dispatcher = deploy();
    let id = dispatcher.create_circle(strk(), 1_u128, 1_u64, 1_u64, 2_u8, array!['a', 'b'].span());
    let circle = dispatcher.get_circle(id);
    assert(circle.asset == SupportedAsset::Strk, 'strk');
}

#[test]
fn sequential_ids_are_gap_free() {
    let dispatcher = deploy();
    let first = create_valid(dispatcher, usdc());
    let second = dispatcher
        .create_circle(strk(), 10_u128, 10_u64, 10_u64, 2_u8, array!['x', 'y'].span());
    assert(first == 1, 'id 1');
    assert(second == 2, 'id 2');
}

#[test]
#[should_panic(expected: ('IWA: unsupported asset', 'ENTRYPOINT_FAILED'))]
fn unsupported_asset_fails() {
    let dispatcher = deploy();
    create_valid(dispatcher, unknown_token());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn zero_amount_fails() {
    let dispatcher = deploy();
    dispatcher.create_circle(usdc(), 0_u128, 604_800_u64, 86_400_u64, 3_u8, valid_order().span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn member_capacity_below_two_fails() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 1_u8, array!['m1'].span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn zero_cadence_fails() {
    let dispatcher = deploy();
    dispatcher.create_circle(usdc(), 5_000_000_u128, 0_u64, 86_400_u64, 3_u8, valid_order().span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn zero_grace_period_fails() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 0_u64, 3_u8, valid_order().span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn empty_payout_order_fails() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, array![].span());
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn payout_order_length_mismatch_fails() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(
            usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, array!['m1', 'm2'].span(),
        );
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn duplicate_payout_order_refs_fail() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(
            usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, array!['m1', 'm2', 'm1'].span(),
        );
}

#[test]
#[should_panic(expected: ('IWA: invalid config', 'ENTRYPOINT_FAILED'))]
fn zero_member_ref_in_payout_order_fails() {
    let dispatcher = deploy();
    dispatcher
        .create_circle(
            usdc(), 5_000_000_u128, 604_800_u64, 86_400_u64, 3_u8, array!['m1', 0, 'm3'].span(),
        );
}

#[test]
fn payout_order_is_not_the_organizer_and_cannot_redirect() {
    let dispatcher = deploy();
    start_cheat_caller_address(dispatcher.contract_address, organizer());
    let id = create_valid(dispatcher, usdc());
    let circle = dispatcher.get_circle(id);
    let order: Array<felt252> = dispatcher.get_payout_order(id);
    assert(circle.organizer == organizer(), 'organizer operational only');
    assert(*order.at(0) != organizer().into(), 'order is member refs');
    assert(*order.at(0) == 'm1', 'first recipient is m1');
}

#[test]
fn cure_config_is_the_locked_mvp_rules() {
    let dispatcher = deploy();
    let id = create_valid(dispatcher, usdc());
    let cure = dispatcher.get_cure_config(id);
    assert(cure.eligibility == CureEligibility::MissedDefaultObligation, 'missed-default only');
    assert(cure.window == CureWindow::UntilFinalSettlement, 'until final settlement');
    assert(cure.amount == CureAmount::ExactDeficit, 'exact deficit');
    assert(!cure.rewrite_history, 'history stays MISSED_DEFAULT');
    assert(!cure.admin_discretion, 'no admin waiver');
}

#[test]
#[should_panic(expected: ('IWA: circle not found', 'ENTRYPOINT_FAILED'))]
fn missing_circle_fails() {
    let dispatcher = deploy();
    dispatcher.get_circle(1);
}

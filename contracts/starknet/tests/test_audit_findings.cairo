//! IWA-01 regression coverage.
//!
//! Before the fix the invite commitment was `H(TAG, secret)`, so the secret was
//! a bearer credential: whoever presented it first registered the
//! authentication key that authorizes that slot's contributions, cures, payouts
//! and recoveries. The commitment is now `H(TAG, secret, auth_public_key)`, so a
//! stolen secret matches no slot unless it is presented with the exact key the
//! organizer committed.
//!
//! Membership is still not bound to any Starknet caller address: every join
//! below succeeds or fails purely on the (secret, key) pair, never on who sent
//! the transaction.

use core::ec::stark_curve;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_types::{
    contribution_settlement_authorization_hash, cure_settlement_authorization_hash,
    invite_commitment, payout_settlement_authorization_hash, recovery_settlement_authorization_hash,
    verify_contribution_settlement_authorization, verify_cure_settlement_authorization,
    verify_payout_settlement_authorization, verify_recovery_settlement_authorization,
};
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use starknet::syscalls::call_contract_syscall;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const AMOUNT: u128 = 5_000_000;
const NOTE: felt252 = 0x9001;

fn addr(v: felt252) -> ContractAddress {
    v.try_into().unwrap()
}
fn key(s: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(s)
}
fn victim_key() -> StarkCurveKeyPair {
    key(0x101)
}
fn attacker_key() -> StarkCurveKeyPair {
    key(0xbad)
}
fn helper() -> ContractAddress {
    addr(0x444)
}
fn pool() -> ContractAddress {
    addr(0x555)
}
fn usdc() -> ContractAddress {
    addr(0x111)
}

fn canonical_s(s: felt252) -> felt252 {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let v: u256 = s.into();
    if v > ORDER_U256 / 2 {
        stark_curve::ORDER - s
    } else {
        s
    }
}

fn deploy() -> IIwaCircleDispatcher {
    let contract = declare("IwaCircle").unwrap().contract_class();
    let mut calldata = array![];
    usdc().serialize(ref calldata);
    addr(0x222).serialize(ref calldata);
    pool().serialize(ref calldata);
    helper().serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    let d = IIwaCircleDispatcher { contract_address: address };
    start_cheat_caller_address(address, helper());
    d.initialize_settlement_helper(helper());
    stop_cheat_caller_address(address);
    d
}

/// The organizer commits each member's authentication key alongside the secret.
fn open_circle(d: IIwaCircleDispatcher) -> u32 {
    start_cheat_caller_address(d.contract_address, addr(0xabc));
    let id = d
        .create_circle(
            usdc(),
            AMOUNT,
            604_800_u64,
            86_400_u64,
            2_u8,
            array![
                invite_commitment(SECRET_1, victim_key().public_key),
                invite_commitment(SECRET_2, key(0x102).public_key),
            ]
                .span(),
        );
    stop_cheat_caller_address(d.contract_address);
    id
}

fn try_join(d: IIwaCircleDispatcher, id: u32, secret: felt252, auth_key: felt252) -> bool {
    let mut calldata = array![];
    id.serialize(ref calldata);
    secret.serialize(ref calldata);
    auth_key.serialize(ref calldata);
    call_contract_syscall(d.contract_address, selector!("join_circle"), calldata.span()).is_ok()
}

#[test]
fn stolen_invite_secret_alone_cannot_claim_a_member_slot() {
    let d = deploy();
    let id = open_circle(d);

    // The attacker has the victim's secret — read straight from the victim's
    // pending join calldata — but substitutes their own authentication key.
    // The commitment no longer matches any slot in the locked payout order.
    start_cheat_caller_address(d.contract_address, addr(0xdead));
    assert(!try_join(d, id, SECRET_1, attacker_key().public_key), 'attacker key rejected');
    stop_cheat_caller_address(d.contract_address);

    // The slot is untouched and still claimable by its rightful owner.
    let member = invite_commitment(SECRET_1, victim_key().public_key);
    assert(!d.is_member(id, member), 'slot still open');

    // The legitimate pair succeeds, from any address: membership is bound to
    // the (secret, key) pair, never to the Starknet caller.
    start_cheat_caller_address(d.contract_address, addr(0xfeed));
    assert(try_join(d, id, SECRET_1, victim_key().public_key), 'legitimate join succeeds');
    stop_cheat_caller_address(d.contract_address);

    assert(d.is_member(id, member), 'member joined');
    assert(d.get_member_auth_key(id, member) == victim_key().public_key, 'victim key stored');
    assert(d.get_member_auth_key(id, member) != attacker_key().public_key, 'not attacker key');
}

#[test]
fn attacker_key_cannot_authorize_any_financial_operation_for_the_slot() {
    let d = deploy();
    let id = open_circle(d);
    start_cheat_caller_address(d.contract_address, addr(0xfeed));
    try_join(d, id, SECRET_1, victim_key().public_key);
    stop_cheat_caller_address(d.contract_address);

    let member = invite_commitment(SECRET_1, victim_key().public_key);
    let stored = d.get_member_auth_key(id, member);

    // Contribution
    let c_hash = contribution_settlement_authorization_hash(
        id, 1, member, helper(), pool(), usdc(), AMOUNT, 1,
    );
    let (ar, a_raw) = StarkCurveSignerImpl::sign(attacker_key(), c_hash).unwrap();
    let (vr, v_raw) = StarkCurveSignerImpl::sign(victim_key(), c_hash).unwrap();
    assert(
        !verify_contribution_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, 1, ar, canonical_s(a_raw),
        ),
        'attacker cannot contribute',
    );
    assert(
        verify_contribution_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, 1, vr, canonical_s(v_raw),
        ),
        'member can contribute',
    );

    // Cure
    let cu_hash = cure_settlement_authorization_hash(
        id, 1, member, helper(), pool(), usdc(), AMOUNT, 2,
    );
    let (ar2, a2) = StarkCurveSignerImpl::sign(attacker_key(), cu_hash).unwrap();
    let (vr2, v2) = StarkCurveSignerImpl::sign(victim_key(), cu_hash).unwrap();
    assert(
        !verify_cure_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, 2, ar2, canonical_s(a2),
        ),
        'attacker cannot cure',
    );
    assert(
        verify_cure_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, 2, vr2, canonical_s(v2),
        ),
        'member can cure',
    );

    // Payout
    let p_hash = payout_settlement_authorization_hash(
        id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 3,
    );
    let (ar3, a3) = StarkCurveSignerImpl::sign(attacker_key(), p_hash).unwrap();
    let (vr3, v3) = StarkCurveSignerImpl::sign(victim_key(), p_hash).unwrap();
    assert(
        !verify_payout_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 3, ar3, canonical_s(a3),
        ),
        'attacker cannot payout',
    );
    assert(
        verify_payout_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 3, vr3, canonical_s(v3),
        ),
        'member can payout',
    );

    // Recovery
    let r_hash = recovery_settlement_authorization_hash(
        id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 4,
    );
    let (ar4, a4) = StarkCurveSignerImpl::sign(attacker_key(), r_hash).unwrap();
    let (vr4, v4) = StarkCurveSignerImpl::sign(victim_key(), r_hash).unwrap();
    assert(
        !verify_recovery_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 4, ar4, canonical_s(a4),
        ),
        'attacker cannot recover',
    );
    assert(
        verify_recovery_settlement_authorization(
            stored, id, 1, member, helper(), pool(), usdc(), AMOUNT, NOTE, 4, vr4, canonical_s(v4),
        ),
        'member can recover',
    );
}

#[test]
fn commitment_binds_both_secret_and_key() {
    // Changing either input changes the slot identity.
    let base = invite_commitment(SECRET_1, victim_key().public_key);
    assert(base != invite_commitment(SECRET_2, victim_key().public_key), 'secret is bound');
    assert(base != invite_commitment(SECRET_1, attacker_key().public_key), 'key is bound');
    assert(base == invite_commitment(SECRET_1, victim_key().public_key), 'deterministic');
}

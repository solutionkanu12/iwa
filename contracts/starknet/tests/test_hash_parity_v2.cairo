//! Cross-language parity for the V2 (Candidate P) destination-registration
//! hashes. The SAME fixed vector is pinned in
//! `iwa-web/src/chains/strk20/v2/iwaSigningV2.test.ts`. If the browser mirror
//! (`payoutDestV2Hash` / `recoveryDestV2Hash`) ever drifts from
//! `iwa_types_v2::{payout_dest_v2_hash, recovery_dest_v2_hash}`, one of the two
//! test suites fails offline.
//!
//! Runs on the default `snforge test` build — no feature flag, no pool.

use iwa::iwa_types_v2::{payout_dest_v2_hash, recovery_dest_v2_hash};
use starknet::ContractAddress;

fn addr(v: felt252) -> ContractAddress {
    v.try_into().unwrap()
}

// Fixed vector — must equal the constants in iwaSigningV2.test.ts.
const CIRCLE_CONTRACT: felt252 = 0x111;
const HELPER: felt252 = 0x222;
const POOL: felt252 = 0x333;
const TOKEN: felt252 = 0x444;
const CIRCLE_ID: u32 = 7;
const ROUND: u32 = 3;
const MEMBER_REF: felt252 = 0x555;
const NOTE_ID: felt252 = 0x666;
const AMOUNT: u128 = 10_000_000;
const DEST_EPOCH: u64 = 1;
const EXPIRY: u64 = 1_900_000_000;
const NONCE: felt252 = 0x777;

const EXPECTED_PAYOUT: felt252 =
    0x43f02f1e9910b82ac9a9b508cf6b8b01c7e8a217eb28a5c006d71e651b5d5cb;
const EXPECTED_RECOVERY: felt252 =
    0x112cf9ef76f805d1221726222634f67db9adba86889aa9babf136fed8ff00fd;

#[test]
fn payout_dest_v2_hash_matches_the_browser_vector() {
    let h = payout_dest_v2_hash(
        addr(CIRCLE_CONTRACT), addr(HELPER), addr(POOL), addr(TOKEN), CIRCLE_ID, ROUND, MEMBER_REF,
        NOTE_ID, AMOUNT, DEST_EPOCH, EXPIRY, NONCE,
    );
    assert(h == EXPECTED_PAYOUT, 'payout hash parity');
}

#[test]
fn recovery_dest_v2_hash_matches_the_browser_vector() {
    let h = recovery_dest_v2_hash(
        addr(CIRCLE_CONTRACT), addr(HELPER), addr(POOL), addr(TOKEN), CIRCLE_ID, ROUND, MEMBER_REF,
        NOTE_ID, AMOUNT, DEST_EPOCH, EXPIRY, NONCE,
    );
    assert(h == EXPECTED_RECOVERY, 'recovery hash parity');
}

#[test]
fn payout_and_recovery_hashes_differ_only_by_domain_tag() {
    let p = payout_dest_v2_hash(
        addr(CIRCLE_CONTRACT), addr(HELPER), addr(POOL), addr(TOKEN), CIRCLE_ID, ROUND, MEMBER_REF,
        NOTE_ID, AMOUNT, DEST_EPOCH, EXPIRY, NONCE,
    );
    let r = recovery_dest_v2_hash(
        addr(CIRCLE_CONTRACT), addr(HELPER), addr(POOL), addr(TOKEN), CIRCLE_ID, ROUND, MEMBER_REF,
        NOTE_ID, AMOUNT, DEST_EPOCH, EXPIRY, NONCE,
    );
    assert(p != r, 'domain separation');
}

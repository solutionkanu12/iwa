//! G2 (Iwa V2 capability plan) — RED security tests for the V2 private
//! destination / shadow-account payout primitive.
//!
//! STATUS: RED BY DESIGN. Every test in this file is expected to FAIL until the
//! minimal isolated V2 harness exists (plan tasks G3/G4) AND the infrastructure
//! gates in G1 are satisfied. No V2 production code is authorised by the plan
//! before G5 review.
//!
//! Why these are written now (plan task G2, step 4):
//!   "Run each test and capture its expected failure before any adapter
//!    implementation."
//!
//! What is deliberately NOT here:
//!   * No `IwaCircleV2` / `IwaPrivateDestinationHelperV2` implementation.
//!   * No invented anonymizer address, class hash, or Wallet API method.
//!   * No public-ERC20 payout fallback of any kind.
//!
//! Each test names one property from:
//!   * docs/superpowers/plans/2026-09-04-iwa-circle-v2.md, task G2
//!   * SECURITY.md, "Starknet V2 private payout security gate (2026-09-07)"
//!     -> "Mandatory payout attacks"
//!   * docs/superpowers/specs/2026-09-04-iwa-circle-v2-design.md, sections 7, 9,
//!     15.
//!
//! The real pinned STRK20 pool (`privacy::privacy::Privacy`, rev
//! 66e3caae8c0201227a6719696d004e30d90aea65) IS deployable here — see
//! `deploy_real_pool` — so when the V2 harness lands these tests bind against
//! genuine protocol behaviour, not an interface-only mock (plan G2 gate).
//!
//! The V2 helper entry point under test (from the design, section 9), once it
//! exists, must:
//!   * accept a call ONLY from `get_shadow_account(stored_commitment)` resolved
//!     from the member's precommitted shadow-identity commitment;
//!   * derive member, round, token, and payout amount from circle state — never
//!     from caller-supplied calldata;
//!   * consume a single-use, state-bound authorization nonce atomically with the
//!     liability debit;
//!   * enforce monotonic auth / destination epochs and reject stale ones;
//!   * leave circle state and helper liability byte-for-byte unchanged on ANY
//!     failure, including a failure raised inside the pool after the helper
//!     returned.

use iwa::iwa_types::invite_commitment;
use privacy::objects::OpenNoteDeposit;
use snforge_std::signature::stark_curve::{StarkCurveKeyPair, StarkCurveKeyPairImpl};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;

const SECRET_1: felt252 = 'secret-1';

fn addr(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}

fn key(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}

fn member_1() -> felt252 {
    invite_commitment(SECRET_1, key(0x101).public_key)
}

/// The genuine pinned STRK20 pool. Proves the RED tests below are wired to real
/// protocol behaviour and not an interface mock: the moment the V2 helper class
/// exists, this harness drives it through `apply_actions` exactly as
/// `test_strk20_pool_integration.cairo` already does for V1.
fn deploy_real_pool() -> ContractAddress {
    let pool_class = declare("Privacy").unwrap().contract_class();
    let mut pool_data = array![];
    addr('GOVERNANCE').serialize(ref pool_data);
    key('auditor').public_key.serialize(ref pool_data);
    key('screener').public_key.serialize(ref pool_data);
    450_u64.serialize(ref pool_data);
    let (pool, _) = pool_class.deploy(@pool_data).unwrap();
    pool
}

/// Resolves the V2 helper contract class. This is the single point that makes
/// every test in this file RED today: the class does not exist, so `declare`
/// fails and the test fails with it. Do not stub this to green — the plan
/// forbids V2 production code before the G5 review, and the G1 infrastructure
/// gates (real wallet shadow-account support, verified anonymizer deployment)
/// are still open.
fn v2_helper_class_hash() -> starknet::ClassHash {
    *declare("IwaPrivateDestinationHelperV2").unwrap().contract_class().class_hash
}

/// Resolves the V2 circle contract class. Also RED today for the same reason.
fn v2_circle_class_hash() -> starknet::ClassHash {
    *declare("IwaCircleV2").unwrap().contract_class().class_hash
}

/// Resolves the shadow-account anonymizer class. The Cairo source
/// (`packages/shadow_account_anonymizer`) IS present in the pinned dependency,
/// but it is NOT compiled into Iwa's build artifacts, and — critically — NO
/// canonical anonymizer deployment on Starknet Sepolia or mainnet is verifiable
/// from the pinned sources or the installed STRK20 skills. See the G1/G4 blocker
/// report. This resolver stays RED until that is resolved.
fn shadow_anonymizer_class_hash() -> starknet::ClassHash {
    *declare("ShadowAccountAnonymizer").unwrap().contract_class().class_hash
}

// ===========================================================================
// A. Commitment registration and rotation (plan G2, design §7.2, §11)
// ===========================================================================

/// A member can precommit an opaque per-circle shadow-identity commitment
/// before their payout round, bound to circle + auth epoch + destination epoch.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_member_can_register_shadow_commitment() {
    let _pool = deploy_real_pool();
    let _circle = v2_circle_class_hash();
    // TODO(G3): deploy V2 circle, activate, call
    //   register_shadow_commitment(member_ref, identity_commitment,
    //                              destination_epoch, auth_epoch)
    // and assert the stored commitment round-trips via a view.
    assert(false, 'V2 register not implemented');
}

/// Only an identity-key proof from the member rotates the commitment; epochs
/// increase monotonically and a stale epoch is rejected (design §10).
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_commitment_rotation_requires_identity_proof_and_monotonic_epoch() {
    let _circle = v2_circle_class_hash();
    assert(false, 'V2 rotation not implemented');
}

/// A rotation race (two rotations targeting the same epoch, or an old-epoch
/// authorization replayed after rotation) must fail closed.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_rotation_race_is_rejected() {
    let _circle = v2_circle_class_hash();
    assert(false, 'V2 rotn race not implemented');
}

// ===========================================================================
// B. Shadow-caller authentication (plan G2, design §7.6-7.7, §9)
// ===========================================================================

/// The V2 helper accepts the payout call ONLY when its caller equals
/// `get_shadow_account(stored_commitment)` resolved from the member's
/// precommitted commitment.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_correct_shadow_account_caller_is_accepted() {
    let _pool = deploy_real_pool();
    let _helper = v2_helper_class_hash();
    let _anonymizer = shadow_anonymizer_class_hash();
    assert(false, 'V2 shadow caller not impl');
}

/// A call from any address other than the resolved shadow account — including
/// the pool itself, the anonymizer itself, an arbitrary account, or a different
/// member's shadow account — is rejected before any state change.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_wrong_shadow_account_caller_is_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 wrong caller not impl');
}

/// Commitment substitution: an attacker registers or presents a commitment they
/// control for another member's slot. The helper must bind the commitment to
/// the scheduled `member_ref` from circle state, so the substituted commitment
/// resolves to a shadow account that fails the caller check.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_commitment_substitution_is_rejected() {
    let _helper = v2_helper_class_hash();
    let _m = member_1();
    assert(false, 'V2 cmt substitution not impl');
}

/// Cross-circle reuse: a commitment (and its shadow account) valid in circle A
/// cannot authorise a payout in circle B. Nonce derivation is per
/// circle + destination epoch (design §5.1, §8).
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_cross_circle_commitment_reuse_is_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 cross-circle not impl');
}

// ===========================================================================
// C. State-derived value, not caller-supplied (plan G2, design §9)
// ===========================================================================

/// The helper derives member, round, token, and payout amount from circle
/// state. Calldata carrying a different member / round / token / amount must
/// not change the settled values, and a mismatch must fail closed.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_member_round_token_amount_come_from_circle_state() {
    let _pool = deploy_real_pool();
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 state-derived not impl');
}

/// Wrong amount: a caller cannot inflate or deflate the transfer. The single
/// authorised amount is `round_funded_liability` for the scheduled round.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_wrong_amount_is_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 wrong amount not impl');
}

/// Wrong round / wrong token / contract substitution / chain-domain confusion:
/// each field the authorization binds is checked against trusted state.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_wrong_round_token_contract_chain_are_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 field binding not impl');
}

// ===========================================================================
// D. Replay, double-collect, expiry (plan G2, SECURITY.md mandatory attacks)
// ===========================================================================

/// The authorization nonce is single-use and consumed atomically with the
/// liability debit. A replayed authorization fails, and the protocol's
/// one-fill open-note rule is an independent second bound.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_authorization_replay_is_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 replay not implemented');
}

/// Double collect: a second `OpenNoteDeposit` for the same payout, or a second
/// shadow invoke in the same or a later transaction, must not move value twice.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_double_collect_is_rejected() {
    let _pool = deploy_real_pool();
    let _helper = v2_helper_class_hash();
    let _probe = OpenNoteDeposit { note_id: 1, token: addr(1), amount: 1 };
    assert(false, 'V2 double collect not impl');
}

/// Expiry bypass: an authorization presented after its expiry is rejected.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_expired_authorization_is_rejected() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 expiry not implemented');
}

// ===========================================================================
// E. Atomicity and liability conservation (plan G2, step 3)
// ===========================================================================

/// Any failed collection reverts the circle state transition AND the helper
/// liability debit. Proven by forcing a failure inside the pool AFTER the
/// helper has debited liability and approved the pool (the same shape as V1's
/// `pool_transaction_rolls_back_every_layer_on_any_failure`), then asserting
/// every layer is unchanged.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_failed_collection_reverts_circle_state_and_liability() {
    let _pool = deploy_real_pool();
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 atomicity not implemented');
}

/// A malicious callback / reentrancy from the shadow account or a hostile token
/// cannot re-enter the helper or the circle to settle twice or skip a check.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_reentrant_callback_cannot_double_settle() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 reentrancy not implemented');
}

/// Liability mismatch: the debited amount must equal the round funded liability
/// exactly; a debit exceeding the same round's funded liability fails closed
/// (mirrors V1 `assert_outbound_available`).
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_liability_mismatch_fails_closed() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 liability check not impl');
}

// ===========================================================================
// F. No public payout, no organizer/admin discretion (design §1, §10)
// ===========================================================================

/// There is no code path that pays the scheduled member with a plain public
/// ERC20 transfer, with or without optional re-shielding. The only success
/// state requires verified private value movement into a wallet-owned note.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_has_no_public_erc20_payout_path() {
    let _helper = v2_helper_class_hash();
    assert(false, 'V2 no-public-path unverified');
}

/// Organizer / admin / backend / helper have no recipient discretion. Fallback
/// submission may become permissionless after a timeout, but destination
/// selection never does.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_no_organizer_or_admin_recipient_discretion() {
    let _circle = v2_circle_class_hash();
    assert(false, 'V2 no-discretion unverified');
}

// ===========================================================================
// G. Recovery / fallback timing (design §10)
// ===========================================================================

/// Recovery uses the same private shadow-account capability with a separate,
/// member-committed, time-locked fallback shadow identity. A fresh member
/// authorization or destination registration resets the fallback timer.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_time_locked_private_fallback_only_after_timeout() {
    let _circle = v2_circle_class_hash();
    assert(false, 'V2 fallback timer not impl');
}

/// A fallback to a public account is not acceptable and must not exist.
// SUPERSEDED: the shadow-account path this file red-teamed was abandoned after
// spike G2 (no canonical Starknet shadow-account/anonymizer infrastructure).
// V2 private pot collection ships as Candidate P (precommitted private
// destination note); its production security matrix is
// `test_payout_settlement_v2.cairo`. Kept for history, ignored in CI.
#[ignore]
#[test]
fn v2_fallback_to_public_account_is_absent() {
    let _circle = v2_circle_class_hash();
    assert(false, 'V2 public fallback unverified');
}

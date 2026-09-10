//! Candidate P capability proof — PRECOMMITTED DESTINATION NOTE, against the
//! GENUINE pinned STRK20 pool (`privacy::privacy::Privacy`, rev 66e3caae…).
//!
//! Requires `--features test_erc20,v2_precommit_spike`.
//!
//! Proves the mechanism from `docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`:
//! a payout settles privately to a note the scheduled member committed to
//! BEFORE the STRK20 transaction was assembled, with the amount from circle
//! state and the destination from a member-auth-key-signed pre-registration.
//! No inline settlement signature, no caller-supplied amount, no admin path.
//!
//! The pool-driving harness (message hash, cheated proof facts, open-note
//! server actions) mirrors `test_strk20_pool_integration.cairo` exactly — the
//! real pinned pool moves the tokens and credits the note.
//!
//! Feature-gated so the default `snforge test --features test_erc20` build is
//! unaffected (`iwa::v2_precommit_spike` only exists with the feature).

#[cfg(feature: 'v2_precommit_spike')]
mod spike {
use core::ec::stark_curve;
use core::serde::Serde;
use iwa::test_erc20::{ITestErc20Dispatcher, ITestErc20DispatcherTrait};
use iwa::v2_precommit_spike::{
    IMockCircleV2Dispatcher, IMockCircleV2DispatcherTrait, IPayoutDestinationRegistrarV2Dispatcher,
    IPayoutDestinationRegistrarV2DispatcherTrait, IPrecommitPayoutHelperV2Dispatcher,
    IPrecommitPayoutHelperV2DispatcherTrait, register_dest_hash,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{InvokeInput, ServerAction, WriteOnceInput};
use privacy::interface::{
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
    IViewsDispatcher, IViewsDispatcherTrait,
};
use privacy::objects::Note;
use privacy::utils::ProofFacts;
use privacy::utils::constants::{OPEN_NOTE_PACKED_VALUE, VIRTUAL_SNOS, VIRTUAL_SNOS0};
use core::poseidon::poseidon_hash_span;
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_proof_facts, declare, map_entry_address,
    start_cheat_block_number_global, start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::syscalls::{call_contract_syscall, get_class_hash_at_syscall};
use starknet::{ContractAddress, SyscallResultTrait};

const CIRCLE_ID: u32 = 7;
const ROUND: u32 = 3;
const MEMBER: felt252 = 'MEMBER_1';
const AMOUNT: u128 = 2_000_000;
const BLOCK: u64 = 1_000;
const PROOF_VALIDITY_BLOCKS: u64 = 450;
const EMIT_OPEN_NOTE_CREATED: felt252 = 7;

fn addr(v: felt252) -> ContractAddress {
    v.try_into().unwrap()
}
fn key(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}
fn canonical_s(s: felt252) -> felt252 {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    if s.into() > ORDER_U256 / 2 {
        stark_curve::ORDER - s
    } else {
        s
    }
}

#[derive(Copy, Drop)]
struct Env {
    pool: ContractAddress,
    server: IServerDispatcher,
    safe_server: IServerSafeDispatcher,
    views: IViewsDispatcher,
    circle: IMockCircleV2Dispatcher,
    registrar: IPayoutDestinationRegistrarV2Dispatcher,
    helper: IPrecommitPayoutHelperV2Dispatcher,
    usdc: ContractAddress,
    strk: ContractAddress,
}

fn deploy_token(name: ByteArray, symbol: ByteArray) -> ContractAddress {
    let class = declare("TestErc20").unwrap().contract_class();
    let mut cd = array![];
    name.serialize(ref cd);
    symbol.serialize(ref cd);
    let (a, _) = class.deploy(@cd).unwrap();
    a
}

fn deploy_env() -> Env {
    start_cheat_block_number_global(BLOCK);
    let usdc = deploy_token("USD Coin", "USDC");
    let strk = deploy_token("Stark", "STRK");

    // Genuine pinned pool.
    let pool_class = declare("Privacy").unwrap().contract_class();
    let mut pd = array![];
    addr('GOV').serialize(ref pd);
    key('auditor').public_key.serialize(ref pd);
    key('screener').public_key.serialize(ref pd);
    PROOF_VALIDITY_BLOCKS.serialize(ref pd);
    let (pool, _) = pool_class.deploy(@pd).unwrap();

    let (circle_addr, _) = declare("MockCircleV2")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();

    let mut rd = array![];
    circle_addr.serialize(ref rd);
    let (registrar_addr, _) = declare("PayoutDestinationRegistrarV2")
        .unwrap()
        .contract_class()
        .deploy(@rd)
        .unwrap();

    let mut hd = array![];
    pool.serialize(ref hd);
    registrar_addr.serialize(ref hd);
    circle_addr.serialize(ref hd);
    usdc.serialize(ref hd);
    strk.serialize(ref hd);
    let (helper_addr, _) = declare("PrecommitPayoutHelperV2")
        .unwrap()
        .contract_class()
        .deploy(@hd)
        .unwrap();

    let circle = IMockCircleV2Dispatcher { contract_address: circle_addr };
    circle.set_helper(helper_addr);

    Env {
        pool,
        server: IServerDispatcher { contract_address: pool },
        safe_server: IServerSafeDispatcher { contract_address: pool },
        views: IViewsDispatcher { contract_address: pool },
        circle,
        registrar: IPayoutDestinationRegistrarV2Dispatcher { contract_address: registrar_addr },
        helper: IPrecommitPayoutHelperV2Dispatcher { contract_address: helper_addr },
        usdc,
        strk,
    }
}

/// The scheduled member exists in circle state, with their auth key and the
/// state-derived amount, and has authorized their payout.
fn schedule(env: Env, amount: u128) {
    env.circle.set_scheduled(CIRCLE_ID, ROUND, MEMBER, key(0x101).public_key, amount);
    env.circle.authorize(CIRCLE_ID, ROUND);
}

/// Park the pot in the helper (models settled contributions).
fn fund_helper(env: Env, amount: u128) {
    ITestErc20Dispatcher { contract_address: env.usdc }
        .mint(env.helper.contract_address, amount.into());
}

/// The member signs their destination note id ahead of the payout tx.
fn register_destination(
    env: Env, note_id: felt252, dest_epoch: u64, nonce: felt252, signer: StarkCurveKeyPair,
) {
    let hash = register_dest_hash(CIRCLE_ID, ROUND, MEMBER, note_id, dest_epoch, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    env
        .registrar
        .register_destination(
            CIRCLE_ID, ROUND, MEMBER, note_id, dest_epoch, nonce, r, canonical_s(raw_s),
        );
}

fn register_fails(
    env: Env, note_id: felt252, dest_epoch: u64, nonce: felt252, signer: StarkCurveKeyPair,
) -> bool {
    let hash = register_dest_hash(CIRCLE_ID, ROUND, MEMBER, note_id, dest_epoch, nonce);
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    let mut cd = array![];
    CIRCLE_ID.serialize(ref cd);
    ROUND.serialize(ref cd);
    MEMBER.serialize(ref cd);
    note_id.serialize(ref cd);
    dest_epoch.serialize(ref cd);
    nonce.serialize(ref cd);
    r.serialize(ref cd);
    canonical_s(raw_s).serialize(ref cd);
    call_contract_syscall(
        env.registrar.contract_address, selector!("register_destination"), cd.span(),
    )
        .is_err()
}

// --- genuine-pool driving (mirrors test_strk20_pool_integration.cairo) ---

fn message_hash(actions: Span<ServerAction>, pool: ContractAddress) -> felt252 {
    let mut l1: Array<felt252> = array![pool.into(), 0];
    let mut payload = array![];
    get_class_hash_at_syscall(pool).unwrap_syscall().serialize(ref payload);
    actions.serialize(ref payload);
    payload.serialize(ref l1);
    poseidon_hash_span(l1.span())
}

fn cheat_proof(env: Env, actions: Span<ServerAction>) {
    let pf = ProofFacts {
        proof_version: 0,
        program_variant: VIRTUAL_SNOS,
        virtual_program_hash: 0,
        starknet_os_output_version: VIRTUAL_SNOS0,
        base_block_number: BLOCK - 1,
        base_block_hash: 0,
        starknet_os_config_hash: 0,
        message_to_l1_hashes: [message_hash(actions, env.pool)].span(),
    };
    let mut s = array![];
    pf.serialize(ref s);
    cheat_proof_facts(env.pool, s.span(), CheatSpan::TargetCalls(1));
}

fn apply(env: Env, actions: Span<ServerAction>) {
    cheat_proof(env, actions);
    env.server.apply_actions(actions, Option::None);
}

#[feature("safe_dispatcher")]
fn apply_fails(env: Env, actions: Span<ServerAction>) -> bool {
    cheat_proof(env, actions);
    env.safe_server.apply_actions(actions, Option::None).is_err()
}

fn emit_open_note_created(token: ContractAddress, note_id: felt252) -> ServerAction {
    let data = array![EMIT_OPEN_NOTE_CREATED, 0, 0, 0, token.into(), note_id];
    let mut span = data.span();
    let a: ServerAction = Serde::deserialize(ref span).expect('open note enc');
    assert(span.is_empty(), 'open note len');
    a
}

fn create_open_note(token: ContractAddress, note_id: felt252) -> Array<ServerAction> {
    let note = Note { packed_value: OPEN_NOTE_PACKED_VALUE, token };
    let mut value = array![];
    note.serialize(ref value);
    array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: map_entry_address(selector!("notes"), [note_id].span()),
                value: value.span(),
            },
        ),
        emit_open_note_created(token, note_id),
    ]
}

fn invoke_helper(
    env: Env, member_ref: felt252, token: ContractAddress, open_note_id: felt252,
) -> ServerAction {
    let mut cd = array![];
    CIRCLE_ID.serialize(ref cd);
    ROUND.serialize(ref cd);
    member_ref.serialize(ref cd);
    token.serialize(ref cd);
    open_note_id.serialize(ref cd);
    ServerAction::Invoke(
        InvokeInput { contract_address: env.helper.contract_address, calldata: cd.span() },
    )
}

/// `[create open note N] + [invoke helper referencing N]`.
fn settle_actions(
    env: Env, created_note: felt252, invoke_note: felt252, member_ref: felt252,
) -> Span<ServerAction> {
    let mut a = create_open_note(env.usdc, created_note);
    a.append(invoke_helper(env, member_ref, env.usdc, invoke_note));
    a.span()
}

fn note_amount(env: Env, note_id: felt252) -> u128 {
    let n = env.views.get_note(note_id);
    let filled: u256 = (n.packed_value - OPEN_NOTE_PACKED_VALUE).into();
    filled.try_into().unwrap()
}
fn bal(token: ContractAddress, a: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(a)
}
fn allowance_to_pool(env: Env) -> u256 {
    IERC20Dispatcher { contract_address: env.usdc }
        .allowance(env.helper.contract_address, env.pool)
}

// ===========================================================================
// A. Happy path — genuine pool fills the precommitted note, exact state amount
// ===========================================================================

#[test]
fn precommitted_destination_is_filled_by_the_genuine_pool() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT);

    let note: felt252 = 0x9001;
    // Destination committed BEFORE any STRK20 transaction is assembled.
    register_destination(env, note, 1, 111, key(0x101));
    assert(env.registrar.registered_note(CIRCLE_ID, ROUND) == note, 'registered');

    apply(env, settle_actions(env, note, note, MEMBER));

    // The real pool pulled exactly the state-derived amount into the note.
    assert(note_amount(env, note) == AMOUNT, 'note filled exactly');
    assert(env.views.get_note(note).token == env.usdc, 'note token');
    assert(bal(env.usdc, env.helper.contract_address) == 0, 'pot released');
    assert(bal(env.usdc, env.pool) == AMOUNT.into(), 'pool holds note value');
    assert(allowance_to_pool(env) == 0, 'no residual allowance');
    assert(env.circle.get_payout(CIRCLE_ID, ROUND).paid, 'marked paid');
}

#[test]
fn settled_amount_tracks_circle_state_not_calldata() {
    // Calldata carries no amount field at all; the pool fills whatever circle
    // state says. Changing state changes the settlement.
    let env = deploy_env();
    schedule(env, 500_000);
    fund_helper(env, 500_000);
    let note: felt252 = 0x9101;
    register_destination(env, note, 1, 1, key(0x101));
    apply(env, settle_actions(env, note, note, MEMBER));
    assert(note_amount(env, note) == 500_000, 'state amount');
}

// ===========================================================================
// B. Destination binding — no substitution
// ===========================================================================

#[test]
fn wrong_destination_note_is_rejected_and_nothing_changes() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT);
    let registered: felt252 = 0x9001;
    let attacker_note: felt252 = 0xBAD;
    register_destination(env, registered, 1, 1, key(0x101));

    // Assemble a payout that creates and references the attacker's note.
    assert(
        apply_fails(env, settle_actions(env, attacker_note, attacker_note, MEMBER)),
        'substitution rejected',
    );

    assert(!env.circle.get_payout(CIRCLE_ID, ROUND).paid, 'not paid');
    assert(bal(env.usdc, env.helper.contract_address) == AMOUNT.into(), 'pot intact');
    assert(allowance_to_pool(env) == 0, 'no allowance');
    assert(env.registrar.registered_note(CIRCLE_ID, ROUND) == registered, 'registration intact');
}

#[test]
fn wrong_member_ref_is_rejected() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT);
    let note: felt252 = 0x9001;
    register_destination(env, note, 1, 1, key(0x101));
    assert(apply_fails(env, settle_actions(env, note, note, 'SOMEONE_ELSE')), 'wrong member');
    assert(!env.circle.get_payout(CIRCLE_ID, ROUND).paid, 'not paid');
}

// ===========================================================================
// C. Replay / double collect
// ===========================================================================

#[test]
fn replay_of_a_completed_payout_is_rejected() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT * 2);
    let note: felt252 = 0x9001;
    register_destination(env, note, 1, 1, key(0x101));

    apply(env, settle_actions(env, note, note, MEMBER));
    assert(note_amount(env, note) == AMOUNT, 'first paid');

    // Same transaction again: circle state is Paid, and the pool's one-fill
    // rule independently blocks a refill.
    assert(apply_fails(env, settle_actions(env, note, note, MEMBER)), 'replay rejected');
    assert(note_amount(env, note) == AMOUNT, 'note unchanged');
    assert(bal(env.usdc, env.helper.contract_address) == AMOUNT.into(), 'no second debit');
}

// ===========================================================================
// D. Registration authorization
// ===========================================================================

#[test]
fn forged_registration_is_rejected() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    // Signed by the wrong key: the registrar checks against the circle-state
    // public key, so this never records a destination.
    assert(register_fails(env, 0x9001, 1, 1, key(0xD00D)), 'forged sig rejected');
    assert(env.registrar.registered_note(CIRCLE_ID, ROUND) == 0, 'nothing registered');
}

#[test]
fn stale_epoch_registration_is_rejected() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    register_destination(env, 0x9E00, 5, 10, key(0x101));
    assert(register_fails(env, 0x901D, 3, 11, key(0x101)), 'stale epoch rejected');
    assert(register_fails(env, 0x901D, 5, 12, key(0x101)), 'equal epoch rejected');
    assert(env.registrar.registered_note(CIRCLE_ID, ROUND) == 0x9E00, 'newest wins');
}

#[test]
fn registration_nonce_is_single_use() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    register_destination(env, 0x9001, 1, 777, key(0x101));
    assert(register_fails(env, 0x9102, 2, 777, key(0x101)), 'nonce replay rejected');
}

// ===========================================================================
// E. Caller authorization
// ===========================================================================

#[test]
fn direct_helper_call_bypassing_the_pool_is_rejected() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT);
    register_destination(env, 0x9001, 1, 1, key(0x101));

    let mut cd = array![];
    CIRCLE_ID.serialize(ref cd);
    ROUND.serialize(ref cd);
    MEMBER.serialize(ref cd);
    env.usdc.serialize(ref cd);
    let n: felt252 = 0x9001;
    n.serialize(ref cd);
    start_cheat_caller_address(env.helper.contract_address, addr('ATTACKER'));
    let res = call_contract_syscall(
        env.helper.contract_address, selector!("privacy_invoke"), cd.span(),
    );
    stop_cheat_caller_address(env.helper.contract_address);
    assert(res.is_err(), 'pool-only');
    assert(!env.circle.get_payout(CIRCLE_ID, ROUND).paid, 'not paid');
}

// ===========================================================================
// F. Atomicity across the pool boundary
// ===========================================================================

#[test]
fn pool_side_failure_after_the_helper_returns_reverts_everything() {
    let env = deploy_env();
    schedule(env, AMOUNT);
    fund_helper(env, AMOUNT);
    let registered: felt252 = 0xBB01;
    register_destination(env, registered, 1, 1, key(0x101));

    // The transaction creates note A but the invoke references the registered
    // note B. The helper validates B, marks paid, approves the pool, and
    // returns OpenNoteDeposit{B} — then the pool rejects because B was never
    // created. The revert must reach back through the helper and the circle.
    let created: felt252 = 0xAA01;
    assert(apply_fails(env, settle_actions(env, created, registered, MEMBER)), 'pool rejects');

    assert(!env.circle.get_payout(CIRCLE_ID, ROUND).paid, 'paid rolled back');
    assert(allowance_to_pool(env) == 0, 'approval rolled back');
    assert(bal(env.usdc, env.helper.contract_address) == AMOUNT.into(), 'pot intact');
    assert(env.views.get_note(created).packed_value == 0, 'note A not created');
    assert(env.registrar.registered_note(CIRCLE_ID, ROUND) == registered, 'registration intact');
}
}

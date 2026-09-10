//! A3 — mandatory V2 private pot-collection security matrix, driven by the
//! GENUINE pinned STRK20 pool (`privacy::privacy::Privacy`, rev 66e3caae…).
//!
//! Runs on the default `snforge test --features test_erc20` build: the V2
//! production contracts (`IwaCircleV2`, `IwaStrk20HelperV2`) are not feature
//! gated.
//!
//! Mechanism under test — Candidate P (precommitted private destination note),
//! `docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`:
//!   * the scheduled member REGISTERS the open-note id their wallet will create,
//!     plus the exact state-derived amount, a monotonic epoch and an expiry,
//!     authenticated by ONE member-auth-key signature, BEFORE the STRK20
//!     transaction is assembled;
//!   * settlement carries NO signature and NO amount — it only checks
//!     `open_note_id == registered` and reads the amount from circle state;
//!   * any failure (including one raised inside the pool after the helper
//!     returned) reverts the whole transaction: pot, liability and accounting
//!     are byte-for-byte unchanged.
//!
//! The pool-driving harness mirrors `test_strk20_pool_integration.cairo`.

use core::ec::stark_curve;
use core::poseidon::poseidon_hash_span;
use core::serde::Serde;
use iwa::iwa_circle_v2::{IIwaCircleV2Dispatcher, IIwaCircleV2DispatcherTrait};
use iwa::iwa_strk20_helper::{IIwaStrk20HelperDispatcher, IIwaStrk20HelperDispatcherTrait, IwaOperation};
use iwa::iwa_types::{
    contribution_settlement_authorization_hash, cure_settlement_authorization_hash,
    invite_commitment,
};
use iwa::iwa_types_v2::{PayoutStatusV2, payout_dest_v2_hash, recovery_dest_v2_hash};
use iwa::test_erc20::{ITestErc20Dispatcher, ITestErc20DispatcherTrait};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{InvokeInput, ServerAction, TransferToInput, WriteOnceInput};
use privacy::interface::{
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
    IViewsDispatcher, IViewsDispatcherTrait,
};
use privacy::objects::Note;
use privacy::utils::ProofFacts;
use privacy::utils::constants::{OPEN_NOTE_PACKED_VALUE, VIRTUAL_SNOS, VIRTUAL_SNOS0};
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_proof_facts, declare, map_entry_address,
    start_cheat_block_number_global, start_cheat_block_timestamp_global, start_cheat_caller_address,
    stop_cheat_block_timestamp_global, stop_cheat_caller_address,
};
use starknet::syscalls::{call_contract_syscall, get_class_hash_at_syscall};
use starknet::{ContractAddress, SyscallResultTrait};

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const AMOUNT: u128 = 5_000_000;
const POT: u128 = AMOUNT * 2;
const BLOCK: u64 = 1_000;
const NOW: u64 = 2_000;
const EXPIRY: u64 = 1_000_000_000;
const CADENCE: u64 = 100_000;
const GRACE: u64 = 50_000;
const PROOF_VALIDITY_BLOCKS: u64 = 450;
const EMIT_OPEN_NOTE_CREATED: felt252 = 7;

#[derive(Copy, Drop)]
struct Env {
    core: IIwaCircleV2Dispatcher,
    helper: IIwaStrk20HelperDispatcher,
    pool: ContractAddress,
    server: IServerDispatcher,
    safe_server: IServerSafeDispatcher,
    views: IViewsDispatcher,
    usdc: ContractAddress,
    strk: ContractAddress,
}

fn addr(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}
fn surplus_sink() -> ContractAddress {
    addr('SURPLUS_SINK')
}
fn key(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}
fn member_1() -> felt252 {
    invite_commitment(SECRET_1, key(0x101).public_key)
}
fn member_2() -> felt252 {
    invite_commitment(SECRET_2, key(0x102).public_key)
}
fn canonical_s(s: felt252) -> felt252 {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let s_u256: u256 = s.into();
    if s_u256 > ORDER_U256 / 2 {
        stark_curve::ORDER - s
    } else {
        s
    }
}

fn deploy_token(name: ByteArray, symbol: ByteArray) -> ContractAddress {
    let class = declare("TestErc20").unwrap().contract_class();
    let mut cd = array![];
    name.serialize(ref cd);
    symbol.serialize(ref cd);
    let (a, _) = class.deploy(@cd).unwrap();
    a
}

// --- genuine pool driving (mirrors test_strk20_pool_integration.cairo) ------

fn message_hash(actions: Span<ServerAction>, pool: ContractAddress) -> felt252 {
    let mut l1: Array<felt252> = array![pool.into(), 0];
    let mut payload = array![];
    get_class_hash_at_syscall(pool).unwrap_syscall().serialize(ref payload);
    actions.serialize(ref payload);
    payload.serialize(ref l1);
    poseidon_hash_span(l1.span())
}

fn cheat_pool_proof(env: Env, actions: Span<ServerAction>) {
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
    cheat_pool_proof(env, actions);
    env.server.apply_actions(actions, Option::None);
}

#[feature("safe_dispatcher")]
fn apply_fails(env: Env, actions: Span<ServerAction>) -> bool {
    cheat_pool_proof(env, actions);
    env.safe_server.apply_actions(actions, Option::None).is_err()
}

fn transfer_to_helper(env: Env, token: ContractAddress, amount: u128) -> ServerAction {
    ServerAction::TransferTo(TransferToInput { to_addr: env.helper.contract_address, token, amount })
}

fn invoke_helper(
    env: Env,
    operation: IwaOperation,
    id: u32,
    round: u32,
    member: felt252,
    token: ContractAddress,
    note: felt252,
    nonce: felt252,
    r: felt252,
    s: felt252,
) -> ServerAction {
    let mut cd = array![];
    operation.serialize(ref cd);
    id.serialize(ref cd);
    round.serialize(ref cd);
    member.serialize(ref cd);
    token.serialize(ref cd);
    note.serialize(ref cd);
    nonce.serialize(ref cd);
    r.serialize(ref cd);
    s.serialize(ref cd);
    ServerAction::Invoke(
        InvokeInput { contract_address: env.helper.contract_address, calldata: cd.span() },
    )
}

fn emit_open_note_created(token: ContractAddress, note_id: felt252) -> ServerAction {
    let data = array![EMIT_OPEN_NOTE_CREATED, 0, 0, 0, token.into(), note_id];
    let mut span = data.span();
    let action: ServerAction = Serde::deserialize(ref span).expect('open note action encoding');
    assert(span.is_empty(), 'open note action length');
    action
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

// --- deploy + lifecycle ----------------------------------------------------

fn deploy_env() -> Env {
    start_cheat_block_number_global(BLOCK);
    start_cheat_block_timestamp_global(NOW);
    let usdc = deploy_token("USD Coin", "USDC");
    let strk = deploy_token("Stark", "STRK");

    let pool_class = declare("Privacy").unwrap().contract_class();
    let mut pool_data = array![];
    addr('GOVERNANCE').serialize(ref pool_data);
    key('auditor').public_key.serialize(ref pool_data);
    key('screener').public_key.serialize(ref pool_data);
    PROOF_VALIDITY_BLOCKS.serialize(ref pool_data);
    let (pool, _) = pool_class.deploy(@pool_data).unwrap();

    let setup = addr(0x666);
    let core_class = declare("IwaCircleV2").unwrap().contract_class();
    let mut core_data = array![];
    usdc.serialize(ref core_data);
    strk.serialize(ref core_data);
    pool.serialize(ref core_data);
    setup.serialize(ref core_data);
    let (core_address, _) = core_class.deploy(@core_data).unwrap();
    let core = IIwaCircleV2Dispatcher { contract_address: core_address };

    let helper_class = declare("IwaStrk20HelperV2").unwrap().contract_class();
    let mut helper_data = array![];
    core_address.serialize(ref helper_data);
    pool.serialize(ref helper_data);
    usdc.serialize(ref helper_data);
    strk.serialize(ref helper_data);
    surplus_sink().serialize(ref helper_data);
    let (helper_address, _) = helper_class.deploy(@helper_data).unwrap();
    let helper = IIwaStrk20HelperDispatcher { contract_address: helper_address };

    start_cheat_caller_address(core_address, setup);
    core.initialize_settlement_helper(helper_address);
    stop_cheat_caller_address(core_address);

    Env {
        core,
        helper,
        pool,
        server: IServerDispatcher { contract_address: pool },
        safe_server: IServerSafeDispatcher { contract_address: pool },
        views: IViewsDispatcher { contract_address: pool },
        usdc,
        strk,
    }
}

fn activate(env: Env) -> u32 {
    start_cheat_caller_address(env.core.contract_address, addr(0xabc));
    let id = env
        .core
        .create_circle(
            env.usdc, AMOUNT, CADENCE, GRACE, 2, array![member_1(), member_2()].span(),
        );
    env.core.join_circle(id, SECRET_1, key(0x101).public_key);
    env.core.join_circle(id, SECRET_2, key(0x102).public_key);
    stop_cheat_caller_address(env.core.contract_address);
    id
}

fn fund_pool(env: Env, token: ContractAddress, amount: u128) {
    ITestErc20Dispatcher { contract_address: token }.mint(env.pool, amount.into());
}
fn bal(token: ContractAddress, account: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(account)
}
fn allowance_to_pool(env: Env) -> u256 {
    IERC20Dispatcher { contract_address: env.usdc }
        .allowance(env.helper.contract_address, env.pool)
}
fn note_amount(env: Env, note_id: felt252) -> u128 {
    let n = env.views.get_note(note_id);
    let filled: u256 = (n.packed_value - OPEN_NOTE_PACKED_VALUE).into();
    filled.try_into().unwrap()
}

fn sign_contribution(
    env: Env, id: u32, round: u32, member: felt252, signer: StarkCurveKeyPair, nonce: felt252,
) -> (felt252, felt252) {
    let hash = contribution_settlement_authorization_hash(
        id, round, member, env.helper.contract_address, env.pool, env.usdc, AMOUNT, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn contribute(
    env: Env, id: u32, round: u32, member: felt252, signer: StarkCurveKeyPair, nonce: felt252,
) {
    fund_pool(env, env.usdc, AMOUNT);
    let (r, s) = sign_contribution(env, id, round, member, signer, nonce);
    apply(
        env,
        array![
            transfer_to_helper(env, env.usdc, AMOUNT),
            invoke_helper(
                env, IwaOperation::SettleContribution, id, round, member, env.usdc, 0, nonce, r, s,
            ),
        ]
            .span(),
    );
}

fn default_member(env: Env, id: u32, round: u32, member: felt252) {
    let grace = env.core.get_contribution_obligation(id, round, member).grace_ends_at;
    start_cheat_block_timestamp_global(grace + 1);
    env.core.finalize_contribution_default(id, round, member);
    start_cheat_block_timestamp_global(NOW);
}

fn cure(env: Env, id: u32, round: u32, member: felt252, signer: StarkCurveKeyPair, nonce: felt252) {
    fund_pool(env, env.usdc, AMOUNT);
    let hash = cure_settlement_authorization_hash(
        id, round, member, env.helper.contract_address, env.pool, env.usdc, AMOUNT, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    apply(
        env,
        array![
            transfer_to_helper(env, env.usdc, AMOUNT),
            invoke_helper(
                env, IwaOperation::SettleCure, id, round, member, env.usdc, 0, nonce, r,
                canonical_s(raw_s),
            ),
        ]
            .span(),
    );
}

// --- Candidate P registration --------------------------------------------

fn dest_sig(
    env: Env,
    id: u32,
    round: u32,
    member: felt252,
    note: felt252,
    amount: u128,
    epoch: u64,
    expiry: u64,
    nonce: felt252,
    signer: StarkCurveKeyPair,
) -> (felt252, felt252) {
    let hash = payout_dest_v2_hash(
        env.core.contract_address, env.helper.contract_address, env.pool, env.usdc, id, round,
        member, note, amount, epoch, expiry, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn register(
    env: Env,
    id: u32,
    round: u32,
    member: felt252,
    note: felt252,
    amount: u128,
    epoch: u64,
    expiry: u64,
    nonce: felt252,
    signer: StarkCurveKeyPair,
) {
    let (r, s) = dest_sig(env, id, round, member, note, amount, epoch, expiry, nonce, signer);
    env.core.register_payout_destination(id, round, note, amount, epoch, expiry, nonce, r, s);
}

fn register_fails(
    env: Env,
    id: u32,
    round: u32,
    member: felt252,
    note: felt252,
    amount: u128,
    epoch: u64,
    expiry: u64,
    nonce: felt252,
    signer: StarkCurveKeyPair,
) -> bool {
    let (r, s) = dest_sig(env, id, round, member, note, amount, epoch, expiry, nonce, signer);
    let mut cd = array![];
    id.serialize(ref cd);
    round.serialize(ref cd);
    note.serialize(ref cd);
    amount.serialize(ref cd);
    epoch.serialize(ref cd);
    expiry.serialize(ref cd);
    nonce.serialize(ref cd);
    r.serialize(ref cd);
    s.serialize(ref cd);
    call_contract_syscall(
        env.core.contract_address, selector!("register_payout_destination"), cd.span(),
    )
        .is_err()
}

/// `[create open note N] + [invoke SettlePayout referencing note M]` with NO
/// signature and NO nonce (Candidate P: settlement carries neither).
fn settle_payout_actions(
    env: Env, created: felt252, referenced: felt252, member: felt252, round: u32, id: u32,
) -> Span<ServerAction> {
    let mut a = create_open_note(env.usdc, created);
    a
        .append(
            invoke_helper(
                env, IwaOperation::SettlePayout, id, round, member, env.usdc, referenced, 0, 0, 0,
            ),
        );
    a.span()
}

// A fully funded, accounting-ready round 1 with member_1 as recipient.
fn ready_round_1(env: Env) -> u32 {
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 101);
    contribute(env, id, 1, member_2(), key(0x102), 102);
    env.core.finalize_round_payout_accounting(id, 1);
    id
}

// ===========================================================================
// A. Happy path
// ===========================================================================

#[test]
fn correct_member_collects_the_private_pot() {
    let env = deploy_env();
    let id = ready_round_1(env);

    let note: felt252 = 0x7001;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 501, key(0x101));
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivateSettlementAuthorized,
        'authorized',
    );
    assert(env.core.get_registered_payout_destination(id, 1).note_id == note, 'registered');

    apply(env, settle_payout_actions(env, note, note, member_1(), 1, id));

    assert(note_amount(env, note) == POT, 'note filled exactly');
    assert(env.views.get_note(note).token == env.usdc, 'note token');
    assert(bal(env.usdc, env.helper.contract_address) == 0, 'custody released');
    assert(bal(env.usdc, env.pool) == POT.into(), 'pool holds note value');
    assert(allowance_to_pool(env) == 0, 'no residual allowance');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round debited');
    assert(env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivatelyPaid, 'paid');
    assert(env.core.is_payout_privately_settled(id, 1), 'settled flag');
}

#[test]
fn settlement_amount_is_state_derived_with_no_amount_in_settlement_calldata() {
    // The SettlePayout calldata carries operation/id/round/member/token/note
    // only — no amount. The pool fills exactly what circle state says.
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7101;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 511, key(0x101));
    apply(env, settle_payout_actions(env, note, note, member_1(), 1, id));
    assert(note_amount(env, note) == POT, 'exact state amount');
}

// ===========================================================================
// B. Registration authorization
// ===========================================================================

#[test]
fn forged_registration_signature_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    // Signed by a key that is not member_1's registered auth key.
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 1, key(0xD00D)),
        'forged sig rejected',
    );
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::Scheduled, 'still scheduled',
    );
}

#[test]
fn wrong_amount_at_registration_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT + 1, 1, EXPIRY, 1, key(0x101)),
        'inflated amount rejected',
    );
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT - 1, 1, EXPIRY, 1, key(0x101)),
        'deflated amount rejected',
    );
}

#[test]
fn zero_note_registration_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    assert(
        register_fails(env, id, 1, member_1(), 0, POT, 1, EXPIRY, 1, key(0x101)), 'zero note',
    );
}

#[test]
fn stale_or_equal_destination_epoch_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    register(env, id, 1, member_1(), 0x7E00, POT, 5, EXPIRY, 10, key(0x101));
    assert(
        register_fails(env, id, 1, member_1(), 0x7011, POT, 3, EXPIRY, 11, key(0x101)),
        'stale epoch rejected',
    );
    assert(
        register_fails(env, id, 1, member_1(), 0x7011, POT, 5, EXPIRY, 12, key(0x101)),
        'equal epoch rejected',
    );
    assert(env.core.get_registered_payout_destination(id, 1).note_id == 0x7E00, 'newest wins');
    assert(env.core.get_dest_epoch(id, member_1()) == 5, 'epoch held');
}

#[test]
fn registration_nonce_is_single_use() {
    let env = deploy_env();
    let id = ready_round_1(env);
    register(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 777, key(0x101));
    assert(
        register_fails(env, id, 1, member_1(), 0x7102, POT, 2, EXPIRY, 777, key(0x101)),
        'nonce replay rejected',
    );
}

#[test]
fn expired_authorization_at_registration_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT, 1, NOW - 1, 1, key(0x101)),
        'expired at registration',
    );
}

#[test]
fn registration_before_payout_accounting_is_rejected() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 101);
    contribute(env, id, 1, member_2(), key(0x102), 102);
    // No finalize_round_payout_accounting yet.
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 1, key(0x101)),
        'no payout state',
    );
}

/// Serializes register_payout_destination calldata and calls it raw, returning
/// whether the call reverted.
fn raw_register(
    env: Env,
    id: u32,
    round: u32,
    note: felt252,
    amount: u128,
    epoch: u64,
    expiry: u64,
    nonce: felt252,
    r: felt252,
    s: felt252,
) -> bool {
    let mut cd = array![];
    id.serialize(ref cd);
    round.serialize(ref cd);
    note.serialize(ref cd);
    amount.serialize(ref cd);
    epoch.serialize(ref cd);
    expiry.serialize(ref cd);
    nonce.serialize(ref cd);
    r.serialize(ref cd);
    s.serialize(ref cd);
    call_contract_syscall(
        env.core.contract_address, selector!("register_payout_destination"), cd.span(),
    )
        .is_err()
}

#[test]
fn wrong_domain_recovery_hash_cannot_authorize_a_payout_destination() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7001;
    let nonce: felt252 = 1;
    // Sign the RECOVERY hash but submit to register_payout_destination.
    let hash = recovery_dest_v2_hash(
        env.core.contract_address, env.helper.contract_address, env.pool, env.usdc, id, 1,
        member_1(), note, POT, 1, EXPIRY, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    assert(
        raw_register(env, id, 1, note, POT, 1, EXPIRY, nonce, r, canonical_s(raw_s)),
        'domain tag mismatch rejected',
    );
}

#[test]
fn wrong_circle_binding_is_rejected() {
    let env = deploy_env();
    let id_a = ready_round_1(env);
    let id_b = ready_round_1(env);
    let note: felt252 = 0x7001;
    let nonce: felt252 = 1;
    // Signature bound to circle A, submitted to circle B.
    let (r, s) = dest_sig(env, id_a, 1, member_1(), note, POT, 1, EXPIRY, nonce, key(0x101));
    assert(raw_register(env, id_b, 1, note, POT, 1, EXPIRY, nonce, r, s), 'cross-circle rejected');
}

// ===========================================================================
// C. Destination binding at settlement — no substitution
// ===========================================================================

#[test]
fn destination_note_substitution_is_rejected_and_nothing_changes() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let registered: felt252 = 0x7001;
    let attacker: felt252 = 0xBAD;
    register(env, id, 1, member_1(), registered, POT, 1, EXPIRY, 1, key(0x101));

    assert(
        apply_fails(env, settle_payout_actions(env, attacker, attacker, member_1(), 1, id)),
        'substitution rejected',
    );

    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivateSettlementAuthorized,
        'state unchanged',
    );
    assert(!env.core.is_payout_privately_settled(id, 1), 'not settled');
    assert(bal(env.usdc, env.helper.contract_address) == POT.into(), 'pot intact');
    assert(allowance_to_pool(env) == 0, 'no allowance');
    assert(
        env.core.get_registered_payout_destination(id, 1).note_id == registered, 'registration held',
    );
}

#[test]
fn wrong_member_ref_at_settlement_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7001;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 1, key(0x101));
    assert(
        apply_fails(env, settle_payout_actions(env, note, note, 'INTRUDER', 1, id)),
        'wrong member rejected',
    );
    assert(!env.core.is_payout_privately_settled(id, 1), 'not settled');
    assert(bal(env.usdc, env.helper.contract_address) == POT.into(), 'pot intact');
}

#[test]
fn wrong_round_at_settlement_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7001;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 1, key(0x101));
    // Round 2 has no PrivateSettlementAuthorized payout.
    assert(
        apply_fails(env, settle_payout_actions(env, note, note, member_1(), 2, id)),
        'wrong round rejected',
    );
    assert(env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivateSettlementAuthorized, 'r1 held');
}

#[test]
fn expired_authorization_at_settlement_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7001;
    let expiry: u64 = NOW + 10;
    register(env, id, 1, member_1(), note, POT, 1, expiry, 1, key(0x101));
    // Advance the clock past the registered expiry.
    start_cheat_block_timestamp_global(expiry + 1);
    assert(
        apply_fails(env, settle_payout_actions(env, note, note, member_1(), 1, id)),
        'expired at settlement',
    );
    assert(!env.core.is_payout_privately_settled(id, 1), 'not settled');
    assert(bal(env.usdc, env.helper.contract_address) == POT.into(), 'pot intact');
    stop_cheat_block_timestamp_global();
}

// ===========================================================================
// D. Replay / double collect
// ===========================================================================

#[test]
fn double_collect_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let note: felt252 = 0x7001;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 1, key(0x101));

    apply(env, settle_payout_actions(env, note, note, member_1(), 1, id));
    assert(note_amount(env, note) == POT, 'first paid');

    // Circle state is PrivatelyPaid, and the pool's one-fill note rule is a
    // second independent bound.
    assert(
        apply_fails(env, settle_payout_actions(env, note, note, member_1(), 1, id)),
        'replay rejected',
    );
    assert(note_amount(env, note) == POT, 'note unchanged');
    assert(bal(env.usdc, env.helper.contract_address) == 0, 'no second debit');
}

// ===========================================================================
// E. Caller authorization — no organizer / admin / backend power
// ===========================================================================

#[test]
fn direct_helper_invoke_bypassing_the_pool_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    register(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 1, key(0x101));

    let round: u32 = 1;
    let n: felt252 = 0x7001;
    let z: felt252 = 0;
    let mut cd = array![];
    IwaOperation::SettlePayout.serialize(ref cd);
    id.serialize(ref cd);
    round.serialize(ref cd);
    member_1().serialize(ref cd);
    env.usdc.serialize(ref cd);
    n.serialize(ref cd);
    z.serialize(ref cd);
    z.serialize(ref cd);
    z.serialize(ref cd);
    start_cheat_caller_address(env.helper.contract_address, addr('ATTACKER'));
    let res = call_contract_syscall(
        env.helper.contract_address, selector!("privacy_invoke"), cd.span(),
    );
    stop_cheat_caller_address(env.helper.contract_address);
    assert(res.is_err(), 'pool-only');
    assert(!env.core.is_payout_privately_settled(id, 1), 'not settled');
}

#[test]
fn direct_circle_settlement_call_is_rejected() {
    let env = deploy_env();
    let id = ready_round_1(env);
    register(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 1, key(0x101));

    let round: u32 = 1;
    let n: felt252 = 0x7001;
    let mut cd = array![];
    id.serialize(ref cd);
    round.serialize(ref cd);
    member_1().serialize(ref cd);
    env.usdc.serialize(ref cd);
    n.serialize(ref cd);
    start_cheat_caller_address(env.core.contract_address, addr('ORGANIZER'));
    let res = call_contract_syscall(
        env.core.contract_address, selector!("settle_payout_from_helper_v2"), cd.span(),
    );
    stop_cheat_caller_address(env.core.contract_address);
    assert(res.is_err(), 'helper-only');
    assert(!env.core.is_payout_privately_settled(id, 1), 'not settled');
}

#[test]
fn organizer_cannot_register_a_destination_they_control() {
    let env = deploy_env();
    let id = ready_round_1(env);
    // The organizer holds no member auth key that matches member_1's slot.
    start_cheat_caller_address(env.core.contract_address, addr(0xabc));
    let forged = register_fails(env, id, 1, member_1(), 'EVE_NOTE', POT, 1, EXPIRY, 9, key(0xABC));
    stop_cheat_caller_address(env.core.contract_address);
    assert(forged, 'organizer cannot redirect');
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::Scheduled, 'still scheduled',
    );
}

// ===========================================================================
// F. Atomicity across the pool boundary
// ===========================================================================

#[test]
fn pool_side_failure_after_the_helper_returns_reverts_every_layer() {
    let env = deploy_env();
    let id = ready_round_1(env);
    let registered: felt252 = 0xBB01;
    register(env, id, 1, member_1(), registered, POT, 1, EXPIRY, 1, key(0x101));

    // Create note A, but the invoke references the registered note B. The
    // helper validates B, marks paid, approves the pool and returns
    // OpenNoteDeposit{B}; the pool then rejects because B was never created.
    let created: felt252 = 0xAA01;
    assert(
        apply_fails(env, settle_payout_actions(env, created, registered, member_1(), 1, id)),
        'pool rejects',
    );

    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivateSettlementAuthorized,
        'state rolled back',
    );
    assert(!env.core.is_payout_privately_settled(id, 1), 'paid rolled back');
    assert(allowance_to_pool(env) == 0, 'approval rolled back');
    assert(bal(env.usdc, env.helper.contract_address) == POT.into(), 'pot intact');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == POT.into(), 'liability held');
    assert(env.views.get_note(created).packed_value == 0, 'note A not created');
    assert(
        env.core.get_registered_payout_destination(id, 1).note_id == registered, 'registration held',
    );
}

// ===========================================================================
// G. Deficit / cure / deferred-lock interaction
// ===========================================================================

#[test]
fn deferred_locked_round_cannot_register_a_destination() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 101);
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::DeferredLocked, 'deferred',
    );
    assert(
        register_fails(env, id, 1, member_1(), 0x7001, POT, 1, EXPIRY, 1, key(0x101)),
        'deferred cannot register',
    );
}

#[test]
fn cured_deferred_round_can_register_and_collect_privately() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 101);
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    cure(env, id, 1, member_2(), key(0x102), 202);

    let note: felt252 = 0x7001;
    register(env, id, 1, member_1(), note, POT, 1, EXPIRY, 1, key(0x101));
    apply(env, settle_payout_actions(env, note, note, member_1(), 1, id));
    assert(note_amount(env, note) == POT, 'cured pot collected');
    assert(env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivatelyPaid, 'paid');
}

// ===========================================================================
// H. Recovery is private via the same Candidate P mechanism
// ===========================================================================

#[test]
fn recovery_pays_only_net_funded_value_privately() {
    let env = deploy_env();
    let id = activate(env);
    // Round 1: member_1 recipient, member_2 defaults -> deferred.
    contribute(env, id, 1, member_1(), key(0x101), 101);
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    // Round 2: both contribute -> member_2 recipient, fully funded.
    contribute(env, id, 2, member_1(), key(0x101), 111);
    contribute(env, id, 2, member_2(), key(0x102), 112);
    env.core.finalize_round_payout_accounting(id, 2);
    // Round 2 recipient collects privately first.
    let note2: felt252 = 0x7202;
    register(env, id, 2, member_2(), note2, POT, 1, EXPIRY, 1, key(0x102));
    apply(env, settle_payout_actions(env, note2, note2, member_2(), 2, id));

    env.core.prepare_final_settlement(id);
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::RecoveryPending, 'pending',
    );
    let recovery = env.core.get_recovery_amount(id, 1);
    assert(recovery == AMOUNT, 'net funded only');

    let note1: felt252 = 0x7201;
    let hash = recovery_dest_v2_hash(
        env.core.contract_address, env.helper.contract_address, env.pool, env.usdc, id, 1,
        member_1(), note1, recovery, 1, EXPIRY, 5,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    env
        .core
        .register_recovery_destination(id, 1, note1, recovery, 1, EXPIRY, 5, r, canonical_s(raw_s));

    let mut a = create_open_note(env.usdc, note1);
    a
        .append(
            invoke_helper(
                env, IwaOperation::SettleRecovery, id, 1, member_1(), env.usdc, note1, 0, 0, 0,
            ),
        );
    apply(env, a.span());

    assert(note_amount(env, note1) == AMOUNT, 'exact recovery');
    assert(
        env.core.get_payout_state_v2(id, 1).status == PayoutStatusV2::PrivatelyRecovered,
        'recovered',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round drained');
    assert(allowance_to_pool(env) == 0, 'no residual allowance');
}

// ===========================================================================
// I. V1 immutability — the V2 circle is a distinct class
// ===========================================================================

#[test]
fn v1_circle_class_still_declares_independently() {
    // V1 remains compilable and declarable unchanged alongside V2.
    let v1 = *declare("IwaCircle").unwrap().contract_class().class_hash;
    let v2 = *declare("IwaCircleV2").unwrap().contract_class().class_hash;
    assert(v1 != v2, 'distinct classes');
}

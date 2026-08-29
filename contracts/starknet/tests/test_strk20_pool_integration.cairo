//! Task 8B: end-to-end IWA settlement driven by the real pinned STRK20 pool.
//!
//! Nothing here re-implements protocol behavior. The actual
//! `privacy::privacy::Privacy` contract from the pinned revision is deployed and
//! driven through its own `apply_actions` server-action entrypoint, so every
//! assertion below is about how IWA behaves when the genuine pool moves tokens,
//! forwards `privacy_invoke` calldata, and credits open notes.
//!
//! Only two things are reconstructed test-side, both because the protocol marks
//! them `pub(crate)` and neither changes protocol behavior:
//!   * `compute_message_hash`, so `validate_proof` accepts our cheated proof
//!     facts. A wrong reconstruction is rejected by the pool, never silently
//!     accepted.
//!   * the `EmitOpenNoteCreated` server action, built through the protocol's own
//!     derived `Serde` because its `EncUserAddr` payload is crate-private.

use core::ec::stark_curve;
use core::poseidon::poseidon_hash_span;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_strk20_helper::{
    IIwaStrk20HelperDispatcher, IIwaStrk20HelperDispatcherTrait, IwaOperation,
};
use iwa::iwa_types::{
    ContributionStatus, PayoutStatus, contribution_settlement_authorization_hash,
    cure_settlement_authorization_hash, invite_commitment, payout_authorization_hash,
    payout_settlement_authorization_hash, recovery_settlement_authorization_hash,
};
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
    CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_proof_facts, declare,
    map_entry_address, start_cheat_block_number_global, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::syscalls::{call_contract_syscall, get_class_hash_at_syscall};
use starknet::{ContractAddress, SyscallResultTrait};

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const AMOUNT: u128 = 5_000_000;
const POT: u128 = AMOUNT * 2;
const BLOCK: u64 = 1_000;
const PROOF_VALIDITY_BLOCKS: u64 = 450;

/// `ServerAction::EmitOpenNoteCreated` is the eighth variant of the protocol's
/// `ServerAction` enum (WriteOnce, Append, TransferFrom, TransferTo,
/// EmitViewingKeySet, EmitWithdrawal, EmitDeposit, EmitOpenNoteCreated, ...).
const EMIT_OPEN_NOTE_CREATED: felt252 = 7;

#[derive(Copy, Drop)]
struct Env {
    core: IIwaCircleDispatcher,
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

/// Immutable surplus destination pinned at deployment. Not selectable by any
/// caller and never a parameter of a settlement path.
fn surplus_sink() -> ContractAddress {
    addr('SURPLUS_SINK')
}

fn key(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}

fn member_1() -> felt252 {
    invite_commitment(SECRET_1)
}

fn member_2() -> felt252 {
    invite_commitment(SECRET_2)
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
    let mut calldata = array![];
    name.serialize(ref calldata);
    symbol.serialize(ref calldata);
    let (address, _) = class.deploy(@calldata).unwrap();
    address
}

// ---------------------------------------------------------------------------
// Real pool wiring
// ---------------------------------------------------------------------------

/// Mirrors `privacy::utils::compute_message_hash` (crate-private at the pinned
/// revision). The L1 message is `[pool, 0, payload_len, ...payload]` where the
/// payload is `[class_hash, ...serialized_server_actions]`.
fn message_hash(actions: Span<ServerAction>, pool: ContractAddress) -> felt252 {
    let mut l1_message_data: Array<felt252> = array![pool.into(), 0];
    let mut payload = array![];
    let class_hash = get_class_hash_at_syscall(pool).unwrap_syscall();
    class_hash.serialize(ref payload);
    actions.serialize(ref payload);
    payload.serialize(ref l1_message_data);
    poseidon_hash_span(l1_message_data.span())
}

/// Supplies the proof facts the pool's `validate_proof` requires. This is
/// environment the local runner cannot produce naturally: it stands in for the
/// Starknet OS proof, and relaxes no pool check.
fn cheat_pool_proof(env: Env, actions: Span<ServerAction>) {
    let proof_facts = ProofFacts {
        proof_version: 0,
        program_variant: VIRTUAL_SNOS,
        virtual_program_hash: 0,
        starknet_os_output_version: VIRTUAL_SNOS0,
        base_block_number: BLOCK - 1,
        base_block_hash: 0,
        starknet_os_config_hash: 0,
        message_to_l1_hashes: [message_hash(actions, env.pool)].span(),
    };
    let mut serialized = array![];
    proof_facts.serialize(ref serialized);
    cheat_proof_facts(env.pool, serialized.span(), CheatSpan::TargetCalls(1));
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

/// The pool's withdraw leg: an ERC20 transfer from the pool to the helper,
/// applied before the invoke exactly as the protocol's action phases require.
fn transfer_to_helper(env: Env, token: ContractAddress, amount: u128) -> ServerAction {
    ServerAction::TransferTo(
        TransferToInput { to_addr: env.helper.contract_address, token, amount },
    )
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
    let mut calldata = array![];
    operation.serialize(ref calldata);
    id.serialize(ref calldata);
    round.serialize(ref calldata);
    member.serialize(ref calldata);
    token.serialize(ref calldata);
    note.serialize(ref calldata);
    nonce.serialize(ref calldata);
    r.serialize(ref calldata);
    s.serialize(ref calldata);
    ServerAction::Invoke(
        InvokeInput { contract_address: env.helper.contract_address, calldata: calldata.span() },
    )
}

/// `events::OpenNoteCreated.enc_recipient_addr` is a crate-private `EncUserAddr`
/// (three felts of auditor-encrypted address) that the pool emits but never
/// validates, so the action is built through the protocol's derived `Serde`.
fn emit_open_note_created(token: ContractAddress, note_id: felt252) -> ServerAction {
    let data = array![EMIT_OPEN_NOTE_CREATED, 0, 0, 0, token.into(), note_id];
    let mut span = data.span();
    let action: ServerAction = Serde::deserialize(ref span).expect('open note action encoding');
    assert(span.is_empty(), 'open note action length');
    action
}

/// The two server actions the protocol's own `create_open_note` compiles a
/// client `CreateOpenNote` into: a `WriteOnce` seeding `notes[note_id]` with a
/// zero-valued open note, then `EmitOpenNoteCreated` registering it as awaiting
/// a deposit.
fn create_open_note(token: ContractAddress, note_id: felt252) -> Array<ServerAction> {
    let note = Note { packed_value: OPEN_NOTE_PACKED_VALUE, token };
    let mut value = array![];
    note.serialize(ref value);
    let write_once = ServerAction::WriteOnce(
        WriteOnceInput {
            storage_address: map_entry_address(selector!("notes"), [note_id].span()),
            value: value.span(),
        },
    );
    array![write_once, emit_open_note_created(token, note_id)]
}

fn deploy_env() -> Env {
    start_cheat_block_number_global(BLOCK);
    let usdc = deploy_token("USD Coin", "USDC");
    let strk = deploy_token("Stark", "STRK");

    // The genuine pinned pool contract.
    let pool_class = declare("Privacy").unwrap().contract_class();
    let mut pool_data = array![];
    addr('GOVERNANCE').serialize(ref pool_data);
    key('auditor').public_key.serialize(ref pool_data);
    key('screener').public_key.serialize(ref pool_data);
    PROOF_VALIDITY_BLOCKS.serialize(ref pool_data);
    let (pool, _) = pool_class.deploy(@pool_data).unwrap();

    let setup = addr(0x666);
    let core_class = declare("IwaCircle").unwrap().contract_class();
    let mut core_data = array![];
    usdc.serialize(ref core_data);
    strk.serialize(ref core_data);
    pool.serialize(ref core_data);
    setup.serialize(ref core_data);
    let (core_address, _) = core_class.deploy(@core_data).unwrap();
    let core = IIwaCircleDispatcher { contract_address: core_address };

    let helper_class = declare("IwaStrk20Helper").unwrap().contract_class();
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

/// Models a user's shielded balance already held by the pool.
fn fund_pool(env: Env, token: ContractAddress, amount: u128) {
    let amount_u256: u256 = amount.into();
    ITestErc20Dispatcher { contract_address: token }.mint(env.pool, amount_u256);
}

fn balance_of(token: ContractAddress, account: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(:account)
}

fn allowance_to_pool(env: Env, token: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }
        .allowance(owner: env.helper.contract_address, spender: env.pool)
}

fn note_amount(env: Env, note_id: felt252) -> u128 {
    let note = env.views.get_note(note_id);
    let filled: u256 = (note.packed_value - OPEN_NOTE_PACKED_VALUE).into();
    filled.try_into().unwrap()
}

// ---------------------------------------------------------------------------
// IWA circle setup
// ---------------------------------------------------------------------------

fn activate(env: Env) -> u32 {
    start_cheat_caller_address(env.core.contract_address, addr(0xabc));
    let id = env
        .core
        .create_circle(env.usdc, AMOUNT, 100, 50, 2, array![member_1(), member_2()].span());
    env.core.join_circle(id, SECRET_1, key(0x101).public_key);
    start_cheat_block_timestamp(env.core.contract_address, 1_000);
    env.core.join_circle(id, SECRET_2, key(0x102).public_key);
    stop_cheat_caller_address(env.core.contract_address);
    id
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

/// One full private contribution: pool withdraws to the helper, then invokes it.
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
    start_cheat_block_timestamp(env.core.contract_address, grace + 1);
    env.core.finalize_contribution_default(id, round, member);
}

fn authorize_payout(env: Env, id: u32, round: u32, signer: StarkCurveKeyPair, nonce: felt252) {
    let payout = env.core.get_payout_state(id, round);
    let hash = payout_authorization_hash(
        id, round, payout.scheduled_member_ref, payout.amount, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    env.core.authorize_payout_settlement(id, round, nonce, r, canonical_s(raw_s));
}

fn sign_payout(
    env: Env,
    id: u32,
    round: u32,
    member: felt252,
    amount: u128,
    note: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = payout_settlement_authorization_hash(
        id, round, member, env.helper.contract_address, env.pool, env.usdc, amount, note, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

fn sign_recovery(
    env: Env,
    id: u32,
    round: u32,
    member: felt252,
    amount: u128,
    note: felt252,
    signer: StarkCurveKeyPair,
    nonce: felt252,
) -> (felt252, felt252) {
    let hash = recovery_settlement_authorization_hash(
        id, round, member, env.helper.contract_address, env.pool, env.usdc, amount, note, nonce,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(raw_s))
}

/// Drives a payout or recovery: create the output open note, then invoke.
fn settle_outbound(
    env: Env,
    operation: IwaOperation,
    id: u32,
    round: u32,
    member: felt252,
    note: felt252,
    nonce: felt252,
    r: felt252,
    s: felt252,
) -> Span<ServerAction> {
    let mut actions = create_open_note(env.usdc, note);
    actions.append(invoke_helper(env, operation, id, round, member, env.usdc, note, nonce, r, s));
    actions.span()
}

// ===========================================================================
// A. Contribution
// ===========================================================================

#[test]
fn pool_contribution_moves_exact_value_and_credits_one_round() {
    let env = deploy_env();
    let id = activate(env);
    fund_pool(env, env.usdc, AMOUNT);
    let (r, s) = sign_contribution(env, id, 1, member_1(), key(0x101), 40);

    apply(
        env,
        array![
            transfer_to_helper(env, env.usdc, AMOUNT),
            invoke_helper(
                env, IwaOperation::SettleContribution, id, 1, member_1(), env.usdc, 0, 40, r, s,
            ),
        ]
            .span(),
    );

    // Real token movement: pool emptied, helper holds exactly the contribution.
    assert(balance_of(env.usdc, env.pool) == 0, 'pool drained');
    assert(balance_of(env.usdc, env.helper.contract_address) == AMOUNT.into(), 'helper custody');

    // Custody equals accounted liability, in exactly one round and one token.
    assert(env.helper.get_token_liability(env.usdc) == AMOUNT.into(), 'token liability');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == AMOUNT.into(), 'round');
    assert(env.helper.get_round_token_liability(id, 2, env.usdc) == 0, 'no other round');
    assert(env.helper.get_round_token_liability(id, 1, env.strk) == 0, 'no other token');

    // Core state advanced through the helper-only path.
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::OnTime,
        'on time',
    );
    assert(env.core.is_contribution_nonce_consumed(id, member_1(), 40), 'nonce consumed');

    // Inbound legs bind no output note.
    assert(allowance_to_pool(env, env.usdc) == 0, 'no approval');
}

// ===========================================================================
// B. Cure
// ===========================================================================

#[test]
fn pool_cure_settles_exact_deficit_without_erasing_default_history() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 41);
    default_member(env, id, 1, member_2());
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_2())
            .status == ContributionStatus::MissedDefault,
        'defaulted',
    );

    let cure = env.core.get_cure_state(id, 1, member_2());
    let deficit = cure.deficit_amount;
    assert(deficit == AMOUNT, 'exact deficit');

    fund_pool(env, env.usdc, deficit);
    let hash = cure_settlement_authorization_hash(
        id, 1, member_2(), env.helper.contract_address, env.pool, env.usdc, deficit, 42,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x102), hash).unwrap();
    apply(
        env,
        array![
            transfer_to_helper(env, env.usdc, deficit),
            invoke_helper(
                env,
                IwaOperation::SettleCure,
                id,
                1,
                member_2(),
                env.usdc,
                0,
                42,
                r,
                canonical_s(raw_s),
            ),
        ]
            .span(),
    );

    assert(balance_of(env.usdc, env.helper.contract_address) == POT.into(), 'custody');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == POT.into(), 'round credit');
    assert(env.core.get_cure_state(id, 1, member_2()).deficit_settled, 'cured');
    assert(env.core.is_cure_nonce_consumed(id, member_2(), 42), 'cure nonce');

    // Cure funds the round; it never rewrites reliability history.
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_2())
            .status == ContributionStatus::MissedDefault,
        'history immutable',
    );
    assert(allowance_to_pool(env, env.usdc) == 0, 'no approval');
}

// ===========================================================================
// C. Payout
// ===========================================================================

#[test]
fn pool_payout_credits_exact_open_note_and_leaves_no_allowance() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 43);
    contribute(env, id, 1, member_2(), key(0x102), 44);
    env.core.finalize_round_payout_accounting(id, 1);
    authorize_payout(env, id, 1, key(0x101), 45);
    assert(
        env.core.get_payout_state(id, 1).status == PayoutStatus::SettlementAuthorized, 'authorized',
    );

    let note = 0x9001;
    let (r, s) = sign_payout(env, id, 1, member_1(), POT, note, key(0x101), 46);
    apply(env, settle_outbound(env, IwaOperation::SettlePayout, id, 1, member_1(), note, 46, r, s));

    // The pool pulled the exact payout out of helper custody into the note.
    assert(note_amount(env, note) == POT, 'note filled exactly');
    assert(env.views.get_note(note).token == env.usdc, 'note token');
    assert(balance_of(env.usdc, env.helper.contract_address) == 0, 'custody released');
    assert(balance_of(env.usdc, env.pool) == POT.into(), 'pool holds note value');

    // Accounting drained with it, and no residual approval survives.
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round debited');
    assert(env.helper.get_token_liability(env.usdc) == 0, 'token debited');
    assert(allowance_to_pool(env, env.usdc) == 0, 'no residual allowance');
    assert(env.core.get_payout_state(id, 1).status == PayoutStatus::Paid, 'paid');

    // Replay is refused, by IWA and by the protocol's one-fill note rule.
    let replay = settle_outbound(
        env, IwaOperation::SettlePayout, id, 1, member_1(), note, 46, r, s,
    );
    assert(apply_fails(env, replay), 'replay rejected');
    assert(note_amount(env, note) == POT, 'note unchanged');
}

// ===========================================================================
// D. Recovery
// ===========================================================================

#[test]
fn pool_recovery_pays_only_same_round_net_funded_value() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 47);
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    contribute(env, id, 2, member_1(), key(0x101), 48);
    contribute(env, id, 2, member_2(), key(0x102), 49);
    env.core.finalize_round_payout_accounting(id, 2);
    authorize_payout(env, id, 2, key(0x102), 50);
    env.core.prepare_final_settlement(id);

    assert(env.core.get_payout_state(id, 1).status == PayoutStatus::RecoveryPending, 'pending');
    let recovery = env.core.get_recovery_amount(id, 1);
    assert(recovery == AMOUNT, 'net funded only');

    let helper_before = balance_of(env.usdc, env.helper.contract_address);
    let note = 0x9002;
    let (r, s) = sign_recovery(env, id, 1, member_1(), recovery, note, key(0x101), 51);
    apply(
        env, settle_outbound(env, IwaOperation::SettleRecovery, id, 1, member_1(), note, 51, r, s),
    );

    assert(note_amount(env, note) == recovery, 'exact recovery');
    assert(
        balance_of(env.usdc, env.helper.contract_address) == helper_before - recovery.into(),
        'custody reduced exactly',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round drained');
    // Round 2 funding was never touched to pay round 1.
    assert(env.helper.get_round_token_liability(id, 2, env.usdc) == POT.into(), 'round 2 intact');
    assert(env.core.get_payout_state(id, 1).status == PayoutStatus::Recovered, 'recovered');
    assert(allowance_to_pool(env, env.usdc) == 0, 'no residual allowance');
}

// ===========================================================================
// E. NoFundedRecovery
// ===========================================================================

#[test]
fn pool_zero_funded_recovery_never_moves_value() {
    let env = deploy_env();
    let id = activate(env);
    default_member(env, id, 1, member_1());
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    contribute(env, id, 2, member_1(), key(0x101), 52);
    contribute(env, id, 2, member_2(), key(0x102), 53);
    env.core.finalize_round_payout_accounting(id, 2);
    authorize_payout(env, id, 2, key(0x102), 54);
    env.core.prepare_final_settlement(id);

    assert(env.core.get_recovery_amount(id, 1) == 0, 'zero recovery');
    assert(env.core.get_payout_state(id, 1).status == PayoutStatus::NoFundedRecovery, 'no funded');

    let custody = balance_of(env.usdc, env.helper.contract_address);
    let note = 0x9003;
    let (r, s) = sign_recovery(env, id, 1, member_1(), 0, note, key(0x101), 55);
    let attempt = settle_outbound(
        env, IwaOperation::SettleRecovery, id, 1, member_1(), note, 55, r, s,
    );
    assert(apply_fails(env, attempt), 'no zero settlement');

    assert(balance_of(env.usdc, env.helper.contract_address) == custody, 'custody untouched');
    assert(allowance_to_pool(env, env.usdc) == 0, 'no approval');
    assert(!env.core.is_recovery_settlement_nonce_consumed(id, member_1(), 55), 'nonce free');
    assert(
        env.core.get_payout_state(id, 1).status == PayoutStatus::NoFundedRecovery,
        'still no funded',
    );
}

// ===========================================================================
// F. Rollback / atomicity
// ===========================================================================

#[test]
fn pool_transaction_rolls_back_every_layer_on_any_failure() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 56);

    let custody = balance_of(env.usdc, env.helper.contract_address);
    let round_liability = env.helper.get_round_token_liability(id, 1, env.usdc);
    let member_2_status = env.core.get_contribution_obligation(id, 1, member_2()).status;

    // 1. Wrong signing key on an otherwise valid contribution.
    fund_pool(env, env.usdc, AMOUNT);
    let (bad_r, bad_s) = sign_contribution(env, id, 1, member_2(), key(0x101), 57);
    assert(
        apply_fails(
            env,
            array![
                transfer_to_helper(env, env.usdc, AMOUNT),
                invoke_helper(
                    env,
                    IwaOperation::SettleContribution,
                    id,
                    1,
                    member_2(),
                    env.usdc,
                    0,
                    57,
                    bad_r,
                    bad_s,
                ),
            ]
                .span(),
        ),
        'bad signature',
    );

    // 2. Inbound amount that does not match the obligation.
    let (r2, s2) = sign_contribution(env, id, 1, member_2(), key(0x102), 58);
    assert(
        apply_fails(
            env,
            array![
                transfer_to_helper(env, env.usdc, AMOUNT - 1),
                invoke_helper(
                    env,
                    IwaOperation::SettleContribution,
                    id,
                    1,
                    member_2(),
                    env.usdc,
                    0,
                    58,
                    r2,
                    s2,
                ),
            ]
                .span(),
        ),
        'short funding',
    );

    // 3. Wrong token for the circle.
    fund_pool(env, env.strk, AMOUNT);
    assert(
        apply_fails(
            env,
            array![
                transfer_to_helper(env, env.strk, AMOUNT),
                invoke_helper(
                    env,
                    IwaOperation::SettleContribution,
                    id,
                    1,
                    member_2(),
                    env.strk,
                    0,
                    58,
                    r2,
                    s2,
                ),
            ]
                .span(),
        ),
        'wrong token',
    );

    // Fund the round legitimately so the payout leg below fails only on the
    // output note, not on readiness or funding.
    contribute(env, id, 1, member_2(), key(0x102), 61);
    env.core.finalize_round_payout_accounting(id, 1);
    authorize_payout(env, id, 1, key(0x101), 59);
    let funded_custody = balance_of(env.usdc, env.helper.contract_address);
    let funded_liability = env.helper.get_round_token_liability(id, 1, env.usdc);

    // 4. Output note mismatch: the transaction creates open note A while the
    // member authorized note B. The helper debits liability and approves the
    // pool before the pool rejects the deposit, so this proves the rollback
    // reaches back across the protocol boundary into IWA state.
    let created_note = 0x9004;
    let authorized_note = 0x9005;
    let (pr, ps) = sign_payout(env, id, 1, member_1(), POT, authorized_note, key(0x101), 60);
    let mut mismatched = create_open_note(env.usdc, created_note);
    mismatched
        .append(
            invoke_helper(
                env,
                IwaOperation::SettlePayout,
                id,
                1,
                member_1(),
                env.usdc,
                authorized_note,
                60,
                pr,
                ps,
            ),
        );
    assert(apply_fails(env, mismatched.span()), 'note mismatch');

    // Every layer is exactly as it was before the four failed transactions.
    assert(custody == AMOUNT.into(), 'first leg settled');
    assert(round_liability == AMOUNT.into(), 'first leg credited');
    assert(funded_custody == POT.into(), 'round fully funded');
    assert(
        balance_of(env.usdc, env.helper.contract_address) == funded_custody, 'custody rolled back',
    );
    assert(balance_of(env.usdc, env.pool) == AMOUNT.into(), 'pool intact');
    assert(balance_of(env.strk, env.pool) == AMOUNT.into(), 'strk intact');
    assert(balance_of(env.strk, env.helper.contract_address) == 0, 'no strk custody');
    assert(
        env.helper.get_round_token_liability(id, 1, env.usdc) == funded_liability, 'liability held',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.strk) == 0, 'no strk liability');
    assert(member_2_status == ContributionStatus::Pending, 'was pending');
    // Only the legitimate leg moved member 2 forward; none of the failures did.
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_2())
            .status == ContributionStatus::OnTime,
        'only legit leg',
    );
    assert(!env.core.is_contribution_nonce_consumed(id, member_2(), 57), 'nonce 57 free');
    assert(!env.core.is_contribution_nonce_consumed(id, member_2(), 58), 'nonce 58 free');
    assert(!env.core.is_payout_settlement_nonce_consumed(id, member_1(), 60), 'payout nonce free');
    assert(
        env.core.get_payout_state(id, 1).status == PayoutStatus::SettlementAuthorized,
        'payout state held',
    );
    assert(allowance_to_pool(env, env.usdc) == 0, 'no allowance leaked');
    assert(env.views.get_note(created_note).packed_value == 0, 'no note created');
    assert(env.views.get_note(authorized_note).packed_value == 0, 'no note filled');
}


// ===========================================================================
// 8B-01 regression: unsolicited surplus is inert, removable, and never backing
// ===========================================================================
//
// A 1-unit donation to the helper used to make `assert_exact_inbound_balance`
// reject every later contribution and cure in that token, permanently. Exact
// inbound accounting is kept; `normalize_surplus` gives anyone a deterministic
// way to push the unaccounted excess out to an immutable sink so the exact rule
// can be satisfied again. Surplus is never liability and never funds anything.

fn donate(env: Env, token: ContractAddress, amount: u128) {
    ITestErc20Dispatcher { contract_address: token }
        .mint(env.helper.contract_address, amount.into());
}

fn normalize_fails(env: Env, token: ContractAddress) -> bool {
    let mut data = array![];
    token.serialize(ref data);
    call_contract_syscall(env.helper.contract_address, selector!("normalize_surplus"), data.span())
        .is_err()
}

// --- A. A donation does not become backing -------------------------------

#[test]
fn donation_is_surplus_and_never_becomes_backing() {
    let env = deploy_env();
    let id = activate(env);
    donate(env, env.usdc, 1);

    // Visible as surplus, and nowhere else.
    assert(env.helper.get_surplus(env.usdc) == 1_u256, 'surplus seen');
    assert(env.helper.get_token_liability(env.usdc) == 0, 'no custody credit');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'no round credit');
    assert(env.helper.get_round_token_liability(id, 2, env.usdc) == 0, 'no other round');

    // It satisfies no obligation and consumes nothing.
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::Pending,
        'still pending',
    );
    assert(!env.core.is_contribution_nonce_consumed(id, member_1(), 70), 'no nonce');
    assert(allowance_to_pool(env, env.usdc) == 0, 'no approval');
}

// --- B + C. Normalization restores exact inbound settlement ---------------

#[test]
fn surplus_normalization_restores_exact_inbound_settlement() {
    let env = deploy_env();
    let id = activate(env);
    donate(env, env.usdc, 1);

    // B. Anyone may normalize; exactly the surplus leaves, to the pinned sink.
    let removed = env.helper.normalize_surplus(env.usdc);
    assert(removed == 1_u256, 'exact surplus removed');
    assert(balance_of(env.usdc, surplus_sink()) == 1_u256, 'sink received');
    assert(env.helper.get_surplus(env.usdc) == 0, 'no surplus left');
    assert(
        balance_of(env.usdc, env.helper.contract_address) == env
            .helper
            .get_token_liability(env.usdc),
        'balance equals custody',
    );
    assert(env.helper.get_token_liability(env.usdc) == 0, 'custody unchanged');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'liability unchanged');

    // C. A real pool contribution now settles exactly as before the donation.
    contribute(env, id, 1, member_1(), key(0x101), 70);
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::OnTime,
        'settles again',
    );
    // Credited by the contribution only; the donated unit was never counted.
    assert(env.helper.get_token_liability(env.usdc) == AMOUNT.into(), 'exact credit');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == AMOUNT.into(), 'round credit');
    assert(balance_of(env.usdc, env.helper.contract_address) == AMOUNT.into(), 'custody exact');
    assert(env.helper.get_surplus(env.usdc) == 0, 'no residual surplus');
}

// --- D + G. Legitimate backing can never be swept -------------------------

#[test]
fn normalization_cannot_touch_legitimate_backing() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 71);
    let backing = env.helper.get_token_liability(env.usdc);
    assert(backing == AMOUNT.into(), 'funded');

    // D. With balance == accounted custody there is nothing to take, and the
    // attempt fails rather than silently draining backing.
    assert(env.helper.get_surplus(env.usdc) == 0, 'no surplus');
    assert(normalize_fails(env, env.usdc), 'nothing to normalize');

    // G. The failed call changed no balance and no accounting.
    assert(balance_of(env.usdc, env.helper.contract_address) == backing, 'backing intact');
    assert(balance_of(env.usdc, surplus_sink()) == 0, 'sink got nothing');
    assert(env.helper.get_token_liability(env.usdc) == backing, 'custody intact');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == backing, 'round intact');

    // With funded backing AND surplus present, only the surplus may leave.
    donate(env, env.usdc, 7);
    let removed = env.helper.normalize_surplus(env.usdc);
    assert(removed == 7_u256, 'only surplus');
    assert(balance_of(env.usdc, env.helper.contract_address) == backing, 'backing untouched');
    assert(env.helper.get_token_liability(env.usdc) == backing, 'custody untouched');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == backing, 'round untouched');
    assert(balance_of(env.usdc, surplus_sink()) == 7_u256, 'sink got surplus only');

    // The still-funded round pays out in full afterwards, proving the backing
    // survived normalization intact.
    contribute(env, id, 1, member_2(), key(0x102), 72);
    env.core.finalize_round_payout_accounting(id, 1);
    authorize_payout(env, id, 1, key(0x101), 73);
    let note = 0x9101;
    let (r, s) = sign_payout(env, id, 1, member_1(), POT, note, key(0x101), 74);
    apply(env, settle_outbound(env, IwaOperation::SettlePayout, id, 1, member_1(), note, 74, r, s));
    assert(note_amount(env, note) == POT, 'full payout survives');
}

// --- E. Token isolation ---------------------------------------------------

#[test]
fn surplus_normalization_is_token_isolated() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 75);
    let usdc_backing = env.helper.get_token_liability(env.usdc);

    // A STRK donation is STRK surplus only.
    donate(env, env.strk, 9);
    assert(env.helper.get_surplus(env.strk) == 9_u256, 'strk surplus');
    assert(env.helper.get_surplus(env.usdc) == 0, 'usdc unaffected');

    let removed = env.helper.normalize_surplus(env.strk);
    assert(removed == 9_u256, 'strk surplus removed');
    assert(balance_of(env.strk, surplus_sink()) == 9_u256, 'sink strk');
    assert(balance_of(env.usdc, surplus_sink()) == 0, 'sink no usdc');

    // Nothing about USDC moved or was re-accounted.
    assert(balance_of(env.usdc, env.helper.contract_address) == usdc_backing, 'usdc custody');
    assert(env.helper.get_token_liability(env.usdc) == usdc_backing, 'usdc liability');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == usdc_backing, 'usdc round');
    assert(env.helper.get_token_liability(env.strk) == 0, 'strk never credited');
    assert(env.helper.get_round_token_liability(id, 1, env.strk) == 0, 'strk round zero');

    // An unsupported token has no rescue surface at all.
    assert(normalize_fails(env, addr(0x999)), 'unsupported token');
}

// --- F. Permissionless, but the caller cannot profit ----------------------

#[test]
fn normalization_is_permissionless_and_unprofitable() {
    let env = deploy_env();
    activate(env);
    donate(env, env.usdc, 5);

    // An arbitrary third party triggers it.
    let stranger = addr(0xfeed);
    start_cheat_caller_address(env.helper.contract_address, stranger);
    let removed = env.helper.normalize_surplus(env.usdc);
    stop_cheat_caller_address(env.helper.contract_address);

    // The destination came from immutable storage, not from the caller, and the
    // caller received nothing for the trouble.
    assert(removed == 5_u256, 'surplus removed');
    assert(balance_of(env.usdc, stranger) == 0, 'caller gains nothing');
    assert(balance_of(env.usdc, surplus_sink()) == 5_u256, 'sink is the only payee');
    assert(env.helper.get_config().surplus_sink == surplus_sink(), 'sink immutable');
    assert(env.helper.get_surplus(env.usdc) == 0, 'normalized');
}

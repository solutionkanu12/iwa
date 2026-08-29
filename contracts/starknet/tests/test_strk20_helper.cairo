use core::ec::stark_curve;
use core::serde::Serde;
use iwa::iwa_circle::{IIwaCircleDispatcher, IIwaCircleDispatcherTrait};
use iwa::iwa_errors;
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
use privacy::objects::OpenNoteDeposit;
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use starknet::syscalls::call_contract_syscall;

const SECRET_1: felt252 = 'secret-1';
const SECRET_2: felt252 = 'secret-2';
const AMOUNT: u128 = 5_000_000;
const POT: u128 = AMOUNT * 2;

#[derive(Copy, Drop)]
struct Env {
    core: IIwaCircleDispatcher,
    helper: IIwaStrk20HelperDispatcher,
    usdc: ContractAddress,
    strk: ContractAddress,
    pool: ContractAddress,
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

fn helper_deploy_fails(
    core: ContractAddress,
    pool: ContractAddress,
    usdc: ContractAddress,
    strk: ContractAddress,
    sink: ContractAddress,
) -> bool {
    let class = declare("IwaStrk20Helper").unwrap().contract_class();
    let mut calldata = array![];
    core.serialize(ref calldata);
    pool.serialize(ref calldata);
    usdc.serialize(ref calldata);
    strk.serialize(ref calldata);
    sink.serialize(ref calldata);
    class.deploy(@calldata).is_err()
}

fn deploy_env() -> Env {
    let usdc = deploy_token("USD Coin", "USDC");
    let strk = deploy_token("Stark", "STRK");
    let pool = addr(0x444);
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
    Env { core, helper, usdc, strk, pool }
}

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

fn mint(env: Env, amount: u128) {
    let amount_u256: u256 = amount.into();
    ITestErc20Dispatcher { contract_address: env.usdc }
        .mint(env.helper.contract_address, amount_u256);
}

fn invoke(
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
) -> Span<OpenNoteDeposit> {
    start_cheat_caller_address(env.helper.contract_address, env.pool);
    env.helper.privacy_invoke(operation, id, round, member, token, note, nonce, r, s)
}

fn invoke_fails(
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
) -> bool {
    let mut data = array![];
    operation.serialize(ref data);
    id.serialize(ref data);
    round.serialize(ref data);
    member.serialize(ref data);
    token.serialize(ref data);
    note.serialize(ref data);
    nonce.serialize(ref data);
    r.serialize(ref data);
    s.serialize(ref data);
    start_cheat_caller_address(env.helper.contract_address, env.pool);
    call_contract_syscall(env.helper.contract_address, selector!("privacy_invoke"), data.span())
        .is_err()
}

fn invoke_panic_data(
    env: Env,
    caller: ContractAddress,
    operation: IwaOperation,
    id: u32,
    round: u32,
    member: felt252,
    token: ContractAddress,
    note: felt252,
    nonce: felt252,
    r: felt252,
    s: felt252,
) -> Array<felt252> {
    let mut data = array![];
    operation.serialize(ref data);
    id.serialize(ref data);
    round.serialize(ref data);
    member.serialize(ref data);
    token.serialize(ref data);
    note.serialize(ref data);
    nonce.serialize(ref data);
    r.serialize(ref data);
    s.serialize(ref data);
    start_cheat_caller_address(env.helper.contract_address, caller);
    match call_contract_syscall(
        env.helper.contract_address, selector!("privacy_invoke"), data.span(),
    ) {
        Result::Ok(_) => array![],
        Result::Err(panic_data) => panic_data,
    }
}

fn core_call_panic_data(env: Env, selector: felt252, calldata: Span<felt252>) -> Array<felt252> {
    match call_contract_syscall(env.core.contract_address, selector, calldata) {
        Result::Ok(_) => array![],
        Result::Err(panic_data) => panic_data,
    }
}

// A reverting inter-contract call surfaces the inner reason plus trailing
// dispatcher frames such as 'ENTRYPOINT_FAILED', so match on membership rather
// than on a fixed position. An Ok call yields an empty array and never matches.
fn panic_contains(panic_data: Array<felt252>, expected: felt252) -> bool {
    let mut i = 0;
    let mut found = false;
    while i < panic_data.len() {
        if *panic_data.at(i) == expected {
            found = true;
        }
        i += 1;
    }
    found
}

fn invoke_reverts_with(
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
    expected: felt252,
) -> bool {
    panic_contains(
        invoke_panic_data(env, env.pool, operation, id, round, member, token, note, nonce, r, s),
        expected,
    )
}

fn sign_contribution(
    env: Env, id: u32, round: u32, member: felt252, signer: StarkCurveKeyPair, nonce: felt252,
) -> (felt252, felt252) {
    let hash = contribution_settlement_authorization_hash(
        id, round, member, env.helper.contract_address, env.pool, env.usdc, AMOUNT, nonce,
    );
    let (r, s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    (r, canonical_s(s))
}

fn contribute(
    env: Env, id: u32, round: u32, member: felt252, signer: StarkCurveKeyPair, nonce: felt252,
) -> Span<OpenNoteDeposit> {
    mint(env, AMOUNT);
    let (r, s) = sign_contribution(env, id, round, member, signer, nonce);
    invoke(env, IwaOperation::SettleContribution, id, round, member, env.usdc, 0, nonce, r, s)
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
    let (r, s) = StarkCurveSignerImpl::sign(signer, hash).unwrap();
    env.core.authorize_payout_settlement(id, round, nonce, r, canonical_s(s));
}

#[test]
fn dependency_constructor_and_pool_only_boundary() {
    let probe = OpenNoteDeposit { note_id: 1, token: addr(1), amount: 1 };
    assert(probe.amount == 1, 'privacy import');
    let env = deploy_env();
    let config = env.helper.get_config();
    assert(config.iwa_circle == env.core.contract_address, 'core');
    assert(config.privacy_pool == env.pool, 'pool');
    assert(config.usdc_token == env.usdc, 'usdc');
    assert(config.strk_token == env.strk, 'strk');
    assert(config.surplus_sink == surplus_sink(), 'sink');
    let zero: ContractAddress = 0.try_into().unwrap();
    let core = env.core.contract_address;
    assert(helper_deploy_fails(zero, env.pool, env.usdc, env.strk, surplus_sink()), 'zero core');
    assert(helper_deploy_fails(core, zero, env.usdc, env.strk, surplus_sink()), 'zero pool');
    assert(helper_deploy_fails(core, env.pool, zero, env.strk, surplus_sink()), 'zero token');
    assert(helper_deploy_fails(core, env.pool, env.usdc, env.usdc, surplus_sink()), 'same token');
    // The surplus destination is validated at deployment and can never be
    // changed afterwards, so these are the only chances to get it wrong.
    assert(helper_deploy_fails(core, env.pool, env.usdc, env.strk, zero), 'zero sink');
    assert(helper_deploy_fails(core, env.pool, env.usdc, env.strk, env.pool), 'pool sink');
    assert(helper_deploy_fails(core, env.pool, env.usdc, env.strk, env.usdc), 'token sink');

    let id = activate(env);
    mint(env, AMOUNT);
    let (r, s) = sign_contribution(env, id, 1, member_1(), key(0x101), 1);
    let mut data = array![];
    IwaOperation::SettleContribution.serialize(ref data);
    id.serialize(ref data);
    1_u32.serialize(ref data);
    member_1().serialize(ref data);
    env.usdc.serialize(ref data);
    0.serialize(ref data);
    1.serialize(ref data);
    r.serialize(ref data);
    s.serialize(ref data);
    start_cheat_caller_address(env.helper.contract_address, addr(0xdead));
    assert(
        call_contract_syscall(env.helper.contract_address, selector!("privacy_invoke"), data.span())
            .is_err(),
        'attacker',
    );
    assert(env.helper.get_token_liability(env.usdc) == 0, 'atomic helper');
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_1())
            .status == ContributionStatus::Pending,
        'atomic core',
    );
}

#[test]
fn contribution_and_cure_park_exact_round_token_liability_with_empty_output() {
    let env = deploy_env();
    let id = activate(env);
    assert(contribute(env, id, 1, member_1(), key(0x101), 10).len() == 0, 'contribution empty');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == AMOUNT.into(), 'round credit');
    assert(env.helper.get_token_liability(env.strk) == 0, 'token isolated');
    let (r, s) = sign_contribution(env, id, 1, member_2(), key(0x102), 11);
    assert(
        invoke_fails(
            env, IwaOperation::SettleContribution, id, 1, member_2(), env.usdc, 99, 11, r, s,
        ),
        'inbound note',
    );
    assert(
        env.helper.get_round_token_liability(id, 1, env.usdc) == AMOUNT.into(), 'failed unchanged',
    );

    default_member(env, id, 1, member_2());
    mint(env, AMOUNT);
    let hash = cure_settlement_authorization_hash(
        id, 1, member_2(), env.helper.contract_address, env.pool, env.usdc, AMOUNT, 12,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x102), hash).unwrap();
    assert(
        invoke(
            env,
            IwaOperation::SettleCure,
            id,
            1,
            member_2(),
            env.usdc,
            0,
            12,
            r,
            canonical_s(raw_s),
        )
            .len() == 0,
        'cure empty',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == POT.into(), 'cure credit');
    assert(
        env
            .core
            .get_contribution_obligation(id, 1, member_2())
            .status == ContributionStatus::MissedDefault,
        'history',
    );
}

#[test]
fn contribution_rejects_wrong_helper_pool_token_amount_and_member_authorization() {
    let env = deploy_env();
    let id = activate(env);
    mint(env, AMOUNT);
    let nonce: felt252 = 15;
    let round: u32 = 1;

    // Every field the contribution authorization hash binds. Each signature is
    // valid for its own (wrong) hash, so reaching INVALID_SIGNATURE proves the
    // core recomputed the hash over the real helper/pool/token/amount and
    // rejected on the binding itself, not on an earlier generic guard.
    let wrong_values = array![
        contribution_settlement_authorization_hash(
            id, round, member_1(), addr(0x777), env.pool, env.usdc, AMOUNT, nonce,
        ),
        contribution_settlement_authorization_hash(
            id,
            round,
            member_1(),
            env.helper.contract_address,
            addr(0x778),
            env.usdc,
            AMOUNT,
            nonce,
        ),
        contribution_settlement_authorization_hash(
            id, round, member_1(), env.helper.contract_address, env.pool, env.strk, AMOUNT, nonce,
        ),
        contribution_settlement_authorization_hash(
            id,
            round,
            member_1(),
            env.helper.contract_address,
            env.pool,
            env.usdc,
            AMOUNT + 1,
            nonce,
        ),
    ];
    let labels = array![
        'wrong helper bind', 'wrong pool bind', 'wrong token bind', 'wrong amount bind',
    ];
    let mut i = 0;
    while i < wrong_values.len() {
        let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), *wrong_values.at(i)).unwrap();
        let s = canonical_s(raw_s);
        assert(
            invoke_fails(
                env,
                IwaOperation::SettleContribution,
                id,
                round,
                member_1(),
                env.usdc,
                0,
                nonce,
                r,
                s,
            ),
            *labels.at(i),
        );
        assert(
            invoke_reverts_with(
                env,
                IwaOperation::SettleContribution,
                id,
                round,
                member_1(),
                env.usdc,
                0,
                nonce,
                r,
                s,
                iwa_errors::INVALID_SIGNATURE,
            ),
            *labels.at(i),
        );
        i += 1;
    }

    // Correct hash, wrong signing key: member authorization is checked against
    // the member's registered auth key, not merely against hash well-formedness.
    let (r, s) = sign_contribution(env, id, round, member_1(), key(0x102), nonce);
    assert(
        invoke_fails(
            env, IwaOperation::SettleContribution, id, round, member_1(), env.usdc, 0, nonce, r, s,
        ),
        'wrong member key',
    );
    assert(
        invoke_reverts_with(
            env,
            IwaOperation::SettleContribution,
            id,
            round,
            member_1(),
            env.usdc,
            0,
            nonce,
            r,
            s,
            iwa_errors::INVALID_SIGNATURE,
        ),
        'wrong member key',
    );

    // Unknown token is rejected by the helper's own allowlist, before any core
    // call and before any liability is touched.
    assert(
        invoke_fails(
            env,
            IwaOperation::SettleContribution,
            id,
            round,
            member_1(),
            addr(0x999),
            0,
            nonce,
            r,
            s,
        ),
        'unsupported token',
    );
    assert(
        invoke_reverts_with(
            env,
            IwaOperation::SettleContribution,
            id,
            round,
            member_1(),
            addr(0x999),
            0,
            nonce,
            r,
            s,
            'UNSUPPORTED_TOKEN',
        ),
        'unsupported token',
    );

    // The circle is a USDC circle, so an allowlisted-but-wrong token must still
    // be refused. The helper reuses one constant for both the allowlist and the
    // circle/token binding, so this pins the reason, not which of the two fired.
    assert(
        invoke_reverts_with(
            env,
            IwaOperation::SettleContribution,
            id,
            round,
            member_1(),
            env.strk,
            0,
            nonce,
            r,
            s,
            'UNSUPPORTED_TOKEN',
        ),
        'wrong circle token',
    );

    // A fully valid authorization must still be refused when it does not enter
    // through the privacy pool, proving the pool guard precedes settlement.
    let (good_r, good_s) = sign_contribution(env, id, round, member_1(), key(0x101), nonce);
    assert(
        panic_contains(
            invoke_panic_data(
                env,
                addr(0xdead),
                IwaOperation::SettleContribution,
                id,
                round,
                member_1(),
                env.usdc,
                0,
                nonce,
                good_r,
                good_s,
            ),
            'NOT_PRIVACY_POOL',
        ),
        'pool only',
    );

    // Same valid authorization presented straight to the core, bypassing the
    // helper entirely: the helper-only guard, not the signature, must reject it.
    let mut core_data = array![];
    id.serialize(ref core_data);
    round.serialize(ref core_data);
    member_1().serialize(ref core_data);
    env.usdc.serialize(ref core_data);
    AMOUNT.serialize(ref core_data);
    nonce.serialize(ref core_data);
    good_r.serialize(ref core_data);
    good_s.serialize(ref core_data);
    assert(
        panic_contains(
            core_call_panic_data(
                env, selector!("settle_contribution_from_helper"), core_data.span(),
            ),
            iwa_errors::NOT_SETTLEMENT_HELPER,
        ),
        'helper only',
    );

    assert(env.helper.get_token_liability(env.usdc) == 0, 'no credit');
    assert(env.helper.get_round_token_liability(id, round, env.usdc) == 0, 'no round credit');
    assert(!env.core.is_contribution_nonce_consumed(id, member_1(), nonce), 'nonce free');
    assert(
        env
            .core
            .get_contribution_obligation(id, round, member_1())
            .status == ContributionStatus::Pending,
        'still pending',
    );
}

#[test]
fn payout_is_destination_bound_exact_and_replay_safe() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 20);
    contribute(env, id, 1, member_2(), key(0x102), 21);
    env.core.finalize_round_payout_accounting(id, 1);
    authorize_payout(env, id, 1, key(0x101), 22);
    let note = 0x999;
    let hash = payout_settlement_authorization_hash(
        id, 1, member_1(), env.helper.contract_address, env.pool, env.usdc, POT, note, 23,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    let s = canonical_s(raw_s);
    assert(
        invoke_fails(
            env, IwaOperation::SettlePayout, id, 1, member_1(), env.usdc, note + 1, 23, r, s,
        ),
        'note bound',
    );
    assert(
        invoke_fails(env, IwaOperation::SettlePayout, id, 1, member_2(), env.usdc, note, 23, r, s),
        'recipient fixed',
    );
    assert(
        invoke_fails(env, IwaOperation::SettlePayout, id, 1, member_1(), env.strk, note, 23, r, s),
        'token fixed',
    );
    assert(
        invoke_fails(env, IwaOperation::SettlePayout, id, 1, member_1(), env.usdc, 0, 23, r, s),
        'zero note',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == POT.into(), 'failure atomic');
    let output = invoke(
        env, IwaOperation::SettlePayout, id, 1, member_1(), env.usdc, note, 23, r, s,
    );
    assert(output.len() == 1, 'one note');
    let deposit = *output.at(0);
    assert(deposit.note_id == note, 'note');
    assert(deposit.token == env.usdc, 'token');
    assert(deposit.amount == POT, 'amount');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round debit');
    let erc20 = IERC20Dispatcher { contract_address: env.usdc };
    assert(
        erc20.allowance(owner: env.helper.contract_address, spender: env.pool) == POT.into(),
        'exact approval',
    );
    assert(
        erc20.allowance(owner: env.helper.contract_address, spender: addr(0xbeef)) == 0,
        'only pool',
    );
    assert(
        invoke_fails(env, IwaOperation::SettlePayout, id, 1, member_1(), env.usdc, note, 23, r, s),
        'replay',
    );
}

#[test]
fn payout_cannot_borrow_from_core_only_or_other_token_accounting() {
    let env = deploy_env();
    let id = activate(env);
    let (r1, s1) = sign_contribution(env, id, 1, member_1(), key(0x101), 25);
    let (r2, s2) = sign_contribution(env, id, 1, member_2(), key(0x102), 26);
    start_cheat_caller_address(env.core.contract_address, env.helper.contract_address);
    env.core.settle_contribution_from_helper(id, 1, member_1(), env.usdc, AMOUNT, 25, r1, s1);
    env.core.settle_contribution_from_helper(id, 1, member_2(), env.usdc, AMOUNT, 26, r2, s2);
    env.core.finalize_round_payout_accounting(id, 1);
    authorize_payout(env, id, 1, key(0x101), 27);
    mint(env, POT);
    let note = 0x998;
    let hash = payout_settlement_authorization_hash(
        id, 1, member_1(), env.helper.contract_address, env.pool, env.usdc, POT, note, 28,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    assert(
        invoke_fails(
            env,
            IwaOperation::SettlePayout,
            id,
            1,
            member_1(),
            env.usdc,
            note,
            28,
            r,
            canonical_s(raw_s),
        ),
        'helper ledger required',
    );
    assert(
        env.core.get_payout_state(id, 1).status == PayoutStatus::SettlementAuthorized,
        'core atomic',
    );
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'no cross source');
    assert(env.helper.get_round_token_liability(id, 1, env.strk) == 0, 'no cross token');
}

#[test]
fn recovery_uses_only_same_round_net_funded_amount() {
    let env = deploy_env();
    let id = activate(env);
    contribute(env, id, 1, member_1(), key(0x101), 30);
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    contribute(env, id, 2, member_1(), key(0x101), 31);
    contribute(env, id, 2, member_2(), key(0x102), 32);
    env.core.finalize_round_payout_accounting(id, 2);
    authorize_payout(env, id, 2, key(0x102), 33);
    env.core.prepare_final_settlement(id);
    assert(env.core.get_payout_state(id, 1).status == PayoutStatus::RecoveryPending, 'pending');
    assert(env.core.get_recovery_amount(id, 1) == AMOUNT, 'net');
    let note = 0xaaa;
    let hash = recovery_settlement_authorization_hash(
        id, 1, member_1(), env.helper.contract_address, env.pool, env.usdc, AMOUNT, note, 34,
    );
    let (r, raw_s) = StarkCurveSignerImpl::sign(key(0x101), hash).unwrap();
    let output = invoke(
        env,
        IwaOperation::SettleRecovery,
        id,
        1,
        member_1(),
        env.usdc,
        note,
        34,
        r,
        canonical_s(raw_s),
    );
    assert(output.len() == 1, 'one note');
    assert((*output.at(0)).amount == AMOUNT, 'recovery amount');
    assert(env.helper.get_round_token_liability(id, 1, env.usdc) == 0, 'round one');
    assert(env.helper.get_round_token_liability(id, 2, env.usdc) == POT.into(), 'no borrowing');
}

#[test]
fn no_funded_recovery_and_arbitrary_call_surface_are_rejected() {
    let env = deploy_env();
    let id = activate(env);
    default_member(env, id, 1, member_1());
    default_member(env, id, 1, member_2());
    env.core.finalize_round_payout_accounting(id, 1);
    contribute(env, id, 2, member_1(), key(0x101), 40);
    contribute(env, id, 2, member_2(), key(0x102), 41);
    env.core.finalize_round_payout_accounting(id, 2);
    authorize_payout(env, id, 2, key(0x102), 42);
    env.core.prepare_final_settlement(id);
    assert(
        env.core.get_payout_state(id, 1).status == PayoutStatus::NoFundedRecovery, 'zero terminal',
    );
    assert(
        invoke_fails(
            env, IwaOperation::SettleRecovery, id, 1, member_1(), env.usdc, 0xbbb, 43, 1, 1,
        ),
        'no zero settlement',
    );
    let mut data = array![];
    addr(0xdead).serialize(ref data);
    assert(
        call_contract_syscall(env.helper.contract_address, selector!("execute"), data.span())
            .is_err(),
        'no execute',
    );
    assert(
        call_contract_syscall(env.helper.contract_address, selector!("set_target"), data.span())
            .is_err(),
        'no target',
    );
}

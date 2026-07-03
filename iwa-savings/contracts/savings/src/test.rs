#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Bytes, BytesN, Env,
};

/// A member commitment is just a 32-byte value here. In the real flow it is a
/// hash commitment derived on the user's device, never a real identity. It is
/// separate from the payer's Stellar `Address` (Option A: the address is passed
/// in at call time, not bound to the commitment on chain).
fn member(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

/// Register a test Stellar asset (SAC) and return its contract address. This is
/// the token a circle moves. Minting and transfers rely on mocked auth.
fn setup_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    env.register_stellar_asset_contract_v2(admin).address()
}

/// Mint `amount` of the test token to `to`.
fn mint(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_addr).mint(to, &amount);
}

/// Read a token balance.
fn balance(env: &Env, token_addr: &Address, who: &Address) -> i128 {
    token::TokenClient::new(env, token_addr).balance(who)
}

// --- Trust-gated join test fixtures ---------------------------------------

/// A stub verifier: implements the same `verify_proof` seam as the real
/// deployed verifier, but always accepts, so join tests stay fast (no real
/// Groth16 crypto). Registered at the exact address join_circle cross-calls.
#[contract]
struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify_proof(_env: Env, _proof: Bytes, _public_signals: Vec<BytesN<32>>) -> bool {
        true
    }
}

/// Register the stub verifier at the hardcoded VERIFIER_CONTRACT_ID address so
/// join_circle's cross-contract call resolves to it in tests.
fn setup_mock_verifier(env: &Env) {
    let verifier_id = Address::from_str(env, VERIFIER_CONTRACT_ID);
    env.register_at(&verifier_id, MockVerifier, ());
}

/// A well-formed-shaped (but not cryptographically real) trust proof. Fine
/// here because MockVerifier ignores its contents and always accepts.
fn dummy_proof(env: &Env) -> TrustProof {
    TrustProof {
        proof: Bytes::from_array(env, &[0u8; 32]),
        public_signals: Vec::new(env),
    }
}

#[test]
fn create_and_get_circle() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &604_800u64, &3u32, &false);
    assert_eq!(cid, 0);

    let circle = client.get_circle(&cid);
    assert_eq!(circle.amount, 50);
    assert_eq!(circle.token, token_addr);
    assert!(!circle.trust_required);
    assert_eq!(circle.frequency, 604_800);
    assert_eq!(circle.size, 3);
    assert_eq!(circle.current_round, 1);
    assert_eq!(circle.members, 0);
    assert_eq!(circle.status, CircleStatus::Open);

    // The next circle gets the next id.
    let cid2 = client.create_circle(&token_addr, &10i128, &86_400u64, &2u32, &false);
    assert_eq!(cid2, 1);
}

#[test]
fn create_circle_rejects_bad_config() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    match client.try_create_circle(&token_addr, &0i128, &100u64, &3u32, &false) {
        Err(Ok(e)) => assert_eq!(e, Error::InvalidConfig.into()),
        _ => panic!("expected InvalidConfig for amount 0"),
    }
    match client.try_create_circle(&token_addr, &50i128, &100u64, &1u32, &false) {
        Err(Ok(e)) => assert_eq!(e, Error::InvalidConfig.into()),
        _ => panic!("expected InvalidConfig for size 1"),
    }
}

#[test]
fn join_assigns_slots_prevents_dupes_and_full() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &604_800u64, &3u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    let m3 = member(&env, 3);
    let m4 = member(&env, 4);

    assert_eq!(
        client.join_circle(&cid, &m1, &None),
        JoinResult { ok: true, slot: 0 }
    );
    assert_eq!(
        client.join_circle(&cid, &m2, &None),
        JoinResult { ok: true, slot: 1 }
    );
    assert_eq!(
        client.join_circle(&cid, &m3, &None),
        JoinResult { ok: true, slot: 2 }
    );

    let circle = client.get_circle(&cid);
    assert_eq!(circle.members, 3);
    assert_eq!(circle.status, CircleStatus::Active); // full circle is active

    // Duplicate member is rejected.
    match client.try_join_circle(&cid, &m1, &None) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyMember.into()),
        _ => panic!("expected AlreadyMember"),
    }
    // Joining a full circle is rejected.
    match client.try_join_circle(&cid, &m4, &None) {
        Err(Ok(e)) => assert_eq!(e, Error::CircleFull.into()),
        _ => panic!("expected CircleFull"),
    }
}

#[test]
fn join_requires_trust_proof_when_required() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);
    setup_mock_verifier(&env);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &604_800u64, &3u32, &true);
    assert!(client.get_circle(&cid).trust_required);

    let m1 = member(&env, 1);
    let m2 = member(&env, 2);

    // No proof at all: rejected before any cross-call.
    match client.try_join_circle(&cid, &m1, &None) {
        Err(Ok(e)) => assert_eq!(e, Error::TrustProofRequired.into()),
        _ => panic!("expected TrustProofRequired"),
    }
    assert_eq!(client.get_circle(&cid).members, 0); // nothing joined

    // A valid proof (accepted by the stub verifier) lets the join succeed.
    let proof = dummy_proof(&env);
    let joined = client.join_circle(&cid, &m1, &Some(proof));
    assert_eq!(joined, JoinResult { ok: true, slot: 0 });
    assert_eq!(client.get_circle(&cid).members, 1);

    // A trust-required circle with no proof still blocks a second member.
    match client.try_join_circle(&cid, &m2, &None) {
        Err(Ok(e)) => assert_eq!(e, Error::TrustProofRequired.into()),
        _ => panic!("expected TrustProofRequired"),
    }
}

#[test]
fn pay_contribution_on_time_and_late() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint(&env, &token_addr, &p1, 1_000);
    mint(&env, &token_addr, &p2, 1_000);

    // Round length 1000s. Circle is created at timestamp 0, so the round 1
    // deadline is 1000.
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &2u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1, &None);
    client.join_circle(&cid, &m2, &None);

    // On time: before the deadline. The payment moves the token into the pot.
    env.ledger().set_timestamp(500);
    let r1 = client.pay_contribution(&cid, &1u32, &m1, &p1);
    assert!(r1.ok);
    assert!(r1.on_time);
    assert_eq!(balance(&env, &token_addr, &p1), 950); // paid 50
    assert_eq!(balance(&env, &token_addr, &id), 50); // contract holds it

    // Late: after the deadline.
    env.ledger().set_timestamp(1_500);
    let r2 = client.pay_contribution(&cid, &1u32, &m2, &p2);
    assert!(r2.ok);
    assert!(!r2.on_time);
    assert_eq!(balance(&env, &token_addr, &id), 100); // both contributions in

    // Paying twice in the same round is rejected (before any transfer).
    match client.try_pay_contribution(&cid, &1u32, &m1, &p1) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyPaid.into()),
        _ => panic!("expected AlreadyPaid"),
    }
    // A non-member cannot pay (rejected before require_auth / transfer).
    let stranger = member(&env, 9);
    let stranger_payer = Address::generate(&env);
    match client.try_pay_contribution(&cid, &1u32, &stranger, &stranger_payer) {
        Err(Ok(e)) => assert_eq!(e, Error::NotMember.into()),
        _ => panic!("expected NotMember"),
    }
    // Paying a round that is not current is rejected.
    match client.try_pay_contribution(&cid, &2u32, &m1, &p1) {
        Err(Ok(e)) => assert_eq!(e, Error::WrongRound.into()),
        _ => panic!("expected WrongRound"),
    }
}

#[test]
fn advance_collect_and_prevent_double_collect() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint(&env, &token_addr, &p1, 1_000);
    mint(&env, &token_addr, &p2, 1_000);

    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &2u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1, &None); // slot 0
    client.join_circle(&cid, &m2, &None); // slot 1

    // Round 1: every member must fund the round before the pot is collectable.
    client.pay_contribution(&cid, &1u32, &m1, &p1);
    client.pay_contribution(&cid, &1u32, &m2, &p2);
    assert_eq!(balance(&env, &token_addr, &id), 100); // full pot held

    // Round 1 collector is slot 0 (m1). Pot is amount * size = 50 * 2 = 100.
    let p1_before = balance(&env, &token_addr, &p1);
    let c1 = client.collect_pot(&cid, &m1, &p1);
    assert!(c1.ok);
    assert_eq!(c1.amount, 100);
    // The pot actually moved: p1 received 100, the contract is emptied.
    assert_eq!(balance(&env, &token_addr, &p1), p1_before + 100);
    assert_eq!(balance(&env, &token_addr, &id), 0);

    // The same member cannot collect twice (nullifier guard).
    match client.try_collect_pot(&cid, &m1, &p1) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyCollected.into()),
        _ => panic!("expected AlreadyCollected"),
    }
    // A member who is not this round's collector cannot collect.
    match client.try_collect_pot(&cid, &m2, &p2) {
        Err(Ok(e)) => assert_eq!(e, Error::NotCollector.into()),
        _ => panic!("expected NotCollector"),
    }

    // Advance to round 2: the collector becomes slot 1 (m2).
    let adv = client.advance_round(&cid);
    assert!(adv.ok);
    assert_eq!(adv.new_round, 2);
    assert_eq!(adv.collector, m2);
    assert_eq!(client.get_circle(&cid).current_round, 2);

    // Round 2 must be funded by everyone before m2 can collect.
    client.pay_contribution(&cid, &2u32, &m1, &p1);
    client.pay_contribution(&cid, &2u32, &m2, &p2);

    let c2 = client.collect_pot(&cid, &m2, &p2);
    assert_eq!(c2.amount, 100);

    // m2 cannot collect twice either.
    match client.try_collect_pot(&cid, &m2, &p2) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyCollected.into()),
        _ => panic!("expected AlreadyCollected"),
    }

    // Advancing past the last slot completes the circle.
    let adv2 = client.advance_round(&cid);
    assert_eq!(adv2.new_round, 3);
    assert_eq!(client.get_circle(&cid).status, CircleStatus::Completed);
}

#[test]
fn collect_requires_full_funding() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint(&env, &token_addr, &p1, 1_000);
    mint(&env, &token_addr, &p2, 1_000);

    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &2u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1, &None); // slot 0, round 1 collector
    client.join_circle(&cid, &m2, &None); // slot 1

    // Only the collector has paid; m2 has not funded round 1.
    client.pay_contribution(&cid, &1u32, &m1, &p1);

    // Collection is blocked until the whole round is funded.
    match client.try_collect_pot(&cid, &m1, &p1) {
        Err(Ok(e)) => assert_eq!(e, Error::RoundNotFunded.into()),
        _ => panic!("expected RoundNotFunded"),
    }
    // Nothing left the contract.
    assert_eq!(balance(&env, &token_addr, &id), 50);

    // Once m2 funds the round too, collection succeeds and the pot moves.
    client.pay_contribution(&cid, &1u32, &m2, &p2);
    let p1_before = balance(&env, &token_addr, &p1);
    let c = client.collect_pot(&cid, &m1, &p1);
    assert!(c.ok);
    assert_eq!(c.amount, 100);
    assert_eq!(balance(&env, &token_addr, &p1), p1_before + 100);
    assert_eq!(balance(&env, &token_addr, &id), 0);
}

#[test]
fn seed_and_read_contribution_history() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &2u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1, &None);
    client.join_circle(&cid, &m2, &None);

    // Seed a history: m1 on time in rounds 1 and 2, m2 late in round 1. Seeding
    // bypasses the token movement on purpose (demo seam), so no funds needed.
    client.seed_contribution(&cid, &1u32, &m1, &true);
    client.seed_contribution(&cid, &2u32, &m1, &true);
    client.seed_contribution(&cid, &1u32, &m2, &false);

    let c_m1_r1 = client.get_contribution(&cid, &1u32, &m1).unwrap();
    assert!(c_m1_r1.on_time);
    assert_eq!(c_m1_r1.round, 1);

    let c_m2_r1 = client.get_contribution(&cid, &1u32, &m2).unwrap();
    assert!(!c_m2_r1.on_time);

    // A record that was never written reads back as None.
    assert!(client.get_contribution(&cid, &2u32, &m2).is_none());
}

#[test]
fn get_circle_not_found() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    match client.try_get_circle(&999u32) {
        Err(Ok(e)) => assert_eq!(e, Error::CircleNotFound.into()),
        _ => panic!("expected CircleNotFound"),
    }
}

#[test]
fn reputation_perfect_member() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &3u32, &false);
    let m = member(&env, 1);
    // Contributed in all three rounds, every one on time.
    client.seed_contribution(&cid, &1u32, &m, &true);
    client.seed_contribution(&cid, &2u32, &m, &true);
    client.seed_contribution(&cid, &3u32, &m, &true);

    let rep = client.get_reputation(&cid, &m);
    assert_eq!(
        rep,
        Reputation {
            completed_cycles: 3,
            on_time_count: 3,
            default_count: 0,
        }
    );
}

#[test]
fn reputation_one_late_payment() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &3u32, &false);
    let m = member(&env, 2);
    client.seed_contribution(&cid, &1u32, &m, &true);
    client.seed_contribution(&cid, &2u32, &m, &false); // late
    client.seed_contribution(&cid, &3u32, &m, &true);

    let rep = client.get_reputation(&cid, &m);
    // Contributed in all three rounds, but one was late, so one default.
    assert_eq!(rep.completed_cycles, 3);
    assert_eq!(rep.on_time_count, 2);
    assert_eq!(rep.default_count, 1);
}

#[test]
fn reputation_missed_a_round() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &3u32, &false);
    let m = member(&env, 3);
    // Paid rounds 1 and 3 on time, missed round 2 entirely (no record).
    client.seed_contribution(&cid, &1u32, &m, &true);
    client.seed_contribution(&cid, &3u32, &m, &true);

    let rep = client.get_reputation(&cid, &m);
    assert_eq!(rep.completed_cycles, 2); // two rounds contributed
    assert_eq!(rep.on_time_count, 2);
    assert_eq!(rep.default_count, 1); // the missed round counts as a default
}

#[test]
fn reputation_no_history_is_all_zeros() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &3u32, &false);
    let m = member(&env, 7);

    let rep = client.get_reputation(&cid, &m);
    assert_eq!(
        rep,
        Reputation {
            completed_cycles: 0,
            on_time_count: 0,
            default_count: 0,
        }
    );
}

#[test]
fn reputation_derives_from_real_payments() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let token_addr = setup_token(&env);
    let p1 = Address::generate(&env);
    mint(&env, &token_addr, &p1, 1_000);

    // Reputation reads the same records that pay_contribution writes, not only
    // seeded ones. Round length 1000, so the round 1 deadline is 1000.
    let cid = client.create_circle(&token_addr, &50i128, &1_000u64, &2u32, &false);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1, &None);
    client.join_circle(&cid, &m2, &None);

    env.ledger().set_timestamp(500);
    client.pay_contribution(&cid, &1u32, &m1, &p1); // on time

    let rep = client.get_reputation(&cid, &m1);
    assert_eq!(rep.completed_cycles, 1);
    assert_eq!(rep.on_time_count, 1);
    assert_eq!(rep.default_count, 0);
}

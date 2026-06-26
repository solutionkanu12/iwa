#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Ledger, BytesN, Env};

/// A member commitment is just a 32-byte value here. In the real flow it is a
/// hash commitment derived on the user's device, never a real identity.
fn member(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn create_and_get_circle() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let cid = client.create_circle(&50i128, &604_800u64, &3u32);
    assert_eq!(cid, 0);

    let circle = client.get_circle(&cid);
    assert_eq!(circle.amount, 50);
    assert_eq!(circle.frequency, 604_800);
    assert_eq!(circle.size, 3);
    assert_eq!(circle.current_round, 1);
    assert_eq!(circle.members, 0);
    assert_eq!(circle.status, CircleStatus::Open);

    // The next circle gets the next id.
    let cid2 = client.create_circle(&10i128, &86_400u64, &2u32);
    assert_eq!(cid2, 1);
}

#[test]
fn create_circle_rejects_bad_config() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    match client.try_create_circle(&0i128, &100u64, &3u32) {
        Err(Ok(e)) => assert_eq!(e, Error::InvalidConfig.into()),
        _ => panic!("expected InvalidConfig for amount 0"),
    }
    match client.try_create_circle(&50i128, &100u64, &1u32) {
        Err(Ok(e)) => assert_eq!(e, Error::InvalidConfig.into()),
        _ => panic!("expected InvalidConfig for size 1"),
    }
}

#[test]
fn join_assigns_slots_prevents_dupes_and_full() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let cid = client.create_circle(&50i128, &604_800u64, &3u32);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    let m3 = member(&env, 3);
    let m4 = member(&env, 4);

    assert_eq!(
        client.join_circle(&cid, &m1),
        JoinResult { ok: true, slot: 0 }
    );
    assert_eq!(
        client.join_circle(&cid, &m2),
        JoinResult { ok: true, slot: 1 }
    );
    assert_eq!(
        client.join_circle(&cid, &m3),
        JoinResult { ok: true, slot: 2 }
    );

    let circle = client.get_circle(&cid);
    assert_eq!(circle.members, 3);
    assert_eq!(circle.status, CircleStatus::Active); // full circle is active

    // Duplicate member is rejected.
    match client.try_join_circle(&cid, &m1) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyMember.into()),
        _ => panic!("expected AlreadyMember"),
    }
    // Joining a full circle is rejected.
    match client.try_join_circle(&cid, &m4) {
        Err(Ok(e)) => assert_eq!(e, Error::CircleFull.into()),
        _ => panic!("expected CircleFull"),
    }
}

#[test]
fn pay_contribution_on_time_and_late() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    // Round length 1000s. Circle is created at timestamp 0, so the round 1
    // deadline is 1000.
    let cid = client.create_circle(&50i128, &1_000u64, &2u32);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1);
    client.join_circle(&cid, &m2);

    // On time: before the deadline.
    env.ledger().set_timestamp(500);
    let r1 = client.pay_contribution(&cid, &1u32, &m1);
    assert!(r1.ok);
    assert!(r1.on_time);

    // Late: after the deadline.
    env.ledger().set_timestamp(1_500);
    let r2 = client.pay_contribution(&cid, &1u32, &m2);
    assert!(r2.ok);
    assert!(!r2.on_time);

    // Paying twice in the same round is rejected.
    match client.try_pay_contribution(&cid, &1u32, &m1) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyPaid.into()),
        _ => panic!("expected AlreadyPaid"),
    }
    // A non-member cannot pay.
    let stranger = member(&env, 9);
    match client.try_pay_contribution(&cid, &1u32, &stranger) {
        Err(Ok(e)) => assert_eq!(e, Error::NotMember.into()),
        _ => panic!("expected NotMember"),
    }
    // Paying a round that is not current is rejected.
    match client.try_pay_contribution(&cid, &2u32, &m1) {
        Err(Ok(e)) => assert_eq!(e, Error::WrongRound.into()),
        _ => panic!("expected WrongRound"),
    }
}

#[test]
fn advance_collect_and_prevent_double_collect() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let cid = client.create_circle(&50i128, &1_000u64, &2u32);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1); // slot 0
    client.join_circle(&cid, &m2); // slot 1

    // Round 1 collector is slot 0 (m1). Pot is amount * size = 50 * 2 = 100.
    let c1 = client.collect_pot(&cid, &m1);
    assert!(c1.ok);
    assert_eq!(c1.amount, 100);

    // The same member cannot collect twice (nullifier guard).
    match client.try_collect_pot(&cid, &m1) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyCollected.into()),
        _ => panic!("expected AlreadyCollected"),
    }
    // A member who is not this round's collector cannot collect.
    match client.try_collect_pot(&cid, &m2) {
        Err(Ok(e)) => assert_eq!(e, Error::NotCollector.into()),
        _ => panic!("expected NotCollector"),
    }

    // Advance to round 2: the collector becomes slot 1 (m2).
    let adv = client.advance_round(&cid);
    assert!(adv.ok);
    assert_eq!(adv.new_round, 2);
    assert_eq!(adv.collector, m2);
    assert_eq!(client.get_circle(&cid).current_round, 2);

    let c2 = client.collect_pot(&cid, &m2);
    assert_eq!(c2.amount, 100);

    // m2 cannot collect twice either.
    match client.try_collect_pot(&cid, &m2) {
        Err(Ok(e)) => assert_eq!(e, Error::AlreadyCollected.into()),
        _ => panic!("expected AlreadyCollected"),
    }

    // Advancing past the last slot completes the circle.
    let adv2 = client.advance_round(&cid);
    assert_eq!(adv2.new_round, 3);
    assert_eq!(client.get_circle(&cid).status, CircleStatus::Completed);
}

#[test]
fn seed_and_read_contribution_history() {
    let env = Env::default();
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    let cid = client.create_circle(&50i128, &1_000u64, &2u32);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1);
    client.join_circle(&cid, &m2);

    // Seed a history: m1 on time in rounds 1 and 2, m2 late in round 1.
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

    let cid = client.create_circle(&50i128, &1_000u64, &3u32);
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

    let cid = client.create_circle(&50i128, &1_000u64, &3u32);
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

    let cid = client.create_circle(&50i128, &1_000u64, &3u32);
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

    let cid = client.create_circle(&50i128, &1_000u64, &3u32);
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
    let id = env.register(SavingsContract, ());
    let client = SavingsContractClient::new(&env, &id);

    // Reputation reads the same records that pay_contribution writes, not only
    // seeded ones. Round length 1000, so the round 1 deadline is 1000.
    let cid = client.create_circle(&50i128, &1_000u64, &2u32);
    let m1 = member(&env, 1);
    let m2 = member(&env, 2);
    client.join_circle(&cid, &m1);
    client.join_circle(&cid, &m2);

    env.ledger().set_timestamp(500);
    client.pay_contribution(&cid, &1u32, &m1); // on time

    let rep = client.get_reputation(&cid, &m1);
    assert_eq!(rep.completed_cycles, 1);
    assert_eq!(rep.on_time_count, 1);
    assert_eq!(rep.default_count, 0);
}

#![no_std]
//! Iwa savings contract: the plain ajo (rotating savings circle) plumbing.
//!
//! No zero-knowledge here. This contract runs the circle: create, join,
//! contribute, advance the round, and collect the pot. Members are represented
//! only by a 32-byte commitment, never a real identity. Contribution history is
//! seed-able so the demo has reputation history without living through real
//! rounds before the deadline.
//!
//! Note on `tx` / transaction hashes: a Soroban contract cannot know its own
//! transaction hash (the network assigns it after submission), so result types
//! return the on-chain `ledger` sequence instead. The `txHash` string the
//! frontend seam (`lib/iwaContract.ts`) exposes is attached by the wiring layer
//! from the submit response, not by this contract.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, BytesN, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    CircleNotFound = 1,
    InvalidConfig = 2,
    CircleFull = 3,
    AlreadyMember = 4,
    NotMember = 5,
    AlreadyPaid = 6,
    WrongRound = 7,
    NotCollector = 8,
    AlreadyCollected = 9,
    NoMembers = 10,
}

/// Lifecycle of a circle. `Open` while it is still filling, `Active` once full,
/// `Completed` once every member has had a turn to collect.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CircleStatus {
    Open,
    Active,
    Completed,
}

/// Circle configuration and live state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Circle {
    pub id: u32,
    /// Contribution amount due from each member per round.
    pub amount: i128,
    /// Length of one round in seconds. Used to decide if a payment is on time.
    pub frequency: u64,
    /// Number of member slots in the circle.
    pub size: u32,
    /// Current round, starting at 1.
    pub current_round: u32,
    pub status: CircleStatus,
    /// How many members have joined so far.
    pub members: u32,
    /// Ledger timestamp at which the current round started (the on-time clock).
    pub round_start: u64,
}

/// A single contribution record, keyed on chain by (circle, round, member).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Contribution {
    pub member: BytesN<32>,
    pub round: u32,
    pub on_time: bool,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JoinResult {
    pub ok: bool,
    pub slot: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayResult {
    pub ok: bool,
    pub on_time: bool,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceResult {
    pub ok: bool,
    pub new_round: u32,
    pub collector: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectResult {
    pub ok: bool,
    pub amount: i128,
    pub ledger: u32,
}

/// A member's reputation, derived from contribution records. Never stored, only
/// computed, so it can never drift from the records it is built from. These are
/// the three numbers the reputation circuit will later prove over.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reputation {
    /// Rounds the member contributed in (on time or late).
    pub completed_cycles: u32,
    /// Contributions that were on time.
    pub on_time_count: u32,
    /// Rounds the member paid late or missed entirely.
    pub default_count: u32,
}

/// On-chain storage keys. None of these reference a real identity.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Next circle id to assign.
    Count,
    /// Circle config + state by id.
    Circle(u32),
    /// Vec<BytesN<32>> of membership commitments, index == slot.
    Members(u32),
    /// Contribution record by (circle_id, round, member_commitment).
    Contribution(u32, u32, BytesN<32>),
    /// Nullifier: this member has already collected their pot in this circle.
    Collected(u32, BytesN<32>),
}

fn load_circle(env: &Env, id: u32) -> Circle {
    match env.storage().persistent().get(&DataKey::Circle(id)) {
        Some(c) => c,
        None => panic_with_error!(env, Error::CircleNotFound),
    }
}

fn load_members(env: &Env, id: u32) -> Vec<BytesN<32>> {
    match env.storage().persistent().get(&DataKey::Members(id)) {
        Some(m) => m,
        None => panic_with_error!(env, Error::CircleNotFound),
    }
}

/// Return the slot index of a member commitment, if present.
fn slot_of(members: &Vec<BytesN<32>>, m: &BytesN<32>) -> Option<u32> {
    let len = members.len();
    let mut i = 0u32;
    while i < len {
        if members.get(i).unwrap() == *m {
            return Some(i);
        }
        i += 1;
    }
    None
}

#[contract]
pub struct SavingsContract;

#[contractimpl]
impl SavingsContract {
    /// Create a circle. Returns the new circle id.
    pub fn create_circle(env: Env, amount: i128, frequency: u64, size: u32) -> u32 {
        if amount <= 0 || size < 2 || frequency == 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }

        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let id = count;

        let circle = Circle {
            id,
            amount,
            frequency,
            size,
            current_round: 1,
            status: CircleStatus::Open,
            members: 0,
            round_start: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Circle(id), &circle);
        env.storage()
            .persistent()
            .set(&DataKey::Members(id), &Vec::<BytesN<32>>::new(&env));
        env.storage().instance().set(&DataKey::Count, &(count + 1));

        id
    }

    /// Join a circle. Assigns the next free slot to the member commitment.
    pub fn join_circle(env: Env, circle_id: u32, member_commitment: BytesN<32>) -> JoinResult {
        let mut circle = load_circle(&env, circle_id);
        let mut members = load_members(&env, circle_id);

        // Check duplicate before fullness so an existing member re-joining a
        // full circle gets AlreadyMember (the precise reason) rather than
        // CircleFull. A genuinely new member on a full circle still hits
        // CircleFull.
        if slot_of(&members, &member_commitment).is_some() {
            panic_with_error!(&env, Error::AlreadyMember);
        }
        if members.len() >= circle.size {
            panic_with_error!(&env, Error::CircleFull);
        }

        let slot = members.len();
        members.push_back(member_commitment);
        circle.members = members.len();
        if circle.members == circle.size {
            circle.status = CircleStatus::Active;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Members(circle_id), &members);
        env.storage()
            .persistent()
            .set(&DataKey::Circle(circle_id), &circle);

        JoinResult { ok: true, slot }
    }

    /// Record a member's contribution for the current round. Marks it on time if
    /// it lands before `round_start + frequency`.
    pub fn pay_contribution(
        env: Env,
        circle_id: u32,
        round: u32,
        member_commitment: BytesN<32>,
    ) -> PayResult {
        let circle = load_circle(&env, circle_id);
        let members = load_members(&env, circle_id);

        if slot_of(&members, &member_commitment).is_none() {
            panic_with_error!(&env, Error::NotMember);
        }
        if round != circle.current_round {
            panic_with_error!(&env, Error::WrongRound);
        }

        let key = DataKey::Contribution(circle_id, round, member_commitment.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyPaid);
        }

        let now = env.ledger().timestamp();
        let deadline = circle.round_start + circle.frequency;
        let on_time = now <= deadline;
        let ledger = env.ledger().sequence();

        let contribution = Contribution {
            member: member_commitment,
            round,
            on_time,
            ledger,
        };
        env.storage().persistent().set(&key, &contribution);

        PayResult {
            ok: true,
            on_time,
            ledger,
        }
    }

    /// Advance to the next round and return who may collect the pot this round.
    /// The collector for round r is the member in slot (r - 1) mod members.
    pub fn advance_round(env: Env, circle_id: u32) -> AdvanceResult {
        let mut circle = load_circle(&env, circle_id);
        let members = load_members(&env, circle_id);

        if members.len() == 0 {
            panic_with_error!(&env, Error::NoMembers);
        }

        let new_round = circle.current_round + 1;
        circle.current_round = new_round;
        circle.round_start = env.ledger().timestamp();
        if new_round > circle.size {
            circle.status = CircleStatus::Completed;
        }

        let idx = (new_round - 1) % members.len();
        let collector = members.get(idx).unwrap();

        env.storage()
            .persistent()
            .set(&DataKey::Circle(circle_id), &circle);

        AdvanceResult {
            ok: true,
            new_round,
            collector,
        }
    }

    /// Collect the pot for the current round. Only the current round's collector
    /// may call this, and only once per circle (nullifier guard).
    pub fn collect_pot(env: Env, circle_id: u32, member_commitment: BytesN<32>) -> CollectResult {
        let circle = load_circle(&env, circle_id);
        let members = load_members(&env, circle_id);

        if members.len() == 0 {
            panic_with_error!(&env, Error::NoMembers);
        }
        if slot_of(&members, &member_commitment).is_none() {
            panic_with_error!(&env, Error::NotMember);
        }

        let idx = (circle.current_round - 1) % members.len();
        let collector = members.get(idx).unwrap();
        if collector != member_commitment {
            panic_with_error!(&env, Error::NotCollector);
        }

        let nullifier = DataKey::Collected(circle_id, member_commitment);
        if env.storage().persistent().has(&nullifier) {
            panic_with_error!(&env, Error::AlreadyCollected);
        }
        env.storage().persistent().set(&nullifier, &true);

        let amount = circle.amount * (circle.size as i128);
        let ledger = env.ledger().sequence();

        CollectResult {
            ok: true,
            amount,
            ledger,
        }
    }

    /// Read a circle's config and state.
    pub fn get_circle(env: Env, circle_id: u32) -> Circle {
        load_circle(&env, circle_id)
    }

    /// Read a circle's membership commitments in slot order.
    pub fn get_members(env: Env, circle_id: u32) -> Vec<BytesN<32>> {
        load_members(&env, circle_id)
    }

    /// Read a single contribution record, if it exists.
    pub fn get_contribution(
        env: Env,
        circle_id: u32,
        round: u32,
        member_commitment: BytesN<32>,
    ) -> Option<Contribution> {
        env.storage()
            .persistent()
            .get(&DataKey::Contribution(circle_id, round, member_commitment))
    }

    /// Derive a member's reputation from their stored contribution records.
    ///
    /// Nothing here is stored separately. The numbers are computed from the same
    /// `Contribution` records `get_contribution` exposes, so they can never drift
    /// out of sync. Evaluated over rounds `1..=through`, where `through` is the
    /// highest round the member has a record for. A round inside that span with
    /// no record counts as a miss; a record with `on_time == false` counts as a
    /// late payment. Both feed `default_count`.
    pub fn get_reputation(
        env: Env,
        circle_id: u32,
        member_commitment: BytesN<32>,
    ) -> Reputation {
        let circle = load_circle(&env, circle_id);

        // Bound the scan by the full cycle length (a cycle is `size` rounds) or
        // how far the circle has advanced, whichever is larger.
        let cap = if circle.size > circle.current_round {
            circle.size
        } else {
            circle.current_round
        };

        let mut on_time_count: u32 = 0;
        let mut late_count: u32 = 0;
        let mut through: u32 = 0; // highest round the member has a record for

        let mut r: u32 = 1;
        while r <= cap {
            let key = DataKey::Contribution(circle_id, r, member_commitment.clone());
            if let Some(c) = env
                .storage()
                .persistent()
                .get::<DataKey, Contribution>(&key)
            {
                if c.on_time {
                    on_time_count += 1;
                } else {
                    late_count += 1;
                }
                through = r;
            }
            r += 1;
        }

        let paid = on_time_count + late_count;
        let missed = through - paid; // rounds in 1..=through with no record
        let default_count = late_count + missed;

        Reputation {
            completed_cycles: paid,
            on_time_count,
            default_count,
        }
    }

    /// DEMO ONLY. Write a historical contribution record directly so reputation
    /// history exists without living through real rounds before the deadline.
    /// This bypasses round and time checks on purpose and is disclosed as a
    /// demo seam, not production behaviour.
    pub fn seed_contribution(
        env: Env,
        circle_id: u32,
        round: u32,
        member_commitment: BytesN<32>,
        on_time: bool,
    ) {
        let _ = load_circle(&env, circle_id); // ensure the circle exists
        let ledger = env.ledger().sequence();
        let contribution = Contribution {
            member: member_commitment.clone(),
            round,
            on_time,
            ledger,
        };
        env.storage().persistent().set(
            &DataKey::Contribution(circle_id, round, member_commitment),
            &contribution,
        );
    }
}

mod test;

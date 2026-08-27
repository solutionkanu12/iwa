# IWA — Legacy Business Behavior (Extraction Record)

## Purpose

This document records the business behavior actually observed in the legacy
Stellar/Soroban IWA implementation, before it is replaced by the chain-neutral
IWA Core and the Starknet/Cairo implementation.

It exists so that:

- useful business semantics are not lost during the migration
- every major legacy behavior receives an explicit `KEEP` / `CHANGE` / `REMOVE`
  decision with a reason
- the new chain-neutral specification can be written from verified repository
  evidence, not memory

## Method and ground rules

- Every behavior below cites the exact source file and line range it was
  observed from.
- `OBSERVED` means the behavior is directly visible in the cited source
  (code path, comment, or test assertion).
- Anything that cannot be proven from the repository is labeled `UNKNOWN` and
  listed in section 6.
- Nothing in this document describes the Starknet implementation as existing;
  the Starknet implementation has not been written yet.

## Legend

| Label | Meaning |
|---|---|
| `KEEP` | preserve the behavior in the chain-neutral domain / Starknet implementation |
| `CHANGE` | keep the intent but alter the rule (approved new behavior listed) |
| `REMOVE` | drop from the new implementation |
| `HOLD` | preserve the legacy artifact, decide later (research-dependent) |

---

## 1. Legacy surface inventory

### 1.1 Components

| Component | Path | Role in the legacy product |
|---|---|---|
| Savings contract | `iwa-savings/contracts/savings/src/lib.rs` | Soroban contract running circle lifecycle: create, join, contribute, advance, collect, reputation |
| Savings tests | `iwa-savings/contracts/savings/src/test.rs` | Behavioral specification of the contract (all observed behavior is asserted here) |
| Reputation circuit | `iwa-circuit/reputation.circom` | Circom/Groth16 (BN254) circuit proving `completed >= threshold` and `default_count == 0` |
| Circuit input generator | `iwa-circuit/gen_input.js` | Builds passing/failing witnesses for the circuit |
| On-device prover | `iwa-prover/src/lib.rs`, `iwa-prover/js/zk.js` | arkworks/snarkjs witness + Groth16 proof entirely on-device; secret never leaves the device |
| On-chain verifier | `iwa-verifier/contracts/verifier/src/lib.rs` | Soroban Groth16 pairing-check verifier; `verify_proof(proof, public_signals) -> bool` |
| Frontend contract seam | `iwa-web/src/lib/iwaContract.ts` | Sole UI-to-Soroban seam; used here as read-only evidence of how the product consumed the contracts |
| Frontend ZK seam | `iwa-web/src/lib/zk.ts` | On-device proof generation used by the "prove" flow and trust-gated join |
| Frontend claim list | `iwa-web/src/screens/ProveView.tsx` | The two prototype claims a saver could prove |

### 1.2 Contract entry points (`iwa-savings/contracts/savings/src/lib.rs`)

| Entry point | Args | Returns | Source |
|---|---|---|---|
| `create_circle` | `token, amount, frequency, size, trust_required` | `u32` circle id | `lib.rs:208-243` |
| `join_circle` | `circle_id, member_commitment, trust_proof: Option<TrustProof>` | `JoinResult { ok, slot }` | `lib.rs:248-298` |
| `pay_contribution` | `circle_id, round, member_commitment, from` | `PayResult { ok, on_time, ledger }` | `lib.rs:302-349` |
| `advance_round` | `circle_id` | `AdvanceResult { ok, new_round, collector }` | `lib.rs:353-380` |
| `collect_pot` | `circle_id, member_commitment, to` | `CollectResult { ok, amount, ledger }` | `lib.rs:384-440` |
| `get_circle` | `circle_id` | `Circle` | `lib.rs:443-445` |
| `get_members` | `circle_id` | `Vec<BytesN<32>>` | `lib.rs:448-450` |
| `get_contribution` | `circle_id, round, member_commitment` | `Option<Contribution>` | `lib.rs:453-462` |
| `get_reputation` | `circle_id, member_commitment` | `Reputation` | `lib.rs:472-518` |
| `seed_contribution` | `circle_id, round, member_commitment, on_time` | `()` | `lib.rs:524-543` (demo only) |

### 1.3 Storage layout (`lib.rs:159-172`)

```text
Count                    -> u32                next circle id (instance storage)
Circle(u32)              -> Circle             circle config + state
Members(u32)             -> Vec<BytesN<32>>    membership commitments, index == slot
Contribution(u32, u32, BytesN<32>)             -> Contribution  (circle, round, member)
Collected(u32, BytesN<32>)                     -> bool          nullifier: member collected this circle
```

No identity data is ever stored. Only 32-byte commitments are on chain
(`lib.rs:6-7`, `lib.rs:158`).

### 1.4 Error catalog (`lib.rs:26-45`)

| Code | Name | Meaning |
|---|---|---|
| 1 | `CircleNotFound` | circle id does not exist |
| 2 | `InvalidConfig` | `amount <= 0`, `size < 2`, or `frequency == 0` at creation |
| 3 | `CircleFull` | all member slots taken |
| 4 | `AlreadyMember` | commitment already joined |
| 5 | `NotMember` | commitment not a member |
| 6 | `AlreadyPaid` | contribution already recorded for (circle, round, member) |
| 7 | `WrongRound` | `round != current_round` |
| 8 | `NotCollector` | caller is not this round's scheduled collector |
| 9 | `AlreadyCollected` | member already collected a pot in this circle (nullifier) |
| 10 | `NoMembers` | advance/collect with zero members |
| 11 | `RoundNotFunded` | not every member has contributed for the current round |
| 12 | `TrustProofRequired` | trust-required circle joined without a proof |
| 13 | `InvalidTrustProof` | supplied proof failed on-chain verification |

---

## 2. Behaviors

### 2.1 Circle creation

Source:
`iwa-savings/contracts/savings/src/lib.rs:208-243`; tests `iwa-savings/contracts/savings/src/test.rs:66-106`

Legacy behavior:
- Any caller may create a circle. There is no creator, owner, or admin concept
  anywhere in the contract (no privileged entry points exist).
- Parameters: token (any Soroban token address, no allowlist), `amount > 0`
  (i128), `frequency > 0` (seconds), `size >= 2`, `trust_required: bool`.
- Invalid configuration reverts with `InvalidConfig` (`lib.rs:216-218`).
- Initial state: `current_round = 1`, `status = Open`, `members = 0`,
  `round_start = current ledger timestamp` (`lib.rs:223-234`).
- No payout order is agreed or recorded at creation. No grace period exists.
- The round-1 on-time deadline is implicitly `creation_time + frequency`
  because `round_start` is set at creation (`lib.rs:233`).

Keep / change / remove:
`CHANGE` (creation gains approved configuration; the rest is kept)

New chain-neutral behavior:
- Creation records: asset (from the USDC/STRK allowlist), contribution amount,
  cadence, member limit, grace period, and a payout-order commitment agreed
  before contributions begin (`ARCHITECTURE.md:270-320`, `PROJECT.md:162-170`).
- Circle lifecycle becomes
  `CREATED → OPEN_FOR_MEMBERS → ACTIVE → ROUND_N → … → COMPLETED`
  with an optional `PAUSED_FOR_NEW_ACTIONS` emergency state
  (`ARCHITECTURE.md:270-296`).

Reason:
The legacy rotation was implicit (join order, section 2.8). The approved
architecture requires the payout order to be fixed before contributions begin
and immutable once active (`PROJECT.md:164-170`), which must be configured at
creation. The grace window and token allowlist are new approved rules
(`PROJECT.md:172-184`, `ARCHITECTURE.md:257-268`, `SECURITY.md:161-172`).

### 2.2 Circle identity and id sequencing

Source:
`iwa-savings/contracts/savings/src/lib.rs:220-240`; test `test.rs:67-89, 380-390`

Legacy behavior:
- Circle ids are assigned sequentially from a counter starting at 0
  (`lib.rs:220-240`), with no gaps.
- The frontend discovery relies on this: it scans ids `0..max` and stops at the
  first `CircleNotFound` (`iwa-web/src/lib/iwaContract.ts:366-400`).
- A missing id reverts with `CircleNotFound` (`test.rs:380-390`).

Keep / change / remove:
`KEEP`

New chain-neutral behavior:
- Sequential, gap-free circle ids remain a domain property (chain-neutral `id`).

Reason:
Discovery depends on it and nothing in the approved architecture changes id
semantics.

### 2.3 Membership and slot assignment

Source:
`iwa-savings/contracts/savings/src/lib.rs:248-298`; tests `test.rs:108-148`

Legacy behavior:
- Any caller may join any circle with any 32-byte commitment while slots
  remain. There is no invite, no approval, no organizer control.
- Duplicate join is rejected with `AlreadyMember`; the duplicate check runs
  before the fullness check so an existing member of a full circle gets
  `AlreadyMember`, not `CircleFull` (`lib.rs:257-266`; `test.rs:138-147`).
- When all `size` slots are taken, `members == size` and `status` becomes
  `Active` (`lib.rs:286-288`; `test.rs:134-136`).
- A circle is never "active with free slots": `Active` implies full.
- Slots are assigned in join order (`slot = members.len()`, `lib.rs:283`);
  slot order is the payout rotation (section 2.8).
- There is no member removal, no capacity reservation, no pending/approved
  state, and no join deadline.

Keep / change / remove:
`CHANGE` (invite/approval model added; slot-order payout concept kept)

New chain-neutral behavior:
- Membership is private and invite-based; joining is controlled by invitation
  and approval where configured, by circle capacity, and by contract state
  (`ARCHITECTURE.md:298-309`, `PROJECT.md:158-162`).
- No arbitrary public user can join an existing trusted circle
  (`ARCHITECTURE.md:309`).
- Capacity limits and duplicate-join rejection remain.
- Membership is recorded as a commitment/reference, never a real identity
  (kept from legacy, see 2.4).

Reason:
The approved first-release model is private, invite-based circles
(`PROJECT.md:158-162`). Open-by-anyone join conflicts with that.

### 2.4 Identity model: commitments only; payer binding (Option A)

Source:
`iwa-savings/contracts/savings/src/lib.rs:6-7, 158, 327-329, 432-433`;
`test.rs:10-13`

Legacy behavior:
- Members are represented only by a 32-byte commitment; no real identity is
  stored on chain (`lib.rs:6-7, 158`).
- The paying wallet address (`from` in `pay_contribution`) is passed at call
  time and is NOT cryptographically bound to the commitment on chain
  (documented "Option A" in `test.rs:10-13`).
- The payout address (`to` in `collect_pot`) is likewise passed at call time
  and not bound to the commitment.
- Anyone holding a member's commitment can pay for it or direct its payout
  (`collect_pot` transfers to whatever `to` the caller supplies, `lib.rs:432-433`).

Keep / change / remove:
`KEEP` the commitment-only identity; `CHANGE` the binding strength if the
approved architecture requires it.

New chain-neutral behavior:
- Members are referenced by a member commitment/ref, never a public wallet
  address as primary identity (`ARCHITECTURE.md:601-610`).
- The exact binding between member reference, paying account, and payout
  destination must be designed deliberately for STRK20 (the helper validates
  membership/eligibility; `docs/strk20/INTEGRATION_RESEARCH.md:243-266`).

Reason:
Commitment-only identity is core to the product's privacy positioning and is
preserved by `ARCHITECTURE.md:601-610`. The loose Option A payer binding was a
legacy simplification and should not be silently inherited (see section 3
edge case E-08 and the UNKNOWN list).

### 2.5 Trust-gated join (reputation proof gate)

Source:
`iwa-savings/contracts/savings/src/lib.rs:149, 270-281`; tests `test.rs:150-183`;
verifier seam `iwa-verifier/contracts/verifier/src/lib.rs:17-21, 81-122`

Legacy behavior:
- A circle created with `trust_required = true` requires a Groth16 reputation
  proof at join time.
- No proof → `TrustProofRequired`; a proof rejected by the on-chain verifier →
  `InvalidTrustProof` (`lib.rs:270-281`).
- Cheap checks (duplicate/full) run before the cross-contract proof check
  (`lib.rs:268-269`).
- The verifier is cross-called at the hardcoded contract id
  `CBEUUHRLMSBAOX2NTNZFKKP2FBN3XMNTY6JCIOGBKYHMC5AEQTI3ZKDS` (`lib.rs:149`).
- The proof is `proof` (256 bytes A||B||C) + `public_signals`
  `[nullifier, threshold, root]` (`iwa-verifier/contracts/verifier/src/lib.rs:17-21`).
- Observed gap: the savings contract checks only the boolean returned by the
  verifier. It does NOT check that `root` matches this circle's membership, and
  it does not store or check the nullifier (`lib.rs:277-280`; no nullifier
  storage key exists in `DataKey`, `lib.rs:159-172`).
- Observed gap: `join_circle` accepts any 32-byte commitment; it does not
  verify that the commitment equals the proof's leaf (`lib.rs:251, 277-280`).

Keep / change / remove:
`CHANGE` for the MVP (invite replaces the join-time proof gate);
`HOLD` the underlying proof concepts for the credential layer.

New chain-neutral behavior:
- Joining an MVP circle is invite/approval based, not proof-gated
  (`ARCHITECTURE.md:298-309`).
- The scoped reliability claim (`completed_cycles >= N`, `default_count == 0`)
  becomes the Portable Trust Credential, built only after STRK20 research
  (`docs/strk20/INTEGRATION_RESEARCH.md:336-369`; `ARCHITECTURE.md:386-400`).
- If a proof layer is rebuilt, the savings-state binding gaps observed above
  must be closed (root/nullifier/leaf validation) or explicitly re-approved.

Reason:
The research decision is `PARTIAL REUSE / REBUILD MINIMALLY` for the legacy
ZK layer (`docs/strk20/INTEGRATION_RESEARCH.md:348-369`). The join gate itself
is redundant once membership is invite-based, and its on-chain binding was
incomplete (gaps above), so it is not carried into the MVP as-is.

### 2.6 Contribution obligation and payment

Source:
`iwa-savings/contracts/savings/src/lib.rs:302-349`; tests `test.rs:185-238`

Legacy behavior:
- A contribution is recorded per `(circle, round, member_commitment)`
  (`lib.rs:319`).
- Preconditions: caller commitment must be a member (`NotMember`), and
  `round` must equal `current_round` (`WrongRound`) (`lib.rs:312-317`).
- Duplicate payment for the same (circle, round, member) reverts with
  `AlreadyPaid`, checked before any token transfer (`lib.rs:319-322`;
  `test.rs:221-225`).
- The real token transfer runs first: `from.require_auth()`, then
  `token.transfer(from, contract, amount)` (`lib.rs:327-329`). A failed
  transfer leaves no record behind.
- The recorded `Contribution` is `{ member, round, on_time, ledger }`
  (`lib.rs:82-90`); `ledger` is the Soroban ledger sequence, not a tx hash
  (`lib.rs:15-19`).
- Amount is always exactly the circle `amount`; there is no partial
  contribution, no over-payment, no amount parameter.

Keep / change / remove:
`KEEP` the obligation semantics; `CHANGE` the state model.

New chain-neutral behavior:
- One deterministic obligation per required member per round
  (`ARCHITECTURE.md:322-338`).
- An obligation is satisfied at most once (replay of a previously accepted
  contribution must fail; `SECURITY.md:186-191`).
- Wrong-round, non-member, and duplicate paths remain distinct errors.
- Status becomes `PENDING / ON_TIME / LATE_WITHIN_GRACE / MISSED_DEFAULT`
  (`ARCHITECTURE.md:322-338`).

Reason:
Obligation uniqueness and wrong-round rejection are sound and are explicitly
required again by `SECURITY.md:186-191`. The binary on-time flag is replaced
by the three-state model (section 2.7).

### 2.7 Contribution timing and on-time classification

Source:
`iwa-savings/contracts/savings/src/lib.rs:331-334`; tests `test.rs:185-238`

Legacy behavior:
- Deadline for a round = `round_start + frequency` (`lib.rs:332`).
- `on_time = now <= deadline` (`lib.rs:333`). At exactly the deadline, the
  contribution is still on time.
- A late contribution is ACCEPTED and recorded with `on_time = false`
  (`test.rs:214-219`); it never reverts.
- There is NO grace window, NO `MISSED_DEFAULT` state, and NO deadline
  enforcement at the contribution layer: a contribution is never refused for
  being late.
- A round with no record simply has no `Contribution`; absence only becomes
  visible as a "missed" count inside `get_reputation` (section 2.11).
- `round_start` resets to the current timestamp on every `advance_round`
  (`lib.rs:363`), so the deadline moves with advancement.

Keep / change / remove:
`CHANGE` (three-state model with grace replaces binary on-time)

New chain-neutral behavior:
- Locked grace timing decision (August 27, 2026): time source is the Starknet
  block timestamp in seconds; `due_at` and `grace_ends_at` derive from one
  authoritative contract-side timestamp source; classification per obligation:

  ```text
  now <= due_at                  -> ON_TIME
  due_at < now <= grace_ends_at  -> LATE_WITHIN_GRACE
  now > grace_ends_at (no valid
  settlement)                    -> MISSED_DEFAULT
  ```

  (`ARCHITECTURE.md:338-349`; plan Task 6 slice 6E boundary tests).
- The distinction between recorded states and absence disappears: every
  required obligation ends in one of the three recorded states.

Reason:
The approved reliability model requires explicit grace and default states
(`PROJECT.md:172-184`; `ARCHITECTURE.md:338-349`). The legacy model could not
distinguish "late but recoverable" from "default", which is the core motivation
for the new deficit rules.

### 2.8 Round advancement and payout rotation

Source:
`iwa-savings/contracts/savings/src/lib.rs:353-380`; tests `test.rs:240-308`

Legacy behavior:
- `advance_round` takes no authorization: ANY caller can advance any circle.
- It increments `current_round`, resets `round_start` to now, and returns the
  new round's collector (`lib.rs:361-369`).
- Collector for round r is `members[(r - 1) % members.len()]`
  (`lib.rs:368-369`) — rotation cycles through slots in join order.
- Round 1 collector is slot 0 (first joiner); a size-N circle pays slots
  0..N-1 in rounds 1..N.
- There is no requirement that the previous round was funded or collected
  before advancing; rounds can be advanced past unpaid rounds.
- The rotation formula uses `members.len()`, not `size`, so advancement on a
  partially filled circle rotates over the joined members only.
- `advance_round` on an empty circle reverts with `NoMembers` (`lib.rs:357-359`).
- There is no check of circle status: an `Open` (partially filled) circle can
  be advanced.

Keep / change / remove:
`CHANGE` (explicit locked rotation replaces implicit join-order rotation)

New chain-neutral behavior:
- Payout order is agreed at creation and immutable once contributions begin
  (`PROJECT.md:164-170`; `ARCHITECTURE.md:311-320`).
- Admin cannot reorder recipients, skip recipients arbitrarily, or redirect
  funds; payout follows deterministic contract state
  (`ARCHITECTURE.md:315-320`).
- Round progression is monotonic; rounds cannot skip unexpectedly, move
  backward, or finalize twice (`SECURITY.md:208-217`).
- Advancement authorization and timing constraints must be designed explicitly
  (legacy had none).

Reason:
The implicit join-order rotation was deterministic but (a) not fixed at
creation, (b) mutable until the circle filled, and (c) advanceable by anyone at
any time with no funding prerequisite — a griefing surface (section 3, E-04,
E-05). The approved model fixes the rotation up front.

### 2.9 Pot collection and payout

Source:
`iwa-savings/contracts/savings/src/lib.rs:384-440`; tests `test.rs:240-348`

Legacy behavior:
- Only the current round's collector commitment may collect (`NotCollector`,
  `lib.rs:400-404`; `test.rs:278-282`).
- Full-round funding gate: every member must have a `Contribution` record for
  the current round or collection reverts with `RoundNotFunded`
  (`lib.rs:406-420`; `test.rs:310-348`). Nothing leaves the contract until the
  round is fully funded.
- Payout amount is exactly `amount * size` (the whole pot) (`lib.rs:428`).
- One collection per member per circle: a nullifier key
  `Collected(circle_id, member)` blocks `AlreadyCollected` (`lib.rs:422-426`;
  `test.rs:273-277, 298-302`).
- The pot moves from the contract to the caller-supplied `to` address
  (`lib.rs:432-433`).
- `collect_pot` does not check circle status; collection remains possible even
  after `Completed`, subject to the nullifier.

Keep / change / remove:
`CHANGE` (deficit-based payout replaces the all-or-nothing funding gate)

New chain-neutral behavior:
- Locked deficit payout fallback decision (August 27, 2026): if the scheduled
  payout recipient has an unresolved deficit —

  - the payout is not redirected and is marked `DEFERRED/LOCKED`
  - the circle continues to later rounds; progression is not stalled
  - the member may cure the deficit under predefined cure rules and then
    claim their deferred payout
  - admin cannot select a replacement recipient or release the payout
    arbitrarily
  - if the cycle reaches final settlement while the deficit remains uncured,
    a deterministic recovery/refund state-machine path applies, with no admin
    discretion; the recovery amount derives from verified state and is replay
    protected

  (`PROJECT.md:186-192`; `ARCHITECTURE.md:351-361`; `SECURITY.md:218-228`).
- Admin cannot choose or redirect the recipient (`SECURITY.md:218-228`).
- One payout per round executes at most once (`SECURITY.md:192-196`).
- Payout amount/accounting must satisfy the value-in/value-out invariant
  (section 2.14 / `IWA_INVARIANTS.md` INV-014).

Reason:
The legacy funding gate means one non-paying member permanently locks the
entire circle (E-06). The approved architecture replaces this with per-member
deficit handling so the circle can progress deterministically
(`ARCHITECTURE.md:351-361`). The single-collection and collector-scheduling
guards are kept in spirit.

### 2.10 Circle completion

Source:
`iwa-savings/contracts/savings/src/lib.rs:364-366`; test `test.rs:304-307`

Legacy behavior:
- `status` becomes `Completed` when `new_round > size`, i.e. when advancement
  creates the round after the last member's turn (`lib.rs:364-366`).
- A size-N circle is `Completed` at round N+1 after every slot has had a turn
  in rounds 1..N.
- Completion is a label only; no payout is forced, no funds are swept, and no
  further state is frozen (advance/collect remain callable).

Keep / change / remove:
`KEEP` the "every member had a turn" completion concept; `CHANGE` the
transition trigger.

New chain-neutral behavior:
- Lifecycle reaches `COMPLETED` after the final round finalizes
  (`ARCHITECTURE.md:270-296`).
- Completed financial history is immutable (`PROJECT.md:182-184`;
  `SECURITY.md:196-207`).
- Completion semantics (what exactly may or may not happen after completion)
  must be pinned in the domain spec before Cairo implementation.

Reason:
The legacy completion trigger is incidental (an off-by-one artifact of
advancement) and lacks defined post-completion semantics; the new lifecycle
defines it as a real terminal state.

### 2.11 Reputation derivation

Source:
`iwa-savings/contracts/savings/src/lib.rs:123-135, 472-518`; tests `test.rs:392-503`

Legacy behavior:
- `Reputation { completed_cycles, on_time_count, default_count }` is never
  stored; it is computed on demand from `Contribution` records
  (`lib.rs:123-135, 466-471`), so it cannot drift from the records.
- `completed_cycles` = number of rounds with any record (on time or late)
  (`lib.rs:509`). Despite the name it counts contributed rounds, not cycles.
- `on_time_count` = records with `on_time == true`.
- `default_count = late_count + missed`, where `missed = through - paid`
  (`lib.rs:509-511`): every round up to the member's highest recorded round
  that has no record counts as a default; every late record counts as a
  default.
- Rounds are scanned `1..=cap` with `cap = max(size, current_round)`
  (`lib.rs:481-485`).
- Consequences observed in tests: perfect member `(3, 3, 0)`; one late
  `(3, 2, 1)`; missed a round `(2, 2, 1)`; no history `(0, 0, 0)`
  (`test.rs:392-503`).
- A member who joined late is penalized: rounds before their join are counted
  as missed if an earlier record exists (a later-joining member can never have
  a clean `default_count` unless they were present from round 1).
- Unpaid current/future rounds are NOT counted as defaults (only gaps up to
  the highest recorded round are).
- The frontend derives `onTimeRate = on_time_count / completed_cycles`
  (`iwa-web/src/lib/iwaContract.ts:485-492`) and shows a "streak" equal to
  `completed_cycles` (`iwaContract.ts:437-445`).

Keep / change / remove:
`KEEP` derivation-from-records; `CHANGE` the underlying state model and the
misleading `completed_cycles` name.

New chain-neutral behavior:
- Reliability derives from recorded events: `ON_TIME`, `LATE_WITHIN_GRACE`,
  `MISSED_DEFAULT`, completed rounds, completed cycles
  (`ARCHITECTURE.md:363-384`).
- Credential claims are scoped, e.g. `completed_cycles >= N`,
  `default_count == 0`, `on_time_rate >= X` (`ARCHITECTURE.md:375-384`).
- The domain model should use explicit, correctly named counters (e.g.
  `contributed_rounds`, `on_time_count`, `late_within_grace_count`,
  `default_count`) rather than the legacy misnomer.

Reason:
Deriving reputation from immutable records is sound and preserved. The legacy
binary late/missed model is replaced by the three-state model, and the
"missed rounds before join" penalty should be re-examined in the domain spec
(it may be intended or may be an artifact).

### 2.12 Demo seeding seam

Source:
`iwa-savings/contracts/savings/src/lib.rs:520-543`; test `test.rs:350-378`

Legacy behavior:
- `seed_contribution` writes `Contribution` records directly, bypassing round
  checks, time checks, and token movement (`lib.rs:524-543`).
- The code itself discloses this as a demo seam, not production behavior
  (`lib.rs:520-523`).
- It overwrites unconditionally (`lib.rs:539-542`); a seeded record also
  occupies the same key as a real payment, so a later real `pay_contribution`
  for that (circle, round, member) reverts with `AlreadyPaid`
  (`lib.rs:319-322`).
- A seeded record satisfies the `RoundNotFunded` full-funding check, so seeded
  history can unlock real pot payouts if the rest of the round is funded with
  real transfers (`lib.rs:406-420`).
- The frontend does not call `seed_contribution` (no call sites in
  `iwa-web/src`); where it was invoked is `UNKNOWN` (section 6).

Keep / change / remove:
`REMOVE` from the chain-neutral domain and from any production/mainnet
contract.

New chain-neutral behavior:
- No history-writing backdoor exists. Contribution history is written only by
  the legitimate contribution path.
- If demo data is ever needed for a demo environment, it must be produced by a
  clearly separated, non-production mechanism that cannot touch a real
  contract.

Reason:
The seam bypasses every financial control in the contract. `SECURITY.md:196-207`
requires completed contribution state to be immutable and admin to be unable to
rewrite it; a seeding entry point contradicts that. It also interacts badly
with real funding checks (above).

### 2.13 Admin powers (observed: none)

Source:
`iwa-savings/contracts/savings/src/lib.rs:201-544` (full contract surface)

Legacy behavior:
- There are no privileged entry points at all: no owner, no organizer role, no
  pause, no admin functions.
- Every mutating function is callable by any address
  (`create_circle`, `join_circle`, `pay_contribution`, `advance_round`,
  `collect_pot`, `seed_contribution`).
- Notably, `advance_round` is permissionless, so any third party can advance a
  circle (see section 3, E-04/E-05).

Keep / change / remove:
`CHANGE` (introduce an operational, non-custodial admin model)

New chain-neutral behavior:
- Admin is operational, not custodial (`AGENTS.md`; `PROJECT.md:283-313`;
  `ARCHITECTURE.md:516-545`).
- Admin may have narrow emergency pause, operational configuration, support
  tooling, monitoring, and approved feature toggles
  (`SECURITY.md:296-319`).
- Admin can never seize funds, redirect payouts, alter payout order, rewrite
  history, erase defaults, or forge credentials (`SECURITY.md:303-320`).
- Every privileged action must be authenticated, authorized, attributable, and
  logged (`ARCHITECTURE.md:547-558`).

Reason:
The approved architecture explicitly introduces a non-custodial admin
dashboard and emergency pause (`PROJECT.md:283-333`), which the legacy contract
completely lacked. Least privilege applies (`SECURITY.md:321-337`).

### 2.14 ZK credential claim semantics (reputation circuit / prover / verifier)

Source:
`iwa-circuit/reputation.circom:61-118`; `iwa-circuit/gen_input.js:41-58`;
`iwa-prover/src/lib.rs:1-11`; `iwa-verifier/contracts/verifier/src/lib.rs:17-21, 81-122`;
`iwa-web/src/lib/zk.ts:34-101`; `iwa-web/src/screens/ProveView.tsx:29-35`

Legacy behavior:
- The circuit proves, in zero knowledge: membership in a 16-leaf Poseidon
  Merkle tree (`root`), `completedCycles >= threshold`, and
  `defaultCount == 0` (`reputation.circom:90-99`), plus a sanity constraint
  `onTimeCount <= completedCycles` (`reputation.circom:101-106`).
- Public inputs: `threshold`, `root`. Public output: `nullifier =
  Poseidon(leaf, threshold)` (`reputation.circom:108-118`).
- Public signals in verifier order: `[nullifier, threshold, root]`
  (`iwa-verifier/contracts/verifier/src/lib.rs:17-21`).
- All numeric reputation inputs (`completedCycles`, `onTimeCount`,
  `defaultCount`), the secret, and the Merkle branch are private
  (`reputation.circom:62-68`).
- The secret never leaves the device; proving happens in-browser/in-WASM
  (`iwa-prover/src/lib.rs:1-11`; `iwa-web/src/lib/zk.ts:1-9`).
- The verifier is a pure Groth16 pairing check on BN254 with an embedded
  verification key (`iwa-verifier/contracts/verifier/src/lib.rs:87-122`).
- Observed gap: the reputation numbers are private inputs chosen by the
  prover. The frontend hardcodes `completedCycles: "5", onTimeCount: "5",
  defaultCount: "0"` into the witness (`iwa-web/src/lib/zk.ts:62-64`); they are
  NOT read from on-chain `get_reputation`. Neither the circuit nor the savings
  contract binds the proven numbers to on-chain records.
- The two prototype claims: "Completed 2 full cycles, always on time" and
  "Never defaulted across 2 cycles", both threshold 2
  (`iwa-web/src/screens/ProveView.tsx:29-35`).

Keep / change / remove:
`HOLD` the proof concepts; `CHANGE` the binding and scoping for the Portable
Trust Credential.

New chain-neutral behavior:
- Credential claims are scoped and minimal, e.g. `completed_cycles >= N`,
  `default_count == 0` (`ARCHITECTURE.md:375-384`; `PROJECT.md:222-237`).
- A credential must only prove facts derivable from valid protocol history
  (`SECURITY.md:376-400`) — the legacy self-asserted numbers do not satisfy
  this and must not be inherited.
- STRK20 research decision: `PARTIAL REUSE / REBUILD MINIMALLY`
  (`docs/strk20/INTEGRATION_RESEARCH.md:348-369`) — STRK20 handles payment
  privacy; a minimal proof layer may handle scoped reliability claims only.

Reason:
The claim shape (threshold + zero defaults, hidden numbers, on-device secret)
is the right product shape and is preserved conceptually. But the legacy
implementation proved self-asserted numbers with no binding to on-chain
history, which fails the approved "claims cannot exceed valid underlying
history" invariant (`IWA_INVARIANTS.md` INV-011) and `SECURITY.md:376-400`.

### 2.15 Frontend contract seam (observed integration facts)

Source:
`iwa-web/src/lib/iwaContract.ts:1-10, 97-131, 190-239, 263-268, 366-400, 437-493`

Legacy behavior (read-only evidence of how the product consumed the contract):
- Reads are Soroban simulations; writes are real signed transactions
  (`iwaContract.ts:1-10`).
- The frontend classifies contract errors by Soroban error code
  (`iwaContract.ts:97-131`), mapping codes 2..13 to named reasons, with
  wallet-decline and token-insufficient-balance detected from wallet text.
- Status mapping: `Open → "forming"`, `Active → "active"`,
  `Completed → "complete"` (`iwaContract.ts:263-268`).
- Circle discovery scans sequential ids and stops at the first missing id
  (`iwaContract.ts:366-400`).
- The UI composes `pot = amount * size` and `streak = completed_cycles` from
  on-chain data (`iwaContract.ts:437-457`).
- `advance_round` has no signed-write call site in the frontend; progression
  in the UI was read-only. Where advancement was actually invoked is
  `UNKNOWN` (section 6).
- The transaction hash is attached by the wiring layer from the submit
  response, never by the contract (`iwaContract.ts:190-239` and
  `lib.rs:15-19`).

Keep / change / remove:
`KEEP` the seam principles (simulation reads, signed writes, honest error
classification); `CHANGE` the chain (Stellar → Starknet/STRK20).

New chain-neutral behavior:
- A chain-neutral interface with a Starknet adapter replaces the Soroban seam
  (`ARCHITECTURE.md:432-465`; plan Task 9).
- Error classification remains honest and chain-neutral at the UI boundary.
- The frontend must not receive viewing keys or hold private material
  (`docs/strk20/INTEGRATION_RESEARCH.md:70-74`).

Reason:
The seam structure is sound and preserved; only the chain-specific plumbing
changes (plan Task 9).

---

## 3. Observed edge cases and failure modes

Each item cites where it is observable.

| ID | Edge case | Observed from | Notes |
|---|---|---|---|
| E-01 | Duplicate join of a full circle returns `AlreadyMember`, not `CircleFull` | `lib.rs:257-266`; `test.rs:138-147` | precedence deliberately ordered |
| E-02 | Late contribution is accepted and flagged, never rejected | `lib.rs:331-334`; `test.rs:214-219` | no grace, no refusal |
| E-03 | Double payment rejected before any transfer | `lib.rs:319-322`; `test.rs:221-225` | replay-safe per (circle, round, member) |
| E-04 | `advance_round` is permissionless and has no timing or funding prerequisite | `lib.rs:353-380` | any third party can advance; resets `round_start` (deadline moves) |
| E-05 | Advancing skips unpaid rounds; the missed round can never be paid afterwards (`WrongRound`) | `lib.rs:315-317, 361-363` | turns a would-be-late payment into a missed default |
| E-06 | One unfunded member locks the whole circle (`RoundNotFunded`) forever; no cure, no removal | `lib.rs:406-420`; `test.rs:310-348` | motivating case for the deficit model |
| E-07 | A member collects at most once per circle (nullifier), not per round | `lib.rs:422-426`; `test.rs:273-277` | fine for one cycle; blocks re-collection in later cycles |
| E-08 | Commitment is not bound to the paying or receiving address (Option A) | `test.rs:10-13`; `lib.rs:327-329, 432-433` | anyone holding a commitment can act for it |
| E-09 | Seeded records satisfy the full-funding gate and block real payments | `lib.rs:406-420, 524-543` | demo seam interacts with real financial checks |
| E-10 | Reputation penalizes members for rounds before they joined | `lib.rs:509-511`; `test.rs:438-454` | `missed = through - paid` over `1..=through` |
| E-11 | Unpaid current/future rounds do not count as defaults | `lib.rs:487-511` | `through` = highest recorded round |
| E-12 | Reputation is derived, never stored | `lib.rs:123-135, 466-471` | cannot drift; cheap on-chain scan |
| E-13 | `advance_round` on an empty circle reverts `NoMembers` | `lib.rs:357-359` | |
| E-14 | `collect_pot` is allowed after `Completed` (subject to nullifier) | `lib.rs:384-440` (no status check) | no defined post-completion semantics |
| E-15 | `advance_round` allowed on a partially filled (`Open`) circle; rotation uses `members.len()`, not `size` | `lib.rs:368-369` | rotation changes as members join |
| E-16 | On-time boundary is inclusive (`now <= deadline`) | `lib.rs:333` | exact-boundary semantics to preserve/test |
| E-17 | Any token address is accepted at creation; no allowlist | `lib.rs:210-218` | conflicting with `SECURITY.md:161-172` |
| E-18 | Trust-gate proof's `root` is not checked against the circle's membership; nullifier not recorded; commitment not checked against proof leaf | `lib.rs:270-281`; `DataKey` `lib.rs:159-172` | binding gaps in the legacy gate |

---

## 4. Decision summary

| # | Legacy behavior | Decision | One-line reason |
|---|---|---|---|
| 1 | Circle creation (creator-less, token-agnostic, no payout order, no grace) | `CHANGE` | approved config adds asset allowlist, payout-order commitment, grace; admin/owner concept added |
| 2 | Sequential gap-free circle ids | `KEEP` | discovery depends on it; nothing changes |
| 3 | Open join by any caller, slot = join order | `CHANGE` | approved private/invite-based membership |
| 4 | Commitment-only identity on chain | `KEEP` | core privacy property (`ARCHITECTURE.md:601-610`) |
| 5 | Option A loose payer/payout binding | `CHANGE` | binding must be designed deliberately for STRK20; not silently inherited |
| 6 | Trust-gated join via Groth16 proof | `CHANGE` (MVP) / `HOLD` (proof concepts) | invite replaces the gate; ZK layer research decision is partial reuse |
| 7 | One obligation per (circle, round, member); `AlreadyPaid` | `KEEP` | required again by `SECURITY.md:186-191` |
| 8 | Binary on-time flag; late accepted; no grace | `CHANGE` | three-state model `ON_TIME / LATE_WITHIN_GRACE / MISSED_DEFAULT` |
| 9 | Permissionless `advance_round`; implicit join-order rotation | `CHANGE` | payout order fixed at creation, immutable; round progression controlled |
| 10 | Full-funding gate (`RoundNotFunded`), pot = amount * size | `CHANGE` | deficit-based payout rules replace all-or-nothing lock |
| 11 | Collector = `members[(r-1) % len]` | `CHANGE` | explicit locked rotation replaces implicit one |
| 12 | Nullifier one collection per member per circle | `KEEP` | payout uniqueness retained (per-round form) |
| 13 | `Completed` when `new_round > size` | `CHANGE` | real terminal lifecycle state |
| 14 | Reputation derived from records (`completed_cycles`, `on_time_count`, `default_count`) | `KEEP` (concept) / `CHANGE` (state model and naming) | derive-from-records kept; three-state inputs; rename misleading counter |
| 15 | `seed_contribution` demo seam | `REMOVE` | contradicts history immutability and financial controls |
| 16 | No admin/owner/pause anywhere | `CHANGE` | approved non-custodial admin + narrow pause |
| 17 | ZK claim: threshold + zero defaults, numbers private | `HOLD` | concepts kept; binding to real history required for credential |
| 18 | Error catalog (13 codes) | `KEEP` (shape) / `CHANGE` (add new states) | extend for grace/default/deficit/pause |
| 19 | Frontend seam principles | `KEEP` | preserved; chain replaced in plan Task 9 |

---

## 5. Approved new rules incorporated (from the control documents)

These are the rules the new chain-neutral domain must include, taken from
`PROJECT.md`, `ARCHITECTURE.md`, `STATUS.md`, `SECURITY.md`, and the
implementation plan (`docs/superpowers/plans/2026-08-27-iwa-strk20-rebuild.md`,
Task 3).

- Private, invite-based circles first; no permissionless public pools in the
  MVP (`PROJECT.md:158-162`).
- Payout rotation agreed at creation; immutable once contributions begin;
  admin cannot change recipients (`PROJECT.md:164-170`;
  `ARCHITECTURE.md:311-320`).
- Grace window for missed contributions; states `ON_TIME`,
  `LATE_WITHIN_GRACE`, `MISSED_DEFAULT`; history immutable
  (`PROJECT.md:172-184`; `ARCHITECTURE.md:322-349`). Locked timing rule:
  Starknet block timestamp in seconds; one authoritative contract-side
  timestamp source; `now <= due_at` → `ON_TIME`,
  `due_at < now <= grace_ends_at` → `LATE_WITHIN_GRACE`,
  `now > grace_ends_at` without valid settlement → `MISSED_DEFAULT`.
- Unresolved deficit locks the scheduled payout under predefined rules;
  deterministic fallback; admin cannot redirect
  (`PROJECT.md:186-192`; `ARCHITECTURE.md:351-361`). Locked fallback rule:
  payout marked `DEFERRED/LOCKED`, never redirected; circle continues;
  member may cure and claim the deferred payout; admin cannot release or
  replace; uncured deficit at final settlement follows a deterministic
  recovery/refund path with no admin discretion.
- Supported assets: USDC and STRK only, allowlisted, configured
  (`PROJECT.md:400-409`; `ARCHITECTURE.md:257-268`; `SECURITY.md:161-172`).
- Admin is operational, non-custodial; cannot seize/redirect/rewrite/erase/
  forge; narrow emergency pause (`PROJECT.md:283-333`;
  `ARCHITECTURE.md:516-577`; `SECURITY.md:296-362`).
- Portable Trust Credential: scoped claims only; never a universal credit
  score; claims must be derivable from valid protocol history
  (`PROJECT.md:222-237`; `ARCHITECTURE.md:386-400`; `SECURITY.md:376-400`).
- STRK20 handles payment privacy; legacy Circom/Groth16 only partially reused
  for scoped credential claims (`docs/strk20/INTEGRATION_RESEARCH.md:348-369`).
- IWA Core stays chain-neutral; Starknet specifics behind the adapter
  (`ARCHITECTURE.md:88-96`; `AGENTS.md`).
- Backend/indexer is non-authoritative and stores no private financial data
  (`PROJECT.md:253-281`; `ARCHITECTURE.md:468-513`).

---

## 6. UNKNOWN and unverifiable items

Nothing below is claimed as fact; each needs verification before implementation
decisions depend on it.

- **U-01** Where `advance_round` and `seed_contribution` were actually invoked
  in the legacy product (no call sites exist in `iwa-web/src`; usage may have
  been via scripts or manual calls). `UNKNOWN`.
- **U-02** Whether the trust-gated join path was ever exercised with real
  Groth16 proofs against a deployed verifier (tests use a stub that always
  accepts, `test.rs:37-55`). `UNKNOWN`.
- **U-03** Whether the hardcoded verifier contract id
  (`lib.rs:149`) is still deployed/functional on Stellar testnet. `UNKNOWN`.
- **U-04** Whether the missing root/nullifier/leaf binding in the trust gate
  (E-18) was a known limitation or an oversight. `UNKNOWN`.
- **U-05** Whether the "missed rounds before join" reputation penalty (E-10)
  was intended product behavior. `UNKNOWN`.
- **U-06** The intended meaning of `completed_cycles` (name implies cycles;
  implementation counts contributed rounds). `UNKNOWN` — flagged in 2.11.
- **U-07** Whether a circle was ever allowed to run multiple cycles in
  practice (rotation cycles past `size`, but the per-member nullifier blocks
  a second collection). `UNKNOWN`.
- **U-08** Exact token/amount semantics on the legacy testnet (whether `amount`
  was in base units for XLM/assets). Observed: frontend treats amount as base
  units (`iwaContract.ts:289-291`). Deployment details `UNKNOWN`.

## Last updated

August 27, 2026 — extraction task (plan Task 3, first pass), plus state-machine
blocker lock (grace timing and deficit payout fallback). Verification status:
created from direct repository inspection; no implementation code modified.
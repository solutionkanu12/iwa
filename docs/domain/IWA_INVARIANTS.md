# IWA — Domain Invariants

## Purpose

This document defines the persistent business properties the IWA domain must
satisfy on every chain implementation.

Each invariant states:

- **Definition** — the exact property
- **Reason** — why it exists (approved rule or legacy-derived requirement)
- **Enforcement point** — where it must be enforced (IWA Core, Cairo contract,
  STRK20 helper, backend, or test-only)
- **Planned test** — how it will be verified

## Legend

| Origin | Meaning |
|---|---|
| `LEGACY-KEPT` | observed in the legacy implementation and retained unchanged in spirit |
| `LEGACY-CHANGED` | derived from a legacy behavior that is intentionally modified |
| `NEW` | introduced by the approved architecture; no legacy equivalent |

Sources:
- Legacy behavior: `docs/domain/LEGACY_BEHAVIOR.md` (cites
  `iwa-savings/contracts/savings/src/lib.rs` and `test.rs`)
- Approved rules: `PROJECT.md`, `ARCHITECTURE.md`, `SECURITY.md`,
  `docs/strk20/INTEGRATION_RESEARCH.md`,
  `docs/superpowers/plans/2026-08-27-iwa-strk20-rebuild.md`

Status note: invariants are **defined**, not yet **verified** against any
Starknet implementation. The Starknet implementation does not exist yet.

---

## INV-001 — Payout order is immutable after activation

- **Origin:** `NEW` (legacy rotation was implicit join order,
  `LEGACY_BEHAVIOR.md` 2.8, E-15)
- **Definition:** Once the first active contribution begins, the payout
  rotation cannot be changed, reordered, or skipped arbitrarily.
- **Reason:** `PROJECT.md:164-170`, `ARCHITECTURE.md:311-320`,
  `SECURITY.md:178-185`.
- **Enforcement point:** IWA Core state machine + `IwaCircle` Cairo contract
  (order locked at creation, immutable after activation).
- **Planned test:** `test_payouts.cairo` / `test_invariants.cairo`:
  attempt reorder/skip/redirect before and after activation; only
  pre-activation changes allowed; post-activation attempts fail.
  `SECURITY.md:178-185`.

## INV-002 — One obligation can be satisfied at most once

- **Origin:** `LEGACY-KEPT` (`AlreadyPaid`, `lib.rs:319-322`)
- **Definition:** A contribution obligation for a given circle, round, and
  member cannot be satisfied more than once; replay of an accepted
  contribution must fail.
- **Reason:** `SECURITY.md:186-191`.
- **Enforcement point:** `IwaCircle` contribution path (unique obligation
  key), mirrored in the STRK20 helper (`INTEGRATION_RESEARCH.md:243-266`).
- **Planned test:** `test_contributions.cairo` duplicate-satisfaction test;
  helper replay test (`test_strk20_helper.cairo`).

## INV-003 — One round payout can execute at most once

- **Origin:** `LEGACY-CHANGED` (legacy nullifier was per member per circle,
  `lib.rs:422-426`; new form is per round)
- **Definition:** A payout for a round cannot execute more than once.
- **Reason:** `SECURITY.md:192-196`.
- **Enforcement point:** `IwaCircle` payout path (round payout state).
- **Planned test:** `test_payouts.cairo` double-payout rejection;
  `test_invariants.cairo`.

## INV-004 — Completed contribution history is immutable

- **Origin:** `LEGACY-KEPT` (no update path existed;
  `seed_contribution` removed, `LEGACY_BEHAVIOR.md` 2.12)
- **Definition:** A completed contribution state cannot be rewritten;
  `MISSED_DEFAULT → ON_TIME` must be impossible, including through admin
  intervention.
- **Reason:** `PROJECT.md:182-184`, `SECURITY.md:196-207`.
- **Enforcement point:** `IwaCircle` storage (write-once records); no admin
  rewrite path; no seeding seam.
- **Planned test:** `test_invariants.cairo` history-immutability test; audit
  that no write path other than contribution/payout exists.

## INV-005 — Admin cannot redirect payout recipient

- **Origin:** `NEW` (legacy had no admin)
- **Definition:** Admin cannot choose, substitute, or redirect the scheduled
  payout recipient; the recipient is determined only by the locked rotation
  and deterministic state.
- **Reason:** `PROJECT.md:186-192`, `ARCHITECTURE.md:315-320`,
  `SECURITY.md:218-228`.
- **Enforcement point:** `IwaCircle` payout logic; no admin setter exists.
- **Planned test:** `test_admin_pause.cairo` / `test_payouts.cairo`:
  admin attempts to change recipient fail.

## INV-006 — Admin cannot seize member funds

- **Origin:** `NEW`
- **Definition:** No admin, backend, or operational role can move, spend, or
  seize member funds; custody authority does not exist.
- **Reason:** `PROJECT.md:303-313`, `SECURITY.md:34-47, 303-320`.
- **Enforcement point:** contract access control; backend has no signing
  material (`ARCHITECTURE.md:488-501`).
- **Planned test:** `test_admin_pause.cairo` non-custody tests; backend schema
  tests proving forbidden fields absent (plan Task 10).

## INV-007 — Round progression is monotonic

- **Origin:** `LEGACY-KEPT` (rounds only incremented, `lib.rs:361-363`)
- **Definition:** Round numbers cannot skip unexpectedly, move backward, or
  finalize twice; rounds cannot finalize before required deterministic
  conditions are met.
- **Reason:** `SECURITY.md:208-217`.
- **Enforcement point:** `IwaCircle` round state machine.
- **Planned test:** `test_rounds.cairo` monotonicity and ordering tests;
  `test_invariants.cairo`.

## INV-008 — Unsupported assets cannot enter a circle

- **Origin:** `NEW` (legacy accepted any token, `LEGACY_BEHAVIOR.md` E-17)
- **Definition:** Only allowlisted assets (MVP: USDC, STRK) can be configured
  or moved by a circle; unknown assets are rejected.
- **Reason:** `PROJECT.md:400-409`, `ARCHITECTURE.md:257-268`,
  `SECURITY.md:161-172`.
- **Enforcement point:** `IwaCircle` creation + contribution paths; STRK20
  helper token validation.
- **Planned test:** `test_circle_creation.cairo` unsupported-asset rejection;
  `test_strk20_helper.cairo` token allowlist.

## INV-009 — Deficit handling is deterministic

- **Origin:** `NEW` (legacy was all-or-nothing funding, `LEGACY_BEHAVIOR.md`
  2.9, E-06)
- **Definition:** An unresolved deficit follows the locked predefined rules
  (August 27, 2026):

  - the scheduled payout is not redirected and is marked `DEFERRED/LOCKED`
  - the circle continues to later rounds; the locked payout does not stall
    progression
  - the member may cure the deficit under the predefined cure rules and then
    claim their deferred payout
  - admin cannot select a replacement recipient and cannot release the payout
    arbitrarily
  - if the cycle reaches final settlement while the deficit remains uncured,
    a deterministic recovery/refund state-machine path applies, with no admin
    discretion; the recovery amount derives from verified state and is replay
    protected

  Admin cannot ignore, reroute, or fabricate a cure.
- **Reason:** `PROJECT.md:186-192`, `ARCHITECTURE.md:351-361`,
  `SECURITY.md:218-228`.
- **Enforcement point:** `IwaCircle` payout/fallback state machine (locked
  per `ARCHITECTURE.md` "Deficit handling"); deferred-payout registry with
  cure/claim path; deterministic final-settlement recovery/refund path.
- **Planned test:** `test_payouts.cairo` deficit-lock, no-redirect,
  cure-then-claim, continuation-to-later-rounds, and final-settlement
  recovery/refund tests; `test_invariants.cairo` determinism.

## INV-010 — Pause cannot rewrite historical financial state

- **Origin:** `NEW`
- **Definition:** A pause may block new risky actions (joins, contributions,
  selected new operations) but can never rewrite history, change payout order,
  seize funds, or create unlimited freeze authority.
- **Reason:** `PROJECT.md:315-333`, `ARCHITECTURE.md:560-577`,
  `SECURITY.md:339-362`.
- **Enforcement point:** `IwaCircle` pause scoping; recovery paths preserved.
- **Planned test:** `test_admin_pause.cairo` scope tests: historical state
  unchanged during pause; safe reads remain.

## INV-011 — Credential claims cannot exceed valid underlying history

- **Origin:** `NEW` (legacy proof self-asserted private numbers,
  `LEGACY_BEHAVIOR.md` 2.14 gap)
- **Definition:** A Portable Trust Credential may only prove facts derivable
  from valid, verified protocol history; self-asserted numbers, stale claims,
  and forged reliability must fail.
- **Reason:** `PROJECT.md:222-237`, `ARCHITECTURE.md:386-400`,
  `SECURITY.md:376-400`.
- **Enforcement point:** credential issuance/proof layer (Phase 7 decision);
  claim derivation from recorded contribution states.
- **Planned test:** credential tests per plan Task 12: valid witness passes;
  invalid cycle count fails; hidden default fails; wrong user/context fails;
  stale/replayed handled.

## INV-012 — Backend/indexer data cannot override authoritative financial state

- **Origin:** `NEW`
- **Definition:** Backend/indexer data is non-authoritative; contracts remain
  authoritative for financial protocol state, and indexer outages never
  substitute fabricated data.
- **Reason:** `PROJECT.md:253-281`, `ARCHITECTURE.md:468-513`.
- **Enforcement point:** backend data-boundary design (public/non-sensitive
  only); frontend stale-data marking.
- **Planned test:** plan Task 10 schema tests proving forbidden fields absent;
  outage/stale-state tests.

---

## Additional invariants (derived from legacy behavior)

## INV-013 — No real identity on chain

- **Origin:** `LEGACY-KEPT` (`lib.rs:6-7, 158`; `test.rs:10-13`)
- **Definition:** Circles and contributions reference member commitments/refs,
  never real identities or (as primary identity) public wallet addresses.
- **Reason:** core privacy property; `ARCHITECTURE.md:601-610`.
- **Enforcement point:** IWA Core data model; Cairo storage.
- **Planned test:** storage schema review; backend privacy-boundary tests.

## INV-014 — Accounting: value in equals value out plus held value

- **Origin:** `LEGACY-CHANGED` (legacy: pot = `amount * size`, funds moved by
  token transfer, `lib.rs:327-329, 428-433`; per `SECURITY.md:229-248` the
  equation is now explicit)
- **Definition:** For each circle: accepted value = unsettled value +
  successfully distributed value + valid recoveries/withdrawals + explicitly
  accounted protocol fees. No unexplained value creation or loss.
- **Reason:** `SECURITY.md:229-248`.
- **Enforcement point:** `IwaCircle` accounting; STRK20 pool balance invariant
  (temporary balance per token never negative, final zero,
  `INTEGRATION_RESEARCH.md:232-241`).
- **Planned test:** `test_invariants.cairo` accounting equation per
  contribution/payout; helper balance-delta checks; fuzz tests.

## INV-015 — Collector/scheduled recipient is deterministically scheduled

- **Origin:** `LEGACY-CHANGED` (legacy formula
  `members[(r-1) % members.len()]`, `lib.rs:368-369`; now explicit locked
  order)
- **Definition:** For every round, exactly one scheduled recipient is derived
  from locked, deterministic state.
- **Reason:** `PROJECT.md:164-170`, `ARCHITECTURE.md:311-320`.
- **Enforcement point:** `IwaCircle` payout scheduling.
- **Planned test:** `test_payouts.cairo` recipient derivation across rounds.

## INV-016 — Circle ids are sequential and gap-free

- **Origin:** `LEGACY-KEPT` (`lib.rs:220-240`; discovery relies on it,
  `iwaContract.ts:366-400`)
- **Definition:** Circle ids are assigned sequentially with no gaps.
- **Reason:** legacy discovery contract; retained in domain spec.
- **Enforcement point:** `IwaCircle` creation counter.
- **Planned test:** `test_circle_creation.cairo` id sequencing.

## INV-017 — Reputation is derived from recorded history, never stored separately

- **Origin:** `LEGACY-KEPT` (`lib.rs:123-135, 466-471`)
- **Definition:** Reliability numbers are computed from immutable contribution
  records, so they cannot drift from the records they summarize.
- **Reason:** `ARCHITECTURE.md:363-384`; supports INV-011.
- **Enforcement point:** IWA Core reputation derivation; Cairo view.
- **Planned test:** reputation tests over seeded/deterministic history in the
  Cairo suite.

## INV-018 — Boundary timing is deterministic and exact

- **Origin:** `LEGACY-KEPT` (inclusive `now <= deadline`, `lib.rs:333`)
- **Definition:** On-time, grace, and default classification uses the locked
  rule (August 27, 2026): time source is the Starknet block timestamp in
  seconds; `due_at` and `grace_ends_at` derive from one authoritative
  contract-side timestamp source; per obligation:

  ```text
  now <= due_at                  -> ON_TIME
  due_at < now <= grace_ends_at  -> LATE_WITHIN_GRACE
  now > grace_ends_at (no valid
  settlement)                    -> MISSED_DEFAULT
  ```

  Boundaries are inclusive as written; no component computes the deadline
  independently.
- **Reason:** `ARCHITECTURE.md:338-349`, `SECURITY.md:250-263`.
- **Enforcement point:** `IwaCircle` classification logic (single component,
  single authoritative timestamp read).
- **Planned test:** slice 6E boundary tests: exactly at `due_at` → `ON_TIME`;
  exactly at `grace_ends_at` → `LATE_WITHIN_GRACE`; one second past
  `grace_ends_at` → `MISSED_DEFAULT` (pending valid settlement).

## INV-019 — No member can be added after activation

- **Origin:** `NEW` (legacy: full implied active, `lib.rs:286-288`; new model
  has explicit activation with invite-based membership)
- **Definition:** Once a circle is active, membership is closed; joins outside
  the invite/approval window fail.
- **Reason:** `ARCHITECTURE.md:298-309`; plan Task 6 slice 6B.
- **Enforcement point:** `IwaCircle` membership path.
- **Planned test:** `test_membership.cairo` cannot-join-after-activation;
  pause-blocks-joins.

## INV-020 — Deferred payouts stay claimable by the rightful member; final-settlement recovery is deterministic

- **Origin:** `NEW` (locked decision, August 27, 2026; `ARCHITECTURE.md`
  "Deficit handling")
- **Definition:** A payout marked `DEFERRED/LOCKED` because of an unresolved
  deficit is never redirected and never released by admin. It remains
  claimable by the scheduled member under the predefined cure rules. If the
  cycle reaches final settlement while the deficit remains uncured, a
  deterministic recovery/refund path applies: the recovery amount derives
  from verified state, the path is replay protected, and no admin discretion
  exists anywhere in the process.
- **Reason:** `PROJECT.md:186-192`, `SECURITY.md:192-196, 218-228, 363-374`.
- **Enforcement point:** `IwaCircle` deferred-payout registry; cure/claim
  path; final-settlement recovery/refund path.
- **Planned test:** `test_payouts.cairo` deferred-claim-after-cure;
  no-admin-release; final-settlement refund determinism and replay
  protection; `test_invariants.cairo`.

## INV-021 — Contribution authorization is member-held and obligation-scoped

- **Origin:** `NEW` (locked August 28, 2026 after the Task 6D authorization
  security gate)
- **Definition:** Every joined member has one immutable, IWA-specific
  Stark-curve authentication public key that is not a Starknet account
  address. A contribution authorization is valid only for the exact
  domain-separated tuple `(IWA_CONTRIBUTION_V1, circle_id, round, member_ref,
  amount, nonce)`. Changing any field invalidates it. The private key is never
  submitted, stored, or emitted; the invite secret is never reused as a
  contribution credential.
- **Reason:** `member_ref` is public and invite secrets appear in public join
  calldata, so neither proves member authorization for later obligations.
- **Enforcement point:** join-time key registration in `IwaCircle`; signature
  verification and atomic nonce consumption in Task 6D; pool-only helper
  binding in Task 8.
- **Verified test:** `test_member_authorization.cairo` covers key validity,
  persistence, immutability, caller/admin non-replacement, payout-order
  preservation, field/domain binding, valid signatures, and canonical
  signature rejection. Nonce consumption remains Task 6D.

---

## INV-022 — Financial settlement is helper-only and destination-bound

- **Origin:** `NEW` (Task 8A-S security gate, August 28, 2026)
- **Definition:** One constructor-pinned helper is the only caller that may
  transition contribution/cure financial state or mark payout/recovery value
  settled. Every financial authorization binds helper, pool, token, amount,
  circle, round, member, and nonce. Payout/recovery also bind the rightful
  member's `open_note_id` under distinct domains.
- **Enforcement point:** immutable constructor configuration, helper-only core
  APIs, signature verification, and per-domain nonce maps.
- **Test:** `test_settlement_boundary.cairo`.

## INV-023 — Funded liabilities are conserved per round and token

- **Origin:** `NEW` (Task 8A-S solvency amendment, August 28, 2026)
- **Definition:** Helper-confirmed inflows minus helper-confirmed real outflows
  equal remaining liability for that exact `(circle, round, token)`. No
  cross-round or cross-token borrowing is permitted. Any unresolved round
  deficit locks full payout. Final recovery is the immutable net-funded amount:
  `scheduled payout - sum(exact uncured deficits in that round)`.
- **Historical separation:** nominal payout, recipient, `MISSED_DEFAULT`, cure
  records, and derived recovery amount remain separate.
- **Enforcement point:** round ledger, full-funding gate, deterministic recovery
  derivation, and same-round debit check.
- **Test:** `test_settlement_boundary.cairo`.

## INV-024 — Zero-funded recovery never fabricates settlement

- **Origin:** `NEW` (Task 8A-S zero-funded edge, August 28, 2026)
- **Definition:** When final preparation derives a same-round recovery amount
  of zero, the payout becomes terminal `NoFundedRecovery`. Its recipient,
  nominal payout, defaults, and zero recovery amount remain immutable. No
  signature, nonce, output note, `Paid`, `Recovered`, or token action is used.
- **Enforcement:** The status is selected only from the stored final-preparation
  calculation; helper recovery accepts only positive `RecoveryPending` state.
- **Test:** `test_settlement_boundary.cairo`.

## Legacy invariants superseded or removed

| Legacy property | Legacy source | Disposition |
|---|---|---|
| Full-round funding gate before any payout (`RoundNotFunded`) | `lib.rs:406-420` | `LEGACY-CHANGED` → deficit-based rules (INV-009). All-or-nothing lock removed. |
| Binary on-time flag; late accepted unflagged-by-grace | `lib.rs:331-334` | `LEGACY-CHANGED` → three-state model (INV-018). |
| Implicit payout rotation by join order | `lib.rs:368-369` | `LEGACY-CHANGED` → locked order (INV-001, INV-015). |
| Permissionless round advancement | `lib.rs:353-380` | `LEGACY-CHANGED` → controlled progression (INV-007); authorization to be designed. |
| History-writable demo seam (`seed_contribution`) | `lib.rs:524-543` | `REMOVED` — conflicts with INV-004. |
| Self-asserted reputation numbers in proofs | `zk.ts:62-64` | `REMOVED` — conflicts with INV-011. |
| Any-token acceptance | `lib.rs:210-218` | `REMOVED` → allowlist (INV-008). |
| Membership per-member-per-circle collection nullifier | `lib.rs:422-426` | `LEGACY-CHANGED` → per-round payout uniqueness (INV-003). |

---

## Invariant-to-legacy-test mapping

| Planned Cairo test | Legacy test that demonstrated the property |
|---|---|
| contribution uniqueness | `test.rs:221-225` (`AlreadyPaid`) |
| payout uniqueness | `test.rs:273-277, 298-302` (`AlreadyCollected`) |
| membership rules | `test.rs:138-147` (duplicate/full), `test.rs:226-232` (non-member) |
| wrong round | `test.rs:233-237` |
| round monotonicity | `test.rs:285-307` |
| funding gate (changed form) | `test.rs:310-348` |
| on-time boundary | `test.rs:207-219` |
| reputation derivation | `test.rs:392-503` |
| id sequencing | `test.rs:67-89` |
| config validation | `test.rs:91-106` |
| trust-gate errors (context) | `test.rs:150-183` |

---

## Open questions before implementation

Resolved (August 27, 2026): deficit-fallback state machine and grace timing
semantics are locked — see INV-009, INV-018, INV-020, and `ARCHITECTURE.md`
"Grace periods" / "Deficit handling".

Resolved (August 28, 2026): STRK20 financial nonces are consumed only through
the pinned helper, and payout/recovery signatures bind the rightful member's
open-note destination. See INV-022 and INV-023.

Resolved (August 28, 2026): cure-rule parameters are locked — see
`ARCHITECTURE.md` "Deficit handling" and `CureConfig` in
`contracts/starknet/src/iwa_types.cairo`. Execution remains Task 6F.

## Last updated

August 28, 2026 — Task 6A locked cure-rule parameters on the circle
configuration (`CureConfig`). Status: defined; cure *execution* is not yet
implemented.

# IWA — Status

## Current phase

**Phase 3 — contribution accounting and defaults (Task 6E complete)**

Circles can be created and joined by proving an off-chain invite secret
against Poseidon commitments stored in the locked payout order.
The payout order is written only during circle creation and has no callable
mutation path after creation. Joins and activation leave it unchanged.
Joined members register an immutable IWA-specific Stark-curve public key used
to sign domain-separated, obligation-scoped contribution authorizations.
Activation now creates exactly one contribution obligation per circle, round,
and member, each carrying the circle's locked asset and required amount.
Members satisfy the current round's obligation with a signed, nonce-bound
authorization that is verified and consumed atomically, producing an ON_TIME
or LATE_WITHIN_GRACE transition. An obligation still unpaid strictly after its
grace deadline can be finalized as MISSED_DEFAULT by any caller, derived from
immutable obligation state and the contract clock alone.
Contribution state is accounting only: real ERC-20/STRK20 settlement is
intentionally not implemented yet. Payout execution, pause, cure execution,
and STRK20 `privacy_invoke` are not implemented.

No Stellar/Soroban or ZK code has been deleted. `iwa-web/` was not modified
in Task 6E.

## STRK20 Private Sprint registration

Registration has been submitted through the official STRK20 hackathon registry pull request.

Project repository:

`https://github.com/solutionkanu12/iwa`

Telegram:

`solution_o1`

Registration PR:

`https://github.com/starkience/strk20-hackathon/pull/219`

Current known state at time of setup:

- PR created successfully
- PR is open
- PR is mergeable
- one registry file changed
- one IWA registry entry added
- no second registration PR should be created

## Hackathon target

Build IWA for the STRK20 Private Sprint using:

- Starknet Mainnet
- Cairo
- STRK20
- USDC
- STRK

The required project manifest exists at the repository root:

`strk20.json`

Initial structure:

```json
{
  "transactions": [],
  "contracts": [],
  "demo_video": "",
  "demo_url": ""
}
```

The manifest must later contain:

- at least three qualifying Starknet Mainnet transaction hashes touching the STRK20 pool
- deployed IWA contract addresses
- 3-minute demo video link
- demo URL if required

## Installed STRK20 skills

The STRK20 skill package has been installed with:

```bash
npx skills add welttowelt/strk20-skills
```

Installed skills:

- `strk20-privacy`
- `strk20-wallet-api`
- `strk20-anonymizer-contracts`
- `strk20-privacy-sdk`

Important rule:

Before implementing STRK20 protocol behavior, read the relevant installed skill and its bundled upstream references.

Do not implement STRK20 behavior from memory.

## Locked architecture decisions

### Multichain model

IWA uses native implementations per chain behind one chain-neutral domain specification.

Current target:

- Starknet → Cairo + STRK20

Future possible implementations:

- EVM → Solidity
- Solana → Rust
- other chains → native implementation

Starknet is the first production implementation, not the permanent canonical chain.

### Backend/indexer

Use a small chain-neutral backend/indexer for:

- public indexing
- notifications
- analytics
- contract health
- public metadata
- business metrics

The backend must never hold:

- private keys
- wallet seeds
- viewing keys
- signing material
- private contribution history
- private transfer graphs
- raw credential evidence

### Assets

Initial assets:

- USDC
- STRK

No arbitrary-token support in the first release.

### Circle membership

Initial circle model:

- private
- invite-based
- controlled membership

No open public liquidity-pool-style circles in the first MVP.

### Payout order

Payout order is agreed at circle creation.

Once contributions begin:

- payout order is immutable
- admin cannot change recipients
- admin cannot redirect funds

### Contribution reliability states

Locked states:

- `ON_TIME`
- `LATE_WITHIN_GRACE`
- `MISSED_DEFAULT`

Contribution history is immutable.

### Missed contribution behavior

A member receives a predefined grace window.

If unresolved:

- the missed contribution becomes a default
- the history remains immutable
- the circle continues under predefined rules

### Deficit behavior

If a member reaches their payout turn with an unresolved deficit:

- payout remains locked
- deficit may be cured under predefined rules
- fallback logic must be deterministic
- admin cannot redirect the payout arbitrarily

### Public data

Only minimal non-sensitive metadata should be public/indexable.

Private information includes:

- member identity
- wallet-to-person mapping
- individual financial history
- private contribution details
- private payout relationships
- balances
- viewing keys
- private financial graph

### Portable Trust Credential

The credential exposes a scoped claim only.

Example:

`completed at least 3 savings cycles with no defaults`

Do not expose raw savings history.

Do not create a universal numerical credit score.

### Privacy strategy

Use STRK20-native privacy and selective disclosure first.

The previous Circom/Groth16 system remains preserved until protocol research determines whether a separate ZK reputation proof is still necessary.

Do not port the previous ZK architecture blindly.

### Admin permissions

Admin may have limited operational permissions.

Admin must never be able to:

- seize user funds
- redirect payouts
- modify payout order
- rewrite history
- erase defaults
- forge credentials
- access viewing keys
- access private savings history

### Emergency pause

Use a narrowly scoped emergency pause.

The pause may stop risky new operations such as:

- new joins
- new contributions

The pause must not enable:

- fund seizure
- arbitrary payout redirection
- history changes
- permanent custodial lockout

### Admin dashboard

IWA will include a non-custodial admin dashboard.

Planned surfaces:

- platform overview
- public circle metrics
- contract health
- transaction health
- operational alerts
- failed transaction monitoring
- support tooling
- audit logs
- verification usage
- subscription metrics
- revenue metrics
- maintenance controls
- narrowly scoped pause controls

### Revenue model

Locked revenue rails:

1. B2B credential verification
2. IWA Pro circles
3. enterprise and white-label infrastructure
4. optional protocol and partner revenue

Core business principle:

**IWA monetizes verification and infrastructure, not private financial data.**

## Current repository state

The repository currently contains the previous Stellar implementation.

Known important paths:

```text
ARCHITECTURE.md
README.md
iwa-PRD.md.md

iwa-circuit/
iwa-prover/
iwa-savings/
iwa-verifier/
iwa-web/
toolchain-test/
```

## Migration classification

### KEEP / ADAPT

`iwa-web/`

Preserve:

- frontend foundation
- mobile-first product
- design system
- cowrie identity
- verified moment
- non-chain UI logic where clean

Replace Stellar-facing integrations.

### REPLACE IMPLEMENTATION, PRESERVE BUSINESS LOGIC

`iwa-savings/`

Current implementation is Soroban/Rust.

Before removal, extract:

- circle state machine
- membership rules
- contribution behavior
- payout rules
- edge cases
- useful tests
- business invariants

Then rebuild in Cairo.

### HOLD FOR RESEARCH

`iwa-circuit/`

`iwa-prover/`

Do not delete yet.

Determine whether STRK20 already provides enough privacy/selective disclosure for the MVP.

Keep only if an additional reputation proof provides a necessary capability.

### REPLACE

`iwa-verifier/`

Current verifier is Soroban-specific.

Do not mechanically translate it to Cairo.

Build a new Starknet verifier only if the final credential architecture requires one.

### RETIRE LATER

`toolchain-test/`

Old Stellar/Soroban toolchain validation.

Remove only after the new Starknet environment is proven.

### REWRITE

`ARCHITECTURE.md`

Current document is Stellar/Soroban-specific.

Rewrite around:

```text
IWA Core
→ Chain Interface
→ Starknet Adapter
→ Cairo Contracts
→ STRK20
```

plus:

- backend/indexer
- admin dashboard
- frontend
- future chain adapters

### RETIRE AFTER EXTRACTION

`iwa-PRD.md.md`

The old PRD contains useful:

- product positioning
- user flows
- design system
- product copy
- privacy thesis

But its technical architecture and hackathon context are obsolete.

Do not use it as the current source of truth.

## Legacy behavior extraction

Extraction task complete (plan Task 3 first pass).

Created:

- `docs/domain/LEGACY_BEHAVIOR.md` — observed legacy business behavior with
  per-behavior `KEEP` / `CHANGE` / `REMOVE` / `HOLD` decisions, edge cases,
  and UNKNOWN items
- `docs/domain/IWA_INVARIANTS.md` — chain-neutral invariants (INV-001 through
  INV-019) with origins, enforcement points, and planned tests

What passed:

- every legacy behavior cited to exact source lines in
  `iwa-savings/contracts/savings/src/lib.rs` and `test.rs`
- reputation/credential semantics extracted from `iwa-circuit/`,
  `iwa-prover/`, `iwa-verifier/`, and the frontend seams (read-only evidence)
- legacy behaviors classified against the approved rules in `PROJECT.md` /
  `ARCHITECTURE.md` / `SECURITY.md`
- demo seam `seed_contribution` recorded for removal; no admin powers exist
  in the legacy contract (recorded, replaced by the approved non-custodial
  admin model)

What failed / not done:

- no implementation code modified
- no Cairo written
- no legacy files deleted
- no frontend touched

State-machine blockers — RESOLVED (locked August 27, 2026):

- grace timing: Starknet block timestamp in seconds; one authoritative
  contract-side timestamp source; `now <= due_at` → `ON_TIME`,
  `due_at < now <= grace_ends_at` → `LATE_WITHIN_GRACE`,
  `now > grace_ends_at` without valid settlement → `MISSED_DEFAULT`
  (recorded in `ARCHITECTURE.md` "Grace periods", `IWA_INVARIANTS.md`
  INV-018)
- deficit payout fallback: no redirect; payout marked `DEFERRED/LOCKED`;
  circle continues; member cures then claims; admin cannot replace or
  release; uncured deficit at final settlement follows a deterministic
  recovery/refund path with no admin discretion (recorded in
  `ARCHITECTURE.md` "Deficit handling", `IWA_INVARIANTS.md` INV-009, INV-020)

Remaining open items (not state-machine blockers):

- legacy trust-gate proof binding gaps (root/nullifier/leaf) documented;
  binding must be closed if a proof layer is rebuilt
- exact cure-rule parameters (what constitutes a cure, window, accounting
  effect) still to be specified before Cairo — the state machine is locked,
  the parameter values are not

Next after extraction was plan Task 4 (complete — see below).

## Chain-neutral IWA Core (plan Task 4)

Task 4 complete (reviewed and finished from the existing uncommitted tree).

Created / kept:

- `iwa-web/src/core/domain/types.ts` — ContributionStatus, CircleStatus,
  SupportedAsset, Circle, Member, ContributionObligation, PayoutState,
  CredentialClaim
- `iwa-web/src/core/domain/contributionStatus.ts` — INV-018 classifier
- `iwa-web/src/chains/types.ts` — ChainAdapter interface
- colocated Vitest tests for domain types, grace classification, and the
  adapter contract
- `iwa-web/vitest.config.ts` — node environment, core/chains test globs only

What passed:

- `iwa-web` `npm test` — 19 tests, 3 files, all passed
- `iwa-web` `npx tsc -b` — exit 0
- `iwa-web` `npm run build` — `tsc -b && vite build` exit 0
- no CSS / layout / screen / asset files changed
- no Starknet felt/address/RPC types in `iwa-web/src/core/`

What was not done (out of Task 4 scope):

- no Cairo workspace
- no Stellar code deleted
- no UI wired to the new core
- not committed, not pushed

Vitest was kept: Task 4 requires runtime tests of INV-018 classification and
the adapter contract; the frontend had no test runner; Vitest matches the
existing Vite toolchain. Removing it would drop those tests or add a
different new runner.

Next after Task 4 was plan Task 5 (complete — see below).

## Phase plan

### Phase 0 — Preservation and control

Complete (control docs, skills, strk20.json, legacy preserved).

Goals:

- preserve legacy implementation
- create project-control docs
- record architecture decisions
- secure repo configuration
- confirm STRK20 setup
- avoid destructive migration

### Phase 1 — STRK20 protocol research

Read the installed STRK20 skills and upstream references.

Required outputs:

- exact shielding flow
- exact private contribution route
- exact payout route
- exact helper-contract interface
- exact wallet integration
- exact transaction ordering requirements
- exact selective disclosure capability
- decision on whether the old ZK credential layer is still needed

No implementation from memory.

### Phase 2 — Chain-agnostic IWA Core

Task 4 complete (interfaces defined). Remaining Phase 2 application
services can wait until a Starknet adapter exists.

Extract and define:

- circle domain model
- member model
- rounds
- obligations
- contribution status
- payout state
- admin permissions
- credential claims
- chain interface
- core invariants

No Starknet-specific types inside the core.

### Phase 3 — Cairo IWA circle contracts

Task 5 complete (workspace). Task 6A complete (creation). Task 6B complete
(membership). Task 6C complete (fixed payout-order immutability). Task 6D-A
complete (member authorization foundation). Task 6D complete (authenticated
contribution obligations with atomic nonce consumption). Task 6E complete
(post-grace default finalization). Next is Task 6F cure execution.

Build and verify:

- circle creation
- invite membership
- fixed payout order
- grace/default behavior
- deficit handling
- admin boundaries
- emergency pause
- accounting invariants

### Phase 4 — STRK20 helper integration

Build the privacy-critical integration.

Target flow:

```text
shield
→ private contribution
→ IWA STRK20 helper
→ IWA circle state transition
```

and private payout flow.

This phase requires additional security review.

### Phase 5 — Starknet frontend adapter

Replace:

- Stellar wallet
- Stellar SDK
- Stellar network copy
- Soroban transaction calls
- Stellar explorer references

with Starknet/STRK20 equivalents.

Preserve the product UI unless redesign is intentionally approved.

### Phase 6 — Backend/indexer and admin MVP

Build only the useful first version:

- public event indexing
- contract health
- transaction monitoring
- admin authentication
- audit logs
- public metrics
- verification usage
- revenue placeholders

No private financial data.

### Phase 7 — Portable Trust Credential

Choose one path only after STRK20 research.

#### Path A

STRK20-native disclosure satisfies the MVP.

Use the simplest secure solution.

#### Path B

A separate privacy-preserving reputation proof is necessary.

Then adapt or rebuild the smallest justified ZK credential system.

### Phase 8 — Full security audit

Required:

- Cairo review
- access-control review
- state-machine audit
- accounting-invariant review
- STRK20 integration audit
- privacy leakage review
- fuzz testing
- invariant testing
- integration testing
- frontend privacy review
- backend boundary review
- deployment review

Findings must be concrete.

### Phase 9 — Starknet Mainnet

Only after audit gates pass.

Verify:

- `SN_MAIN`
- official STRK20 pool
- USDC address
- STRK address
- deployed class hashes
- role configuration
- environment configuration

Start with minimal-value transactions.

Record successful qualifying transactions in `strk20.json`.

### Phase 10 — Demo and submission

Deliver:

- working public demo
- Starknet Mainnet interactions
- qualifying STRK20 transactions
- contract addresses
- `strk20.json`
- 3-minute demo video
- accurate README
- final audit summary
- polished demo flow

## Starknet Cairo workspace (plan Task 5)

Task 5 complete.

Created:

- `contracts/starknet/Scarb.toml` — package `iwa`, edition `2024_07`
- `contracts/starknet/.tool-versions` — scarb 2.18.0, starknet-foundry 0.63.0
- `contracts/starknet/src/lib.cairo`
- `contracts/starknet/src/iwa_types.cairo`
- `contracts/starknet/src/iwa_errors.cairo`
- `contracts/starknet/src/iwa_events.cairo`
- `contracts/starknet/tests/test_smoke.cairo`
- `contracts/starknet/Scarb.lock`

Pinned from `starkware-libs/starknet-privacy` (verified, not memory):

- scarb 2.18.0 / cairo 2.18.0
- starknet 2.17.0
- snforge_std 0.63.0 / snforge 0.63.0
- assert_macros 2.17.0
- edition 2024_07

What passed (WSL Ubuntu, because snforge has no Windows binary):

- `scarb fmt --check` — exit 0
- `scarb build` — exit 0, no compiler warnings after Store-default allow
- `snforge test` — 6 passed, 0 failed
- no `iwa-web/` changes in this task
- no legacy deletions

Expected remaining snforge warning until Task 6 adds a contract:

`external contracts not found for selectors: iwa::*`

What was not done (out of Task 5 scope):

- no `IwaCircle` state machine
- no `privacy_invoke` helper
- not committed, not pushed

Next after Task 5 was plan Task 6A (complete — see below).

## IwaCircle creation (plan Task 6A)

Task 6A complete (TDD).

Created:

- `contracts/starknet/src/iwa_circle.cairo` — create + views only
- `contracts/starknet/tests/test_circle_creation.cairo`

Updated:

- `contracts/starknet/src/iwa_types.cairo` — `CureConfig` / eligibility /
  window / amount (locked MVP rules, no cure execution)
- `contracts/starknet/src/lib.cairo` — exports `iwa_circle`
- `contracts/starknet/Scarb.toml` — `[[target.starknet-contract]]`
- `ARCHITECTURE.md` / `docs/domain/IWA_INVARIANTS.md` — cure-rule lock

What passed (WSL Ubuntu):

- `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test` — 21 passed, 0 failed
- no `iwa-web/` changes
- no legacy deletions

What was not done (out of 6A scope):

- no join / invite acceptance
- no contributions
- no payout execution or cure execution
- no STRK20 helper
- not committed, not pushed

Next after Task 6A was plan Task 6B (complete — see below).

## IwaCircle membership (plan Task 6B)

Task 6B complete (TDD), including invite-secret join hardening.

Created:

- `contracts/starknet/tests/test_membership.cairo`

Updated:

- `contracts/starknet/src/iwa_circle.cairo` — `join_circle(invite_secret)`
  hashes with `invite_commitment` before invite-list lookup; does not bind
  `get_caller_address()`
- `contracts/starknet/src/iwa_types.cairo` — `INVITE_DOMAIN_TAG` /
  `invite_commitment` (Poseidon, `'IWA_INVITE_V1'`)
- `contracts/starknet/src/iwa_events.cairo` — `CircleActivated`;
  `MemberJoined` emits commitment + slot, never the secret

Security fix: knowing a stored member commitment is no longer enough to join.
Join requires the invite preimage.

What passed (WSL Ubuntu):

- `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test` — 33 passed, 0 failed
- no `iwa-web/` changes
- no legacy deletions

What was not done (out of 6B scope):

- no pause (6G)
- no contributions / grace execution
- no payout or cure execution
- no STRK20 helper
- not committed, not pushed

Task 6C complete (TDD/invariant verification).

Created:

- `contracts/starknet/tests/test_payout_order.cairo`

Verified guarantees:

- payout order exactly matches its creation-time input
- payout order remains unchanged after one join and after activation
- payout-order storage is isolated between circles
- organizer and member callers cannot replace or reorder entries
- no callable entrypoint can mutate payout-order storage after creation
- duplicate and zero payout-order references remain rejected at creation

Security review:

- `payout_order` and `payout_order_len` have exactly one intended write path:
  internal `store_payout_order`, called only by `create_circle`
- `join_circle` writes membership state and the circle record only; it does
  not write either payout-order storage map
- the public ABI contains no payout-order setter, replacement, reorder, or
  generic storage mutation entrypoint
- absence of a mutating API is the enforcement mechanism; no rejection-only
  reorder API was added
- no organizer/admin bypass was found
- no contract-code change was required for Task 6C

What passed (WSL Ubuntu):

- `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test test_payout_order` — 9 passed, 0 failed
- `snforge test` — 42 passed, 0 failed
- no `iwa-web/` changes
- no legacy deletions

What was not done (out of 6C scope):

- no contributions or obligation execution
- no grace/default execution
- no payout or cure execution
- no pause
- no STRK20 helper or `privacy_invoke`
- not committed, not pushed

Task 6D-A complete (TDD): privacy-preserving member authorization foundation.

Created:

- `contracts/starknet/tests/test_member_authorization.cairo`

Updated:

- `contracts/starknet/src/iwa_circle.cairo` — join-time immutable auth-key
  registration and read-only lookup
- `contracts/starknet/src/iwa_types.cairo` — domain-separated contribution
  authorization hash and canonical Stark-curve signature verification
- `contracts/starknet/src/iwa_errors.cairo` — invalid auth-key error
- membership and payout-order regression tests for the extended join ABI
- `ARCHITECTURE.md`, `SECURITY.md`, and `docs/domain/IWA_INVARIANTS.md` — locked
  member authorization and Task 6D/Task 8 binding rules

Verified model:

- join still requires the invite preimage and also registers a structurally
  valid Stark-curve authentication public key
- the auth key is independent of `get_caller_address()` and is immutable
- no private auth key or invite secret is stored or emitted
- contribution authorization hashes bind `IWA_CONTRIBUTION_V1`, circle, round,
  member ref, exact amount, and nonce
- verification uses Cairo 2.18.0 corelib `check_ecdsa_signature` with explicit
  Stark-curve range and canonical low-`s` checks
- Task 6D must atomically consume the signed nonce with the obligation
  transition; Task 8 must bind that transition to the pool-only helper call

What passed (WSL Ubuntu):

- `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test test_member_authorization` — 16 passed, 0 failed
- `snforge test` — 58 passed, 0 failed
- no `iwa-web/` changes
- no legacy deletions

Still intentionally absent:

- contribution obligations/state transitions and nonce consumption
- ERC-20 or STRK20 token movement
- `privacy_invoke`, payouts, cure execution, and pause
- not committed, not pushed

## IwaCircle authenticated contributions (plan Task 6D)

Task 6D complete (TDD) and fully verified.

Created:

- `contracts/starknet/tests/test_contributions.cairo`

Updated:

- `contracts/starknet/src/iwa_circle.cairo` — obligation creation at
  activation, `satisfy_contribution`, and the obligation / nonce read views
- `contracts/starknet/src/iwa_types.cairo` — `ContributionObligation` now
  carries the locked `asset` and `required_amount`
- `contracts/starknet/src/iwa_errors.cairo` — invalid-signature, wrong-amount,
  nonce-used, already-satisfied, obligation-not-found, and closed-window errors
- `contracts/starknet/src/iwa_events.cairo` — `ContributionRecorded` renamed to
  `ContributionStateUpdated`, documented as an accounting transition that does
  not assert settlement
- `contracts/starknet/tests/test_smoke.cairo` — obligation fixture updated for
  the extended struct

Verified model:

- authenticated contribution obligations are implemented
- exactly one obligation exists per circle, round, and member; obligations are
  created once at activation and re-creation is rejected
- each obligation locks the circle's exact asset and required amount; any
  amount that is not the locked amount is rejected, including zero
- only the current round can be satisfied; past, non-current, and future rounds
  are rejected, as is any call while the circle is not `Active`
- satisfaction requires a valid Stark-curve signature from the member's
  registered authorization key over the domain-separated hash binding circle,
  round, member ref, exact amount, and nonce; wrong circle, round, amount, or
  member signatures are all rejected
- the signed nonce is consumed atomically with the obligation transition,
  giving replay protection; a reused nonce is rejected even for an otherwise
  valid authorization, a failed transaction consumes no nonce, and duplicate
  satisfaction fails even with a fresh nonce
- `now <= due_at` produces `ON_TIME`; `due_at < now <= grace_ends_at` produces
  `LATE_WITHIN_GRACE` at the inclusive boundary; a closed window is rejected
- contribution changes neither payout order nor membership, and the organizer
  has no contribution bypass

Intentionally not implemented:

- real ERC-20 / STRK20 token settlement — contribution state is accounting
  only and does not assert that any tokens moved
- `MISSED_DEFAULT` transition, payouts, cure execution, pause, and
  `privacy_invoke`

What passed (WSL Ubuntu):

- `scarb fmt` and `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test test_contributions` — 18 passed, 0 failed
- `snforge test` — 76 passed, 0 failed
- no `iwa-web/` changes
- no legacy deletions
- not committed, not pushed

Task 6E followed (see below).

## IwaCircle post-grace default finalization (plan Task 6E)

Task 6E complete (TDD) and fully verified.

Created:

- `contracts/starknet/tests/test_defaults.cairo`

Updated:

- `contracts/starknet/src/iwa_circle.cairo` — `finalize_contribution_default`
- `contracts/starknet/src/iwa_errors.cairo` — `GRACE_NOT_EXPIRED`

`iwa_types.cairo` and `iwa_events.cairo` needed no change: `MISSED_DEFAULT`
already existed as a locked reliability state, and `ContributionStateUpdated`
already carries the resulting status, so no new event surface was introduced.

Finalization model:

- one new entrypoint, `finalize_contribution_default(circle_id, round,
  member_ref)`, returning the resulting `ContributionStatus`
- permissionless: any caller may finalize, because the outcome derives only
  from immutable obligation state plus the contract-side block timestamp
- the caller supplies only the obligation coordinates; member, status,
  deadline, amount, and asset are all read from storage and none of them are
  caller-influenced
- the obligation must exist for the exact `(circle_id, round, member_ref)`;
  unknown circle, round, or member is rejected
- only a `PENDING` obligation may transition; every other status is rejected
  as `IWA: history immutable`
- no token movement, no payout, no cure execution, no `privacy_invoke`

Boundary semantics (INV-018):

```text
now <= due_at                  -> ON_TIME            (satisfy path)
due_at < now <= grace_ends_at  -> LATE_WITHIN_GRACE  (satisfy path)
now == grace_ends_at           -> not defaultable
now >  grace_ends_at           -> MISSED_DEFAULT     (finalize path)
```

`grace_ends_at` itself stays curable by a late contribution; the first second
strictly after it is the first defaultable timestamp.

Security review:

- every write to `obligations` is guarded: creation asserts the obligation does
  not already exist, and `satisfy_contribution` and
  `finalize_contribution_default` each assert `status == Pending` first
- the only status transitions that exist are `PENDING -> ON_TIME`,
  `PENDING -> LATE_WITHIN_GRACE`, and `PENDING -> MISSED_DEFAULT`; there is no
  reverse or rewrite edge, and no path clears `obligation_exists`
- both deadlines are stored on the obligation at round creation from one
  contract-side `get_block_timestamp()` read; no caller-supplied time exists
  anywhere in the contract
- `get_caller_address()` is read only at circle creation to record the
  organizer, and that field is never consulted for authorization, so no admin
  or organizer privilege exists in the contract at all
- no ERC-20, transfer, approve, external contract call, library call, class
  replacement, or `privacy_invoke` surface exists under
  `contracts/starknet/src`
- the emitted event carries `circle_id`, `round`, `member_ref`, and `status`
  only — no wallet address, auth key, or invite secret

What passed (WSL Ubuntu):

- `scarb fmt` and `scarb fmt --check` — exit 0
- `scarb build` — exit 0
- `snforge test test_defaults` — 19 passed, 0 failed
- `snforge test` — 95 passed, 0 failed
- `git diff --check` — exit 0
- no `iwa-web/` changes
- no legacy deletions
- not committed, not pushed

Still intentionally absent:

- real ERC-20 / STRK20 settlement
- cure execution (Task 6F), payouts, pause, and `privacy_invoke`

## STRK20 pool integration (Task 8B)

Task 8B proved the Task 8A settlement helper against the **real pinned STRK20
pool**, not a hand-written stand-in. `privacy::privacy::Privacy` from
`66e3caae8c0201227a6719696d004e30d90aea65` is deployed locally and driven
through its own `apply_actions` server-action entrypoint, so contribution,
cure, payout, recovery, `NoFundedRecovery`, and rollback are all exercised over
genuine protocol code: real calldata forwarding to `privacy_invoke`, real
token movement, real `OpenNoteDeposit` crediting, real revert propagation.

Verified behavior is recorded in `docs/strk20/INTEGRATION_RESEARCH.md`. No
contradiction was found between the pinned protocol source and the helper.

### Finding 8B-01 — fixed

A 1-unit ERC20 donation to the helper used to make `assert_exact_inbound_balance`
reject every later contribution and cure in that token, permanently and
unrecoverably. Confirmed by test against the real pool, then fixed under the
approved Option B: exact inbound accounting is unchanged, and a narrowly scoped
permissionless `normalize_surplus(token)` moves only unaccounted surplus to an
immutable sink pinned at deployment. Surplus is never liability, never funds a
settlement, and legitimate backing can never be swept.

The helper constructor now takes a fifth immutable argument, `surplus_sink`.

### Finding 8B-02 — closed operationally in Task 8C

`scarb build` still emits StarkWare's `Privacy` class into `target/dev`,
because `build-external-contracts` sits on the package target so integration
tests can declare the genuine pool. The risk that IWA deploys it is now closed
in tooling rather than in the Scarb layout: `deploy/iwa-deploy.sh` acts only on
an explicit two-name allowlist, keeps `Privacy` on a forbidden list, and never
enumerates artifacts. Proven by `deploy/test-iwa-deploy.sh`.

## Deployment safety preparation (Task 8C)

Preparation only. Nothing was deployed and no transaction was sent.

`contracts/starknet/deploy/` now holds `iwa-deploy.sh` (validate / plan /
verify / gated deploy), `test-iwa-deploy.sh` (27 offline assertions),
`deploy.config.example.json`, and `README.md` carrying the surplus-sink policy
and the approved deployment order.

Mainnet addresses were re-verified on 2026-08-29 by read-only calls against
`SN_MAIN`, recorded with sources in `docs/strk20/INTEGRATION_RESEARCH.md`:

- pool `0x0403…812a` answers `get_version() = "2.0"`, matching the pinned
  revision's `CONTRACT_VERSION`
- native USDC `0x0330…35fb` reports symbol `USDC`, **6 decimals**
- STRK `0x0471…938d` reports symbol `STRK`, 18 decimals

New operational finding: the live pool charges **6 STRK per `apply_actions`
call**, pulled from the caller. Local tests used a zero-fee pool, so this cost
is absent from them.

## Pre-deployment security audit (Task 8)

A full pre-deployment audit was performed against the Cairo contracts, the
STRK20 integration and the deployment tooling. Counts: 0 Critical, 1 High,
3 Medium, 2 Low, 4 Informational.

### IWA-01 (High) - FIXED

`join_circle` identified a member only by `H(TAG, secret)` and registered a
caller-supplied authentication key, so the invite secret was a bearer
credential: whoever presented it first captured the slot and the key that
authorizes its contributions, cures, payouts and recoveries. Verified with a
passing proof of concept before the fix.

The commitment is now `H(TAG, secret, auth_public_key)`. A stolen secret alone
matches no slot. `member_ref` is still one felt, so obligations, nonces, payout
order and every signature path are unchanged, and membership remains unbound to
any Starknet caller address. Regression coverage lives in
`tests/test_audit_findings.cairo`.

Onboarding change: the organizer must collect each member authentication public
key before creating the circle.

### IWA-02 (Medium) - FIXED

`create_circle` now enforces `2 <= member_limit <= 32`. Final settlement is
O(member_limit^2) in storage reads with no resumable path, so an unbounded size
could have made that terminal call unexecutable and stranded the circle.

### IWA-03 (Medium) - FIXED

The mainnet pool charges a fee per `apply_actions`, paid by the caller, and no
test previously exercised it. The integration harness now configures the
genuine pool with a non-zero fee through its own role-gated admin path and
proves an unfunded caller cannot settle, a funded one can, the exact fee is
collected, and fee movement never touches IWA custody or liability. The fee
value in tests is deterministic and is not a protocol invariant: production
code and runbooks must read `get_fee_amount()` live.

### Accepted risks

IWA-04 (artifact hygiene enforced by tooling convention), IWA-05 (transient
donation front-running), IWA-06 (pool blocked-depositor kill switch).

### Privacy claims corrected

`ARCHITECTURE.md` and `SECURITY.md` now state plainly that the invite secret
and `member_ref` are public, that the joining wallet can be correlated with its
`member_ref`, and that STRK20 protects settlement transfers rather than
membership. UI must not claim private membership.

## Immediate next work

1. Do not delete legacy code.
2. **Choose the `surplus_sink` address** — a dedicated IWA treasury multisig.
   It is immutable after deployment and is a hard blocker. No address is
   invented anywhere in this repository.
3. Choose the setup authority and prepare a funded deployer account holding
   STRK for pool fees.
4. Re-run `deploy/iwa-deploy.sh validate` immediately before deploying.
5. Run the Task 8 final security review.
6. STRK20 work must follow the verified integration research
   (`docs/strk20/INTEGRATION_RESEARCH.md`) — never from memory.

## Working rules

- no destructive deletion before replacement is verified
- no protocol implementation from memory
- no secrets in repository or logs
- review diffs before commits
- test every meaningful phase
- commit only verified work
- do not claim features that have not been demonstrated
- security findings must be recorded honestly
- keep IWA Core chain-neutral
- do not sacrifice STRK20 depth or mainnet correctness for cosmetic polish

## Last updated

August 29, 2026

Current state:

**Phase 4 Task 8B complete and locally verified. IWA settlement is proven
end-to-end against the real pinned STRK20 pool: contribution, cure, payout,
recovery, `NoFundedRecovery`, and full transaction rollback all execute over
genuine protocol code. Security finding 8B-01 (permanent donation denial of
service on inbound settlement) is confirmed and fixed under Option B via an
immutable-sink `normalize_surplus`, with exact inbound accounting preserved.
Local results: 8B focused 11 passed, 8A helper 7 passed, full suite 176
passed, 0 failed; `scarb fmt --check` and `scarb build` clean. Nothing is
committed, and nothing is deployed.

Task 8C added deployment safety preparation only: an explicit two-contract
artifact allowlist that can never deploy StarkWare's pool (closing 8B-02
operationally), configuration and network validation, the encoded deployment
order, and a documented immutable surplus-sink policy — with 27 offline tooling
assertions passing and the mainnet pool, USDC and STRK addresses re-verified by
read-only calls against SN_MAIN. No deployment was performed. The remaining
hard blocker is choosing the immutable `surplus_sink` treasury address. Next:
Task 8 final security review.**

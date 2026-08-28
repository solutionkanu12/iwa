# IWA — Status

## Current phase

**Phase 3 — IwaCircle fixed payout order (Task 6C complete)**

Circles can be created and joined by proving an off-chain invite secret
against Poseidon commitments stored in the locked payout order.
The payout order is written only during circle creation and has no callable
mutation path after creation. Joins and activation leave it unchanged.
Contributions, payout execution, pause, cure execution, and STRK20
`privacy_invoke` are not implemented.

No Stellar/Soroban or ZK code has been deleted. `iwa-web/` was not modified
in Task 6B.

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
(membership). Task 6C complete (fixed payout-order immutability). Next is 6D.

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

## Immediate next work

1. Do not delete legacy code.
2. Start Task 6D with failing tests for one contribution obligation per
   required member/round, wrong-round rejection, duplicate-satisfaction
   rejection, unsupported-asset rejection, and the valid state transition.
3. Do not implement grace/default behavior, payouts, or STRK20
   `privacy_invoke` as part of 6D.
4. STRK20 helper design must follow the verified integration research
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

August 28, 2026

Current state:

**Phase 3 Task 6C complete. Payout-order immutability is verified without a
contract change. Next: Task 6D — contribution obligations, beginning with
failing tests for uniqueness, round and asset validation, and the valid state
transition.**

# IWA STRK20 Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the existing working IWA product from its Stellar/Soroban implementation into a secure, chain-neutral IWA architecture with a native Starknet/Cairo implementation and deep STRK20 privacy integration, while preserving the existing frontend UI/UX.

**Architecture:** IWA business behavior lives in a chain-neutral domain/application layer. Starknet-specific wallet, RPC, STRK20 and Cairo behavior lives behind a Starknet adapter. A small backend/indexer supports public/non-sensitive operational data and a non-custodial admin dashboard. Legacy Stellar/Soroban and Circom components remain preserved until replacements are verified.

**Tech Stack:** TypeScript, React/Vite, Cairo/Starknet, STRK20, Starknet wallet tooling, existing IWA frontend stack, small chain-neutral backend/indexer selected during implementation, existing legacy Rust/Soroban and Circom code for behavioral reference only.

**Spec:** `PROJECT.md`, `ARCHITECTURE.md`, `DESIGN.md`, `SECURITY.md`, `STATUS.md`, `AGENTS.md`

## Global Constraints

- IWA is an existing working product, not a greenfield redesign.
- Preserve the existing `iwa-web/` visual design and UX unless a specific visual change is explicitly approved.
- Do not delete legacy Stellar/Soroban or ZK code until the replacement behavior is understood and verified.
- IWA Core must remain chain-neutral.
- Starknet-specific code belongs behind the Starknet adapter.
- Initial supported assets are USDC and STRK only.
- Initial circles are private/invite-based.
- Payout rotation becomes immutable once active contributions begin.
- Reliability states are `ON_TIME`, `LATE_WITHIN_GRACE`, and `MISSED_DEFAULT`.
- Admin is operational and non-custodial.
- Admin cannot seize funds, redirect payouts, rewrite financial history, erase defaults, reveal viewing keys, or forge credentials.
- Emergency pause is narrowly scoped.
- Backend/indexer stores only public or explicitly non-sensitive data.
- STRK20 protocol behavior must be read from installed skills/upstream references before implementation.
- Do not implement STRK20 from memory.
- Do not add a second ZK system unless STRK20 cannot provide the required credential capability.
- Security is a release gate.
- Mainnet interactions use minimal practical value.
- Never expose or commit secrets.
- Do not add agent attribution to commits.
- Update `STATUS.md` after every major verified phase.
- Do not claim anything passed, deployed, or works unless it has actually been verified.

---

# File Structure

## Existing files to preserve

```text
README.md
iwa-PRD.md.md

iwa-circuit/
iwa-prover/
iwa-savings/
iwa-verifier/
iwa-web/
toolchain-test/
```

These are preserved until the relevant migration task explicitly verifies their replacement.

## Project control files

```text
PROJECT.md
STATUS.md
ARCHITECTURE.md
DESIGN.md
SECURITY.md
AGENTS.md
CLAUDE.md
strk20.json
skills-lock.json
.agents/skills/
```

## Planned new implementation structure

The final exact structure may adapt to existing repository conventions, but the responsibilities must remain separated.

```text
contracts/
  starknet/
    Scarb.toml
    src/
      lib.cairo
      iwa_circle.cairo
      iwa_types.cairo
      iwa_errors.cairo
      iwa_events.cairo
      iwa_strk20_helper.cairo
    tests/
      test_circle_creation.cairo
      test_membership.cairo
      test_contributions.cairo
      test_rounds.cairo
      test_payouts.cairo
      test_grace_defaults.cairo
      test_admin_pause.cairo
      test_invariants.cairo
      test_strk20_helper.cairo

iwa-web/
  src/
    core/
      domain/
      application/
    chains/
      types.ts
      starknet/
        config.ts
        wallet.ts
        transactions.ts
        contracts.ts
        strk20.ts
        explorer.ts
    features/
      existing-feature-directories-preserved-where-possible

services/
  api/
  indexer/
  admin/
```

Do not create this entire tree in one scaffolding commit. Create each directory only when the task that needs it begins.

---

# Task 1: Complete Phase 0 Project Control and Baseline

**Files:**
- Modify: `STATUS.md`
- Modify: `.gitignore` only if necessary
- Review: `PROJECT.md`
- Review: `ARCHITECTURE.md`
- Review: `DESIGN.md`
- Review: `SECURITY.md`
- Review: `AGENTS.md`
- Review: `CLAUDE.md`
- Review: `strk20.json`
- Review: `skills-lock.json`
- Review: `.agents/skills/**`

**Interfaces:**
- Consumes: current repository state
- Produces: a verified clean baseline for all later work

- [ ] **Step 1: Inspect complete repository status**

Run:

```bash
git status --short
```

Expected:

- control docs appear as modified/untracked as appropriate
- `.agents/`, `skills-lock.json`, and `strk20.json` are visible
- no unexpected source-code changes exist

- [ ] **Step 2: Verify no secret files are about to be tracked**

Run:

```bash
git status --short
find . -maxdepth 3 -type f \( -name ".env" -o -name ".env.*" \) -print
```

Expected:

- real environment files may exist locally
- none should be intended for staging
- `.env.example` is allowed

- [ ] **Step 3: Inspect installed STRK20 skill inventory**

Run:

```bash
find .agents/skills -maxdepth 3 -type f -name 'SKILL.md' -print | sort
```

Expected:

```text
.agents/skills/strk20-anonymizer-contracts/SKILL.md
.agents/skills/strk20-privacy-sdk/SKILL.md
.agents/skills/strk20-privacy/SKILL.md
.agents/skills/strk20-wallet-api/SKILL.md
```

- [ ] **Step 4: Validate `strk20.json` syntax**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('strk20.json','utf8')); console.log('strk20.json valid')"
```

Expected:

```text
strk20.json valid
```

- [ ] **Step 5: Review project-control docs for contradictions**

Run:

```bash
grep -RniE 'Stellar|Soroban|credit score|redesign|custodial|private key|viewing key' \
  PROJECT.md STATUS.md ARCHITECTURE.md DESIGN.md SECURITY.md AGENTS.md CLAUDE.md
```

Review each match manually.

Expected:

- Stellar/Soroban appear only when discussing legacy migration
- `credit score` appears only as a prohibited framing
- no document claims the new Starknet implementation already exists
- no document authorizes custody or private-key storage
- no document authorizes a frontend redesign

- [ ] **Step 6: Update `STATUS.md` with Phase 0 completion**

Set current state to:

```text
Phase 0 complete.

Control docs created.
Legacy implementation preserved.
STRK20 skills installed.
strk20.json present.
No Starknet feature implementation started.
Next: Phase 1 STRK20 protocol research.
```

Do not mark anything else complete.

- [ ] **Step 7: Stage only Phase 0 control/setup files**

Run:

```bash
git add \
  PROJECT.md \
  STATUS.md \
  ARCHITECTURE.md \
  DESIGN.md \
  SECURITY.md \
  AGENTS.md \
  CLAUDE.md \
  strk20.json \
  skills-lock.json \
  .agents/skills
```

Do not stage legacy implementation changes.

- [ ] **Step 8: Review the full staged diff**

Run:

```bash
git diff --cached --stat
git diff --cached
```

Expected:

- only control docs, STRK20 skill files/lock and `strk20.json`
- no source-code migration
- no secrets
- no accidental binary/build files

- [ ] **Step 9: Commit Phase 0**

Run only after the review passes:

```bash
git commit -m "docs: establish IWA STRK20 rebuild baseline"
```

Do not add agent attribution.

- [ ] **Step 10: Verify commit**

Run:

```bash
git status
git log -1 --format='%h %an <%ae> %s'
```

Expected:

- working tree clean except intentionally untracked future plan files if any
- author is the project owner/team identity
- commit message is correct

---

# Task 2: STRK20 Protocol Research

**Files:**
- Read: `.agents/skills/strk20-privacy/SKILL.md`
- Read: `.agents/skills/strk20-wallet-api/SKILL.md`
- Read: `.agents/skills/strk20-anonymizer-contracts/SKILL.md`
- Read: `.agents/skills/strk20-privacy-sdk/SKILL.md`
- Create: `docs/strk20/INTEGRATION_RESEARCH.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: installed STRK20 skills and their referenced upstream documentation
- Produces: exact verified integration contract for Starknet implementation

- [ ] **Step 1: Read all four installed skill files**

Run:

```bash
cat .agents/skills/strk20-privacy/SKILL.md
cat .agents/skills/strk20-wallet-api/SKILL.md
cat .agents/skills/strk20-anonymizer-contracts/SKILL.md
cat .agents/skills/strk20-privacy-sdk/SKILL.md
```

Do not start implementation yet.

- [ ] **Step 2: Follow every upstream reference relevant to IWA**

Research must answer:

```text
1. What is the exact current STRK20 mainnet pool address?
2. What network identifier must be used?
3. How does a user obtain/use shielded USDC?
4. How does a user obtain/use shielded STRK?
5. Which wallet API is appropriate for a non-custodial dapp?
6. What is the exact transaction/action ordering?
7. How does privacy_invoke work?
8. What caller restrictions must an anonymizer/helper contract enforce?
9. How are private input/output notes represented?
10. Which fields can the IWA helper safely trust?
11. Which fields must be independently validated?
12. How are output note identifiers/amounts verified?
13. How can a private contribution trigger IWA state safely?
14. How can a payout return privately to a member?
15. Does STRK20 expose selective disclosure/viewing capabilities sufficient for a Portable Trust Credential?
16. What information is inevitably public?
17. What privacy leakage remains possible through timing, amounts or helper-state transitions?
18. What constitutes a qualifying mainnet STRK20 transaction for sprint submission?
```

No answer may be recorded as verified unless it is supported by current upstream documentation or a successful test.

- [ ] **Step 3: Create research document**

Create:

```text
docs/strk20/INTEGRATION_RESEARCH.md
```

Use this exact structure:

```markdown
# STRK20 Integration Research

## Verification status

## Mainnet network

## Official pool

## Supported asset addresses

### USDC

### STRK

## Wallet integration

## Shield flow

## Private transfer flow

## privacy_invoke / anonymizer flow

## Caller validation

## Action ordering

## Input/output note handling

## IWA private contribution design

## IWA private payout design

## Selective disclosure capability

## Remaining privacy leakage

## Mainnet submission requirements

## Open risks

## Decision: Legacy Circom/Groth16

KEEP / REMOVE / PARTIAL REUSE

Reason:
```

Replace the decision line with an actual evidence-backed decision when research is complete.

- [ ] **Step 4: Determine credential architecture**

Choose exactly one:

```text
A. STRK20-native disclosure is sufficient.
   Legacy Circom/prover becomes unnecessary for MVP.

B. STRK20 does not provide the required scoped reliability proof.
   Preserve only the minimal legacy proof concepts needed for a dedicated credential proof.
```

Do not choose B merely because the old implementation already exists.

- [ ] **Step 5: Security review the research**

Cross-check `SECURITY.md` against the integration findings.

Explicitly verify:

- caller restriction
- arbitrary-call risk
- replay model
- note/output trust assumptions
- public data leakage
- token validation
- state transition ordering

- [ ] **Step 6: Update `STATUS.md`**

Record:

- research complete
- exact STRK20 route chosen
- credential decision
- unresolved protocol risks
- next phase

- [ ] **Step 7: Commit research**

Run:

```bash
git add docs/strk20/INTEGRATION_RESEARCH.md STATUS.md
git diff --cached
git commit -m "docs: define verified STRK20 integration path"
```

---

# Task 3: Extract Legacy IWA Business Behavior

**Files:**
- Read: `iwa-savings/contracts/savings/src/lib.rs`
- Read: `iwa-savings/contracts/savings/src/test.rs`
- Read relevant supporting `iwa-savings/**`
- Read relevant `iwa-circuit/**`
- Read relevant `iwa-prover/**`
- Create: `docs/domain/LEGACY_BEHAVIOR.md`
- Create: `docs/domain/IWA_INVARIANTS.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: verified behavior from the existing working IWA implementation
- Produces: chain-neutral business specification for Cairo and frontend adapters

- [ ] **Step 1: Read legacy savings contract and tests**

Document actual behavior, not assumptions.

Extract:

- circle creation
- membership
- contribution requirements
- contribution timing
- payout progression
- completion
- error conditions
- storage semantics
- reputation-related inputs
- any admin or organizer powers

- [ ] **Step 2: Create legacy behavior record**

Create `docs/domain/LEGACY_BEHAVIOR.md`.

For each behavior use:

```markdown
## Behavior name

Source:
`exact/path`

Legacy behavior:
...

Keep / change / remove:
...

New chain-neutral behavior:
...

Reason:
...
```

- [ ] **Step 3: Define IWA invariants**

Create `docs/domain/IWA_INVARIANTS.md`.

At minimum include:

```text
INV-001 Payout order is immutable after activation.
INV-002 One obligation can be satisfied at most once.
INV-003 One round payout can execute at most once.
INV-004 Completed contribution history is immutable.
INV-005 Admin cannot redirect payout recipient.
INV-006 Admin cannot seize member funds.
INV-007 Round progression is monotonic.
INV-008 Unsupported assets cannot enter a circle.
INV-009 Deficit handling is deterministic.
INV-010 Pause cannot rewrite historical financial state.
INV-011 Credential claims cannot exceed valid underlying history.
INV-012 Backend/indexer data cannot override authoritative financial state.
```

For each invariant include:

- definition
- reason
- expected enforcement point
- planned test

- [ ] **Step 4: Record intentional behavior changes**

The new Starknet version must explicitly incorporate the locked decisions:

- private/invite-based first
- `ON_TIME`
- `LATE_WITHIN_GRACE`
- `MISSED_DEFAULT`
- deficit cure/lock rule
- narrow pause
- USDC + STRK allowlist
- scoped credentials

- [ ] **Step 5: Update `STATUS.md`**

Record extraction complete.

- [ ] **Step 6: Commit**

```bash
git add docs/domain/LEGACY_BEHAVIOR.md docs/domain/IWA_INVARIANTS.md STATUS.md
git diff --cached
git commit -m "docs: extract chain-neutral IWA domain behavior"
```

---

# Task 4: Define Chain-Neutral IWA Core Interfaces

**Files:**
- Create or adapt within `iwa-web/src/core/`
- Create: `iwa-web/src/chains/types.ts`
- Test: corresponding existing frontend test structure

**Interfaces:**
- Produces chain-neutral types used by later Starknet adapter and application services.

Minimum domain types:

```ts
export type ContributionStatus =
  | "PENDING"
  | "ON_TIME"
  | "LATE_WITHIN_GRACE"
  | "MISSED_DEFAULT";

export type CircleStatus =
  | "CREATED"
  | "OPEN_FOR_MEMBERS"
  | "ACTIVE"
  | "PAUSED_FOR_NEW_ACTIONS"
  | "COMPLETED";

export type SupportedAsset = "USDC" | "STRK";
```

Chain-neutral references must not require Starknet-specific felt/address types.

- [ ] **Step 1: Write failing unit tests for domain state behavior**
- [ ] **Step 2: Run tests and confirm failure**
- [ ] **Step 3: Add minimal chain-neutral types and state helpers**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Add chain-adapter interface**
- [ ] **Step 6: Typecheck frontend**
- [ ] **Step 7: Run existing frontend tests/build**
- [ ] **Step 8: Review for accidental Starknet coupling**
- [ ] **Step 9: Update `STATUS.md`**
- [ ] **Step 10: Commit**

Commit:

```bash
git commit -m "refactor: introduce chain-neutral IWA core"
```

Do not alter existing visual components except imports required by the refactor.

---

# Task 5: Create Starknet Cairo Workspace

**Files:**
- Create: `contracts/starknet/Scarb.toml`
- Create: `contracts/starknet/src/lib.cairo`
- Create: `contracts/starknet/src/iwa_types.cairo`
- Create: `contracts/starknet/src/iwa_errors.cairo`
- Create: `contracts/starknet/src/iwa_events.cairo`
- Test: `contracts/starknet/tests/**`

**Interfaces:**
- Produces the Cairo workspace and shared types used by `IwaCircle`.

- [ ] **Step 1: Verify local Starknet/Cairo toolchain versions**
- [ ] **Step 2: Select versions compatible with current STRK20 requirements**
- [ ] **Step 3: Create minimal Scarb workspace**
- [ ] **Step 4: Write failing smoke test**
- [ ] **Step 5: Add minimal contract/module setup**
- [ ] **Step 6: Run Cairo tests**
- [ ] **Step 7: Run formatting/build**
- [ ] **Step 8: Update `STATUS.md`**
- [ ] **Step 9: Commit**

Commit:

```bash
git commit -m "build: establish Starknet Cairo workspace"
```

Do not implement circle behavior in this task.

---

# Task 6: Implement IwaCircle State Machine with TDD

**Files:**
- Create: `contracts/starknet/src/iwa_circle.cairo`
- Test:
  - `contracts/starknet/tests/test_circle_creation.cairo`
  - `contracts/starknet/tests/test_membership.cairo`
  - `contracts/starknet/tests/test_contributions.cairo`
  - `contracts/starknet/tests/test_grace_defaults.cairo`
  - `contracts/starknet/tests/test_rounds.cairo`
  - `contracts/starknet/tests/test_payouts.cairo`
  - `contracts/starknet/tests/test_admin_pause.cairo`

**Interfaces:**
- Produces: public contract interface for circle business state.
- Consumes: domain rules from `docs/domain/IWA_INVARIANTS.md`.

Implement in independently reviewable slices.

## Slice 6A: Circle creation

- [ ] Write failing tests for valid creation.
- [ ] Write failing tests for unsupported asset.
- [ ] Write failing tests for invalid member/cadence/grace configuration.
- [ ] Implement minimum creation behavior.
- [ ] Run focused tests.
- [ ] Commit:

```bash
git commit -m "feat: add Starknet IWA circle creation"
```

## Slice 6B: Membership

Test:

- invite/approval requirement
- capacity
- duplicate join
- cannot join after activation
- pause blocks new joins

Commit:

```bash
git commit -m "feat: add IWA circle membership rules"
```

## Slice 6C: Fixed payout order

Test:

- order configured before activation
- duplicate/invalid entries rejected
- order locked after activation
- admin cannot reorder

Commit:

```bash
git commit -m "feat: lock deterministic payout rotation"
```

## Slice 6D: Contribution obligations

Test:

- obligation exists once per required member/round
- wrong round rejected
- duplicate satisfaction rejected
- unsupported asset rejected
- correct state transition succeeds

Commit:

```bash
git commit -m "feat: enforce contribution obligations"
```

## Slice 6E: Grace/default behavior

Boundary tests:

```text
before due time → ON_TIME
after due time but <= grace end → LATE_WITHIN_GRACE
after grace end without valid contribution → MISSED_DEFAULT
```

Test exact boundary behavior.

Commit:

```bash
git commit -m "feat: enforce contribution grace and default states"
```

## Slice 6F: Deficit/payout behavior

Test:

- correct recipient
- no duplicate payout
- unresolved deficit locks scheduled payout
- valid cure unlocks according to predefined rule
- admin cannot redirect
- deterministic fallback is enforced

Commit:

```bash
git commit -m "feat: enforce deterministic IWA payouts"
```

## Slice 6G: Emergency pause

Test:

- authorized pause works
- unauthorized pause fails
- pause blocks only approved risky actions
- historical state unchanged
- safe read/recovery behavior remains available where designed

Commit:

```bash
git commit -m "feat: add scoped emergency pause"
```

---

# Task 7: Implement and Verify Core Invariants

**Files:**
- Create/modify: `contracts/starknet/tests/test_invariants.cairo`
- Modify contracts only when invariant tests expose defects

**Interfaces:**
- Consumes: `IwaCircle`
- Produces: security evidence for persistent business properties

- [ ] Test payout-order immutability.
- [ ] Test contribution uniqueness.
- [ ] Test payout uniqueness.
- [ ] Test round monotonicity.
- [ ] Test admin non-custody.
- [ ] Test history immutability.
- [ ] Test deterministic deficit behavior.
- [ ] Test token allowlist.
- [ ] Define and test exact accounting invariant based on final STRK20 settlement model.
- [ ] Add fuzz/property testing supported by the selected Cairo toolchain.
- [ ] Run complete Cairo test suite.
- [ ] Update `SECURITY.md` with verified invariant status.
- [ ] Update `STATUS.md`.
- [ ] Commit:

```bash
git commit -m "test: enforce IWA protocol invariants"
```

---

# Task 8: Implement IwaStrk20Helper

**Files:**
- Create: `contracts/starknet/src/iwa_strk20_helper.cairo`
- Test: `contracts/starknet/tests/test_strk20_helper.cairo`
- Reference: `docs/strk20/INTEGRATION_RESEARCH.md`
- Modify: `SECURITY.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: exact verified STRK20 anonymizer/privacy interface
- Produces: private contribution/payout bridge to `IwaCircle`

Do not begin until Task 2 research is complete.

- [ ] **Step 1: Write test for unauthorized caller rejection**

Expected: any caller other than the required verified STRK20 route is rejected when protocol architecture requires pool-only invocation.

- [ ] **Step 2: Write test for unsupported token rejection**
- [ ] **Step 3: Write test for invalid circle**
- [ ] **Step 4: Write test for wrong round/obligation**
- [ ] **Step 5: Write replay/double-contribution test**
- [ ] **Step 6: Write malformed note/output handling tests based on actual STRK20 interface**
- [ ] **Step 7: Implement minimal private contribution path**
- [ ] **Step 8: Run focused tests**
- [ ] **Step 9: Implement private payout path**
- [ ] **Step 10: Test duplicate payout/replay**
- [ ] **Step 11: Review every external call**
- [ ] **Step 12: Verify helper is not an arbitrary-call proxy**
- [ ] **Step 13: Run full Cairo suite**
- [ ] **Step 14: Update security documentation with actual trust assumptions**
- [ ] **Step 15: Commit**

```bash
git commit -m "feat: integrate IWA circle flow with STRK20"
```

---

# Task 9: Starknet Frontend Adapter Migration

**Files:**
- Modify existing `iwa-web/**` only as necessary
- Create:
  - `iwa-web/src/chains/starknet/config.ts`
  - `iwa-web/src/chains/starknet/wallet.ts`
  - `iwa-web/src/chains/starknet/contracts.ts`
  - `iwa-web/src/chains/starknet/transactions.ts`
  - `iwa-web/src/chains/starknet/strk20.ts`
  - `iwa-web/src/chains/starknet/explorer.ts`
- Modify: existing chain-facing frontend services/components
- Test: existing frontend tests plus adapter tests

**Interfaces:**
- Consumes: chain-neutral interface from Task 4
- Produces: working Starknet frontend without redesigning IWA

## Preservation rule

Before modifying UI:

```bash
git diff -- iwa-web
```

After each migration slice, inspect for unexpected visual changes.

## Slice 9A: Inventory Stellar coupling

Search:

```bash
grep -RniE 'stellar|soroban|horizon|freighter|stellar-sdk|testnet' iwa-web/src iwa-web/*.html 2>/dev/null
```

Classify every match:

```text
REMOVE
REPLACE WITH STARKNET
MAKE CHAIN-NEUTRAL
KEEP AS HISTORICAL DOC ONLY
```

Do not blindly global-replace text.

## Slice 9B: Starknet configuration

Implement config with:

```ts
type StarknetConfig = {
  chainId: string;
  rpcUrl: string;
  explorerUrl: string;
  strk20PoolAddress: string;
  usdcAddress: string;
  strkAddress: string;
  iwaCircleAddress?: string;
  iwaHelperAddress?: string;
};
```

Runtime must reject wrong chain/config.

## Slice 9C: Wallet integration

Use the wallet approach verified in Task 2.

Test:

- connect
- disconnect
- account change
- wrong network
- rejected request
- no wallet
- transaction failure

Never request private keys/seeds.

## Slice 9D: STRK20 wallet flow

Implement exact verified shielding/private transaction interface.

No direct key custody unless the approved research explicitly requires and justifies it.

## Slice 9E: Existing saver flows

Reconnect existing UI to:

- create circle
- join circle
- contribute
- view progression
- receive/claim payout
- credential flow

Do not redesign components.

## Slice 9F: Copy migration

Replace only obsolete:

- Stellar references
- Soroban references
- old testnet/explorer terminology
- inaccurate chain-specific claims

Preserve established IWA brand copy and visual hierarchy.

## Slice 9G: Visual regression check

Run application and compare key screens.

Verify:

- palette unchanged
- typography unchanged
- spacing not globally changed
- layout not replaced
- animations not removed unintentionally
- mobile remains functional

## Slice 9H: Frontend verification

Run the repository's actual commands for:

```text
format
lint
typecheck
test
build
```

Record exact commands and results in `STATUS.md`.

Commit:

```bash
git commit -m "feat: migrate IWA frontend to Starknet adapter"
```

If migration is large, split commits by adapter/wallet/flow/copy rather than one oversized commit.

---

# Task 10: Backend / Indexer Foundation

**Files:**
- Create focused backend/indexer structure under `services/`
- Modify: `ARCHITECTURE.md` only if selected stack requires clarified implementation details
- Modify: `SECURITY.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes public Starknet/IWA events only
- Produces non-sensitive data for product UX/admin dashboard

Before selecting a backend stack:

- inspect existing repository dependencies
- avoid introducing redundant frameworks
- prefer smallest maintainable solution

Required data boundary:

Allowed:

```text
public circle metadata
public contract state
public events
transaction status
contract health
aggregate metrics
verification counts
```

Forbidden:

```text
wallet private keys
viewing keys
raw private contribution graph
raw private payout graph
raw credential evidence
custodial signing material
```

- [ ] Write schema tests proving forbidden fields are absent.
- [ ] Implement public event ingestion.
- [ ] Implement stale/indexer-health state.
- [ ] Implement idempotent event processing.
- [ ] Implement public circle query API.
- [ ] Implement contract-health query.
- [ ] Add rate/input controls where relevant.
- [ ] Run backend tests.
- [ ] Update security/data-boundary documentation.
- [ ] Commit:

```bash
git commit -m "feat: add non-sensitive IWA indexer foundation"
```

---

# Task 11: Admin Dashboard MVP

**Files:**
- Prefer existing frontend design system
- Create admin feature within existing app or a deliberately separated app only if architecture warrants it
- Modify backend APIs as necessary

**Interfaces:**
- Consumes: public/indexed data and narrowly scoped admin operations
- Produces: non-custodial operational dashboard

Required MVP surfaces:

```text
platform overview
public circle statistics
contract health
transaction health
failed-operation visibility
audit logs
verification usage
revenue placeholders
narrow pause status/control
```

- [ ] Write authorization tests before privileged operations.
- [ ] Implement admin authentication.
- [ ] Implement least-privilege authorization.
- [ ] Implement contract health.
- [ ] Implement transaction health.
- [ ] Implement audit log.
- [ ] Implement verification usage metrics.
- [ ] Implement revenue metric placeholders backed by real non-sensitive data structures, not fake production values.
- [ ] Implement narrow pause control only through approved contract interface.
- [ ] Verify dashboard cannot access forbidden private data.
- [ ] Preserve IWA visual system.
- [ ] Run frontend/backend test suites.
- [ ] Commit:

```bash
git commit -m "feat: add non-custodial IWA admin dashboard"
```

---

# Task 12: Portable Trust Credential

**Files depend on Task 2 decision.**

## Path A: STRK20-native/selective disclosure sufficient

Implement only the minimal product integration needed to request, present and verify a scoped claim.

Test:

- user chooses claim
- verifier receives only scoped claim
- raw history is not exposed
- stale/invalid claim fails
- user binding cannot be trivially substituted
- proof/result displayed correctly

## Path B: Separate proof required

Only if Task 2 documented a missing STRK20 capability.

Before implementation:

- audit `iwa-circuit/`
- audit `iwa-prover/`
- document exact pieces being reused
- do not assume previous circuit correctness

Required proof statement must be explicit, for example:

```text
completed_cycles >= threshold
AND
default_count == 0
```

without exposing underlying contribution history.

Test:

- valid witness passes
- invalid cycle count fails
- hidden default fails
- wrong user/context fails
- stale/replayed proof handled according to approved model
- public inputs reveal only intended information

Commit:

```bash
git commit -m "feat: add scoped Portable Trust Credential"
```

---

# Task 13: Full Security Audit

**Files:**
- Create: `docs/security/AUDIT_REPORT.md`
- Modify: `SECURITY.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes entire integrated system
- Produces concrete audit findings and release decision

Audit categories:

```text
Cairo contracts
STRK20 integration
access control
state machine
accounting
replay
external calls
privacy leakage
frontend data leakage
backend data boundary
admin authorization
credential integrity
deployment configuration
dependency/secrets review
```

Use severities:

```text
CRITICAL
HIGH
MEDIUM
LOW
INFORMATIONAL
```

Each finding must include:

```markdown
## Finding ID: TITLE

Severity:
Affected component:
Status:

### Impact

### Failure / attack path

### Evidence

### Fix

### Verification
```

- [ ] Perform manual Cairo review.
- [ ] Review STRK20 helper against Task 2 research.
- [ ] Review all privileged entry points.
- [ ] Review every external call.
- [ ] Review all invariants.
- [ ] Run all fuzz/invariant tests.
- [ ] Review frontend logging/storage.
- [ ] Review backend schema/logging.
- [ ] Review admin permissions.
- [ ] Run dependency/secret checks available in repository/tooling.
- [ ] Fix all Critical/High findings before mainnet.
- [ ] Decide explicitly whether Medium findings block release.
- [ ] Rerun affected tests after every fix.
- [ ] Record residual risk.
- [ ] Commit:

```bash
git commit -m "security: complete IWA pre-mainnet audit"
```

Do not claim an external professional audit unless an external auditor actually performed one.

---

# Task 14: Starknet Mainnet Deployment

**Files:**
- Create minimal deployment scripts/config under `contracts/starknet/`
- Create sanitized `.env.example` if necessary
- Modify: `strk20.json`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes audited Cairo contracts
- Produces verified mainnet contracts and qualifying transactions

## Pre-deployment hard gate

All must pass:

```text
Cairo tests
fuzz/invariants
frontend tests
backend tests
builds
security review
verified addresses
verified roles
secret scan
```

- [ ] Verify `SN_MAIN`.
- [ ] Re-verify official STRK20 pool from current source.
- [ ] Verify current USDC address.
- [ ] Verify current STRK address.
- [ ] Verify deployer/admin wallet.
- [ ] Verify pause authority.
- [ ] Verify class hashes.
- [ ] Deploy with smallest safe configuration.
- [ ] Verify deployed class hashes/bytecode.
- [ ] Verify initialization state.
- [ ] Perform minimal-value shield/private contribution flow.
- [ ] Perform minimal-value private payout/second qualifying flow.
- [ ] Perform third qualifying STRK20 transaction required for sprint.
- [ ] Verify receipts and expected IWA state changes.
- [ ] Add only confirmed hashes to `strk20.json`.
- [ ] Add confirmed deployed contract addresses to `strk20.json`.
- [ ] Update `STATUS.md`.
- [ ] Review diff.
- [ ] Commit:

```bash
git commit -m "deploy: verify IWA on Starknet mainnet"
```

Never place signing keys or API secrets in the commit.

---

# Task 15: Legacy Retirement

**Files:**
- Potentially delete/retire:
  - `iwa-savings/`
  - `iwa-verifier/`
  - `toolchain-test/`
  - `iwa-circuit/`
  - `iwa-prover/`
- Modify:
  - `README.md`
  - `ARCHITECTURE.md`
  - `STATUS.md`

This task may only run after replacements are verified.

- [ ] Confirm no production path imports/references `iwa-savings`.
- [ ] Confirm no production path imports/references `iwa-verifier`.
- [ ] Confirm Stellar/Soroban no longer powers the product.
- [ ] Confirm credential decision for `iwa-circuit`/`iwa-prover`.
- [ ] Remove only components confirmed obsolete.
- [ ] Search repository for obsolete references:

```bash
grep -RniE 'Stellar|Soroban|stellar-sdk|freighter|horizon' . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude='LEGACY_BEHAVIOR.md'
```

Review all remaining hits.

- [ ] Remove stale dependencies/config.
- [ ] Run full test/build suite.
- [ ] Update docs to reflect actual final architecture.
- [ ] Commit:

```bash
git commit -m "refactor: retire obsolete Stellar implementation"
```

If the ZK layer remains intentionally, do not delete it.

---

# Task 16: README and Product Documentation

**Files:**
- Rewrite: `README.md`
- Retire after extraction: `iwa-PRD.md.md`
- Modify: `PROJECT.md`
- Modify: `STATUS.md`

README must describe only real functionality.

Include:

```text
what IWA is
why privacy matters
current Starknet/STRK20 architecture
supported assets
how to run locally
how to test
contracts
mainnet deployment
privacy model
credential model
admin boundary
security limitations
demo
license
```

Do not include false claims such as:

```text
audited
perfect privacy
production safe
fully anonymous
```

unless those claims are independently justified.

Commit:

```bash
git commit -m "docs: document Starknet IWA release"
```

---

# Task 17: Public Demo and Submission Hardening

**Files:**
- Modify deployment configuration as required
- Modify: `strk20.json`
- Modify: `STATUS.md`

Required demo path:

```text
connect Starknet wallet
→ use shielded USDC/STRK
→ create or join IWA circle
→ private contribution
→ show circle progression
→ private payout
→ show scoped Portable Trust Credential
→ optionally show admin operational view
```

- [ ] Test fresh browser session.
- [ ] Test fresh wallet/account where practical.
- [ ] Test wrong network.
- [ ] Test rejected transaction.
- [ ] Test failed transaction.
- [ ] Test mobile viewport.
- [ ] Verify no Stellar copy remains in primary flow.
- [ ] Verify no debug/private data leaks.
- [ ] Verify deployed URL.
- [ ] Verify every `strk20.json` transaction.
- [ ] Add demo URL.
- [ ] Add final video URL after recording.
- [ ] Re-run build/tests.
- [ ] Update `STATUS.md`.

Commit:

```bash
git commit -m "chore: harden IWA STRK20 demo"
```

---

# Task 18: Three-Minute Demo Video

The video must prioritize the working product rather than architecture slides.

Recommended timing:

```text
0:00–0:20
Problem:
community savings reliability exists but is hard to carry and exposing financial history is invasive.

0:20–0:40
IWA:
private savings + Portable Trust Credential.

0:40–1:55
Live flow:
wallet → shielded asset → circle → private contribution → progression → payout.

1:55–2:25
Portable Trust Credential:
share a scoped reliability claim without revealing raw history.

2:25–2:45
Show Starknet/STRK20 integration and real mainnet transaction evidence.

2:45–3:00
Business:
B2B verification + Pro circles + enterprise infrastructure.
```

Do not spend the majority of the video on landing-page visuals or architecture diagrams.

---

# Task 19: Final Verification

Before declaring the sprint build complete:

- [ ] `git status` clean.
- [ ] All expected tests pass.
- [ ] Frontend builds.
- [ ] Cairo contracts build/test.
- [ ] Backend/indexer tests pass.
- [ ] No known Critical/High security findings remain.
- [ ] Mainnet addresses independently rechecked.
- [ ] At least three qualifying transactions verified.
- [ ] `strk20.json` is valid JSON.
- [ ] Demo URL works.
- [ ] Video URL works.
- [ ] README matches reality.
- [ ] `STATUS.md` accurately reflects final state.
- [ ] No secrets are tracked.
- [ ] No agent attribution in commits.
- [ ] Existing IWA design remains recognizable.
- [ ] Registration PR remains the single registration PR.

Run:

```bash
git status
git log --oneline --decorate -20
```

Then inspect the final diff/history and record the completion state.

---

# Execution Rules

## Task isolation

Each task must be reviewed before moving to the next security-sensitive task.

Do not run independent agents against the same files concurrently.

Safe parallel examples may include:

```text
contract test research
+
frontend Stellar-coupling inventory
```

provided neither agent modifies shared files.

Unsafe parallel example:

```text
two agents modifying iwa_circle.cairo
```

## Verification rule

Before any completion claim:

```text
run the relevant command
read the output
confirm the result
```

Do not infer test success from lack of errors in a previous run.

## Diff rule

Before every commit:

```bash
git status
git diff
git diff --cached
```

Review for:

- unrelated changes
- visual churn
- generated artifacts
- secrets
- agent attribution
- accidental legacy deletion

## Documentation rule

At the end of each major phase:

```text
STATUS.md must be updated.
```

If architecture changes:

```text
ARCHITECTURE.md must be updated.
```

If security assumptions change:

```text
SECURITY.md must be updated.
```

---

# Self-Review

## Spec coverage

This plan covers:

- preservation of the existing IWA frontend
- legacy behavior extraction
- chain-neutral architecture
- Starknet/Cairo contracts
- STRK20 protocol research before implementation
- private contribution/payout paths
- USDC + STRK
- invite/private circles
- fixed payout order
- grace/default states
- deficit behavior
- narrow pause
- backend/indexer privacy boundary
- non-custodial admin dashboard
- revenue metrics/business support
- Portable Trust Credential
- optional legacy ZK reuse only when justified
- security audit
- mainnet deployment
- three required STRK20 transactions
- public demo
- 3-minute demo video
- retirement of obsolete Stellar/Soroban code
- truthful README and status handoff

## Placeholder scan

No implementation task is permitted to proceed on protocol details that are not yet verified.

Those details are explicitly resolved by Task 2 before the dependent implementation tasks start.

This is intentional research dependency, not permission to guess.

## Dependency order

Required sequence:

```text
Phase 0 baseline
→ STRK20 research
→ legacy behavior extraction
→ chain-neutral core
→ Cairo workspace
→ IwaCircle
→ invariants
→ STRK20 helper
→ frontend adapter
→ backend/admin
→ credential
→ audit
→ mainnet
→ legacy retirement
→ docs/demo
```

No destructive legacy retirement occurs before replacement verification.
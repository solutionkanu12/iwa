# IwaCircle V2 Private Payout Capability and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only after the capability gate below is approved. Every production task uses a failing test first. No commit, push, or deploy step is authorized by this plan.

**Goal:** Unblock and then implement IwaCircle V2 without weakening the private payout invariant.

**Architecture:** Chain-neutral circle rules are implemented through Starknet `ChainAdapter`, `PaymentAdapter`, and `PrivacyAdapter` boundaries. A member precommits a per-circle, epoch-bound STRK20 shadow identity. At payout, a compatible wallet proves that identity, invokes the V2 helper through the deterministic shadow account, and atomically collects the state-derived payout into a wallet-owned open note. Implementation is gated on real-wallet and deployment verification.

**Tech Stack:** Cairo, Starknet Foundry, exact pinned STRK20 pool source, a compatible STRK20 wallet or an independently selected Starknet privacy primitive, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-iwa-circle-v2-design.md`

## Global constraints

- V1 contracts, history, adapters, and tests are immutable.
- A normal public ERC20 payout is prohibited.
- No server-held keys, viewing keys, seeds, or payout authority.
- No organizer or admin recipient selection or recovery.
- Amount, member, token, circle, and round come from trusted contract state.
- New circles do not default to V2 before implementation, red team, testnet proof, and explicit approval.
- Critical or High findings block release.

---

## Current gate result

**B. FEASIBLE WITH SMALL V2 CONTRACT CHANGE.**

The open-note ID still cannot be known before wallet assembly. The supported construction avoids binding it. The pinned shadow-account anonymizer derives a commitment from wallet-private identity material, dapp name, and nonce, maps it to a deterministic shadow account, invokes the dapp through that account, and collects its token delta into an open note atomically. Current Wallet API development specification `0.10.4-rc.1` exposes the commitment and shadow invoke methods. Iwa's installed `0.10.3` types and a compatible target-network wallet/deployment are not yet verified.

Tasks G1 through G5 are the only authorized next work after review. Tasks I1 onward stay blocked until G5 is approved.

## Task G1: pin and verify the shadow-account primitive

**Files:**

- Modify: `docs/strk20/INTEGRATION_RESEARCH.md`
- Modify: this plan's evidence record

**Interfaces:**

- `wallet_strk20ShadowAccountCommitment(dapp_name, nonce)`
- `STRK20_SHADOW_ACCOUNT_INVOKE_ACTION`
- shadow anonymizer `get_shadow_account(identity_commitment)`
- collection policy `Diff` for the exact payout token

- [ ] Pin exact source commit, wallet/API version, anonymizer address/class hash, pool binding, shadow account class, network, and audit status.
- [ ] Verify governance and upgrade authority for the anonymizer and shadow account class.
- [ ] Confirm the exact dapp-name and per-circle/per-epoch nonce derivation.
- [ ] Confirm a real browser wallet exposes both methods without revealing the identity key or viewing key.
- [ ] Record the exact public metadata and privacy leakage.

**Gate:** The exact wallet and target-network deployment match the pinned source. Otherwise stop; verdict B remains source-level only.

## Task G2: write the negative and positive capability tests first

**Files:**

- Create: `contracts/starknet/tests/test_private_destination_capability_v2.cairo`
- Create: `iwa-web/src/chains/strk20/v2/privateDestinationCapability.test.ts`
- Create only if the selected primitive requires it: isolated adapter fixture under `contracts/starknet/tests/fixtures/`

**Interfaces:**

- `register_shadow_commitment(member_ref, identity_commitment, destination_epoch, auth_epoch)`
- narrow helper payout call with no caller-selected member, recipient, token, or amount
- exact signatures must be derived from pinned interfaces and frozen test vectors, not invented

- [ ] Write failing tests for commitment registration, correct shadow caller, wrong shadow caller, commitment substitution, cross-circle reuse, replay, stale epoch, rotation race, and double collect.
- [ ] Write failing tests showing that the helper derives member, round, token, and amount from circle state.
- [ ] Write a failing atomicity test proving any failed collection reverts the circle state and liability debit.
- [ ] Run each test and capture its expected failure before any adapter implementation.

**Gate:** Tests exercise the real pinned pool and anonymizer or faithful deployed-class fixtures. Interface-only mocks are insufficient.

## Task G3: prove browser and wallet compatibility

**Files:**

- Modify: `iwa-web/src/chains/strk20/v2/privateDestinationCapability.test.ts`
- Create: `iwa-web/src/chains/strk20/v2/privateDestinationSpike.ts` only inside this isolated spike

**Interfaces:**

- Dapp supplies public context and opaque member commitment.
- Wallet or on-device prover owns all viewing-key and note-witness operations.
- Result exposes only the values required by the V2 helper.

- [ ] Add a failing integration test using `wallet_strk20ShadowAccountCommitment` and `STRK20_SHADOW_ACCOUNT_INVOKE_ACTION`, asserting no identity key, viewing key, or note witness crosses the adapter boundary.
- [ ] Run it and confirm installed Wallet API types `0.10.3` lack the required methods.
- [ ] Upgrade or vendor only the explicitly reviewed `0.10.4-rc.1` interface in the isolated spike after real-wallet support is confirmed.
- [ ] Implement the minimum shadow adapter needed to make the focused test pass.
- [ ] Run the test, typecheck, and inspect serialized actions for destination, amount, identity, and timing leakage.
- [ ] Delete the spike implementation and retain only evidence if the trust boundary cannot be met.

**Gate:** A real compatible wallet completes commitment derivation and shadow invocation without backend key custody. Simulation-only success does not pass.

## Task G4: prove contract-side ownership and atomic settlement

**Files:**

- Modify: `contracts/starknet/tests/test_private_destination_capability_v2.cairo`
- Create: minimal isolated Cairo adapter fixture only after the failing tests exist

**Interfaces:**

- Contract receives the call from the anonymizer-resolved shadow account.
- Contract causes one private settlement for the state-derived amount, which the anonymizer collects into the wallet-owned note.

- [ ] Run the correct-owner test and observe the expected missing implementation failure.
- [ ] Implement the smallest fixture that validates the stored shadow commitment, resolved caller, member, epoch, token, amount, and action context.
- [ ] Run correct-owner and state-derived-amount tests to green.
- [ ] Run wrong member, wrong destination, wrong amount, wrong round, wrong contract, wrong chain, replay, double collect, and callback/reentrancy tests.
- [ ] Assert state and liability remain unchanged on every failure.
- [ ] Run the real pool integration suite, not a pool mock alone.

**Gate:** Shadow identity authentication and exact private value movement are proven atomically. The helper never accepts or authenticates a caller-supplied open-note ID.

## Task G5: testnet wallet proof and architecture freeze

**Files:**

- Modify: `docs/strk20/INTEGRATION_RESEARCH.md`
- Modify: `docs/superpowers/specs/2026-09-04-iwa-circle-v2-design.md`
- Modify: `SECURITY.md`, `STATUS.md`, `decision.md`, `handoff.md`

- [ ] Run the shadow-account flow at minimal value with a real compatible testnet wallet.
- [ ] Record transaction hashes, exact versions, public metadata, and recipient-side private receipt evidence.
- [ ] Confirm the backend receives no secret material.
- [ ] Freeze authorization encoding and cross-language vectors only after the proof.
- [ ] Confirm verdict B with runtime evidence, downgrade to C if the real wallet or target deployment cannot satisfy the invariants, or reclassify A only if no V2 contract change is required.
- [ ] Obtain explicit architecture and security approval before production implementation.

**Gate:** No IwaCircleV2 production file is created before this review passes.

---

## Blocked production sequence after G5

These tasks define order, not authorization to start.

### Task I1: chain-neutral domain and adapter contracts

- Add failing TypeScript tests for `Circle`, `Member`, `Contribution`, `Obligation`, `Payout`, `Standing`, `Credential`, and `Identity` without Starknet/EVM types.
- Define `ChainAdapter`, `PaymentAdapter`, `PrivacyAdapter`, and `CredentialVerifier` interfaces minimally.
- Run focused tests, implement, rerun, then run frontend typecheck and regression tests.

### Task I2: Member Identity V2 vectors

- Add failing fixed-vector and property tests for random root, per-circle secret, per-circle member reference, identity key, auth epochs, encrypted storage, export, and recovery.
- Implement only after Cairo/TypeScript derivation primitives are confirmed.
- Cross-check every vector in both languages.

### Task I3: V2 circle membership and obligations

- Add Cairo failing tests for locked payout order, invite membership, grace boundaries, default permanence, cure accounting, historical immutability, and helper-only financial state changes.
- Implement separate V2 contracts without touching V1.

### Task I4: private destination registration and rotation

- Add failing tests for member ownership, monotonic epochs, stale authorization, rotation race, fallback timer reset, and cross-circle substitution.
- Implement the exact G5-approved primitive only.

### Task I5: private payout and recovery

- Add failing tests for every payout and recovery attack in the security matrix.
- Implement state-derived amount, proof-bound destination, single-use settlement, private fallback, exact liability debit, and terminal private-success states.
- Run full Cairo and real-pool integration suites.

### Task I6: V1/V2 frontend and index routing

- Add failing tests for `(contract address, circle id)`, `protocol_version`, unknown-version failure, disabled V2 capability, and V1 behavior preservation.
- Implement registry and adapters; keep V2 disabled until release approval.

### Task I7: credentials

- Follow the dedicated credential plan after the V2 identity and successful private payout states exist.

### Task I8: red team and testnet release

- Follow the dedicated security plan.
- Critical or High findings, incomplete private payout evidence, or lack of external audit keeps mainnet blocked.

## Acceptance criteria

- Before production implementation, private payout capability is source-proven, test-proven, and real-wallet testnet proven.
- No public payout or public fallback exists.
- V1 remains byte-for-byte and behaviorally untouched.
- Authorization encoding is frozen only after the privacy primitive is verified.
- Production implementation begins only after G5 and explicit review approval.

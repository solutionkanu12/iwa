# V2 Red-Team, Testnet, and Mainnet Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only after the private payout capability gate is approved. Every code row starts with a failing test. No commit, push, or deploy is authorized by this plan.

**Goal:** Prove V2 financial safety, private payout integrity, credential ownership, privacy boundaries, and V1 compatibility before any release.

**Architecture:** Tests are organized by attack boundary and run against the actual V2 contracts, exact pinned privacy primitive, compatible wallet adapter, frontend, and verifier. Critical or High findings stop the release.

**Tech Stack:** Cairo, Starknet Foundry, real privacy-pool integration, TypeScript, Vitest, backend integration tests, compatible testnet wallet.

**Spec:** `docs/superpowers/specs/2026-09-04-v2-security-release-design.md`

## Global constraints

- Current verdict B is source-level only. Every task below remains blocked except test design and capability work G1 through G5 in the circle plan.
- Public ERC20 payout and public fallback are forbidden.
- V1 remains unchanged.
- Internal testing is not an external audit.
- No deployment without separate explicit approval.

---

## Task RT-0: capability proof gate

**Files:**

- Test: `contracts/starknet/tests/test_private_destination_capability_v2.cairo`
- Test: `iwa-web/src/chains/strk20/v2/privateDestinationCapability.test.ts`
- Modify: `docs/strk20/INTEGRATION_RESEARCH.md`

- [ ] Complete G1 through G5 from `2026-09-04-iwa-circle-v2.md`.
- [ ] Confirm every negative test fails before candidate integration and each approved positive test passes after minimal isolated implementation.
- [ ] Verify private receipt with a real compatible testnet wallet.
- [ ] Record exact source, wallet, contract, network, public metadata, and audit status.
- [ ] Confirm verdict B with runtime evidence, or downgrade to C if any required guarantee fails.

**Gate:** If any assertion is missing or relies only on a mock, stop. No production V2 suite begins.

## Task RT-1: payout attack suite

**Files:**

- Create: `contracts/starknet/tests/test_redteam_payout_v2.cairo`
- Create: `iwa-web/src/chains/strk20/v2/redteamPayout.test.ts`

- [ ] Write failing tests for double collect, payout replay, wrong round, wrong member, wrong private destination, wrong amount, stale authorization, nonce replay, expiry bypass, chain/domain confusion, contract substitution, destination substitution, rotation race, fallback timing, organizer/admin escalation, helper abuse, malicious callback/reentrancy, liability mismatch, and privacy downgrade.
- [ ] Run each focused test and confirm the expected invariant failure before implementation changes.
- [ ] Make only the owning implementation's minimum fix.
- [ ] Rerun focused tests and the full Cairo/real-pool suites.
- [ ] Record each test against the matching matrix row.

**Gate:** Critical = 0 open, High = 0 open.

## Task RT-2: credential attack suite

**Files:**

- Create: `backend/test/redteamCredentialV2.test.ts`
- Create: `iwa-web/src/lib/credential/redteamCredentialV2.test.ts`

- [ ] Write failing tests for forged credential, N mutation, type mutation, subject substitution, stolen artifact, cross-chain/contract/version replay, malformed artifact, fail-open verification, false completion, cured-default laundering, correlation, raw-history leakage, member-graph leakage, and logging leakage.
- [ ] Confirm each expected failure.
- [ ] Implement the minimum fix in the credential track.
- [ ] Rerun focused and full frontend/backend suites.

**Gate:** A valid artifact plus fresh owner proof is required; JSON alone never passes.

## Task RT-3: identity and routing attack suite

**Files:**

- Create: `iwa-web/src/chains/strk20/v2/redteamIdentityV2.test.ts`
- Create: `backend/test/redteamVersionRoutingV2.test.ts`
- Modify: Cairo identity tests created by the circle plan

- [ ] Write failing tests for root exposure, cross-circle linking, auth and destination epoch rollback, recovery takeover, V1/V2 identifier collision, unknown-version handling, V1 regression, and premature V2 default.
- [ ] Confirm the failures, implement minimal fixes in the owning tracks, and rerun all related suites.
- [ ] Prove `(contract address, circle id)` identity and `protocol_version` routing at every boundary.

**Gate:** Unknown input fails closed and V1 behavior is unchanged.

## Task RT-4: full lifecycle and invariant suite

**Files:**

- Create: `contracts/starknet/tests/test_e2e_v2.cairo`
- Create: `contracts/starknet/tests/test_properties_v2.cairo`

- [ ] Write the failing full lifecycle test: create, join, activate, privately contribute, finalize accounting, authorize, privately settle, complete, and issue eligible claim facts.
- [ ] Write property tests for immutable order/history, obligation uniqueness, default permanence, monotonic epochs, exact liability conservation, and one terminal payout.
- [ ] Add adverse lifecycle variants for uncured deficit, zero funded recovery, private recovery, and private fallback.
- [ ] Run against the actual pinned privacy contract, not only a mock.
- [ ] Rerun the unchanged V1 suite.

**Gate:** All lifecycle and invariant tests pass without weakening V1 or privacy.

## Task RT-5: testnet release verification

**Files:**

- Create only after approval: versioned testnet deployment configuration under `contracts/starknet/deploy/`
- Modify: `STATUS.md`, `SECURITY.md`, `docs/strk20/INTEGRATION_RESEARCH.md`

- [ ] Run read-only preflight and intentionally confirm a mismatched network/address/class hash fails before any write.
- [ ] After separate deployment approval, deploy at testnet only and record exact class hashes and addresses.
- [ ] Run real-wallet private contribution, payout, recovery, rotation, and shortened-delay fallback at minimal value.
- [ ] Run credential and possession verification for Good Standing and Circle Completion.
- [ ] Run V1/V2 routing, responsive browser, logs, and privacy metadata checks.
- [ ] Run all Cairo, frontend, backend, typecheck, and production build commands fresh.

**Gate:** All twelve testnet gates in the security spec have evidence.

## Task RT-6: external audit and findings disposition

- [ ] Provide frozen source, dependency pins, threat model, matrices, test evidence, and deployment configuration for independent review.
- [ ] Record every finding with severity, component, attack path, evidence, fix, and fresh verification.
- [ ] Rerun affected focused tests first, then every full suite.
- [ ] Keep release blocked while any Critical or High finding remains.

**Gate:** External review is accurately described and does not get replaced by internal test results.

## Task RT-7: mainnet proposal, not deployment

- [ ] Produce a read-only deployment proposal with reviewed class hashes, addresses, registry entry, feature flags, rollback/incident posture, and V1 coexistence evidence.
- [ ] Confirm V2 creation remains disabled.
- [ ] Stop for explicit human approval.

This plan contains no automatic mainnet deployment step.

## Acceptance criteria

- Private payout and private recovery work with the real selected primitive and compatible wallet.
- All required red-team rows have reproducible passing evidence.
- Critical = 0 and High = 0.
- V1 remains unchanged and routable.
- Testnet verification precedes external review and any mainnet proposal.
- Mainnet and the V2 create-default flip remain separately approved actions.

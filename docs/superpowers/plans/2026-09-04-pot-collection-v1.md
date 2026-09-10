# Iwa Pot Collection V1 Implementation Plan (Track A)

> **Scope note (2026-09-07):** This plan preserves and describes V1 work. Its
> V2 settlement slice is superseded and must not be executed. The current V2
> plan is `2026-09-04-iwa-circle-v2.md`; private payout is mandatory and the
> source-level capability verdict is B through STRK20 shadow accounts, with
> runtime gates open.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pot collection for the saver. First the browser authorization step on the deployed V1 contracts, then the private settlement step, which is blocked on V1 by the open-note-id problem (see spec section 1) and therefore proceeds through a wallet capability spike and, if the spike fails, a designed V2 settlement domain. No server-side signer, ever.

**Spec:** `docs/superpowers/specs/2026-09-04-pot-collection-portable-trust-credential-design.md`, `SECURITY.md`, `ARCHITECTURE.md`, `STATUS.md`, installed `strk20-wallet-api` / `strk20-privacy` / `strk20-anonymizer-contracts` skills.

## Global Constraints

- No automatic commit, push, or deploy at any step. Commits only when explicitly instructed and only after verification.
- Do not change the deployed V1 contracts. No owner, no pause, no upgrade path exists; nothing in this plan attempts one.
- Do not change `iwa-PRD.md`, `iwa-PRD.md.md`, or `install.cmd`.
- Preserve the frontend visual design and existing copy conventions.
- Every feature control follows the `features.ts` capability pattern: closed controls say why; the underlying seam throws either way.
- No forced mainnet transaction for demo purposes. Minimal value only when a real transaction is genuinely required for verification.
- STRK20 behavior is read from the installed skills before implementation; never from memory.
- Do not claim anything passed, deployed, or works until it is verified.
- Update `STATUS.md` after each verified milestone.
- No AI attribution in commits.

## Existing files this plan builds on (do not redesign)

```text
iwa-web/src/lib/features.ts                       capability flags (POT_COLLECTION gated)
iwa-web/src/chains/strk20/iwaSigning.ts           payoutAuthorizationHash, signIwa, verifyIwa, deriveMemberIdentity, signChecked
iwa-web/src/chains/strk20/iwaSigning.test.ts      parity vectors pinning browser signer to Cairo verifier
iwa-web/src/chains/strk20/strk20Actions.ts        STRK20 contribution actions (open-note pattern reference)
iwa-web/src/chains/strk20/iwaStrk20Client.ts      contract call client
iwa-web/src/chains/strk20/publicReads.ts          read-only chain reads
iwa-web/src/lib/roundState.ts                     round state derivation for the timeline
iwa-web/src/screens/CircleView.tsx                circle timeline screen
iwa-web/src/lib/homeActions.ts                    Action Center
contracts/starknet/src/iwa_circle.cairo           V1 circle (immutable, reference only)
contracts/starknet/src/iwa_strk20_helper.cairo    V1 helper (immutable, reference only)
contracts/starknet/tests/test_payout_settlement.cairo
contracts/starknet/tests/test_settlement_boundary.cairo
```

## File Structure (new and changed)

```text
# Milestone A0 (spike, no production code)
iwa-web/src/chains/strk20/walletCapabilitySpike.ts      probe helper (dev only)
iwa-web/src/chains/strk20/walletCapabilitySpike.test.ts
docs/strk20/WALLET_NOTE_ID_SPIKE.md                      spike result record

# Milestone A1 (V1 authorization step, no contract change)
iwa-web/src/chains/strk20/payoutAuth.ts                 browser authorize flow
iwa-web/src/chains/strk20/payoutAuth.test.ts
iwa-web/src/lib/payoutFlow.ts                           shared payout state derivation
iwa-web/src/lib/payoutFlow.test.ts
iwa-web/src/screens/CircleView.tsx                       timeline controls (edit)
iwa-web/src/lib/features.ts                              POT_COLLECTION wording update (edit)
iwa-web/src/lib/actionCenter.ts                          "your turn" task (edit)
iwa-web/src/lib/actionCenter.test.ts

# Milestone A3 (V2 settlement domain, Cairo)
contracts/starknet/src/iwa_types_v2.cairo                V2 domain + verification (new)
contracts/starknet/src/iwa_circle_v2.cairo               V2 circle (new; V1 reference)
contracts/starknet/tests/test_payout_settlement_v2.cairo
contracts/starknet/tests/test_settlement_boundary_v2.cairo
contracts/starknet/tests/test_audit_findings_v2.cairo

# Milestone A4 (settlement flow, frontend)
iwa-web/src/chains/strk20/payoutSettlement.ts           two-action STRK20 settlement flow
iwa-web/src/chains/strk20/payoutSettlement.test.ts
iwa-web/src/lib/payoutFlow.ts                            (edit: settlement states)
iwa-web/src/lib/payoutFlow.test.ts

# Milestone A5 (recovery surface)
iwa-web/src/lib/recoveryFlow.ts
iwa-web/src/lib/recoveryFlow.test.ts
iwa-web/src/screens/CircleView.tsx                       (edit: recovery states)
```

## Task A0: wallet capability spike (gate for the whole plan)

Blocked-on question: can the app learn the exact `open_note_id` that the wallet will use, before or during assembly, or can the wallet sign with an app-derived key?

- [ ] Read `strk20-wallet-api` reference `starknet-wallet-api__private-defi.md` and note the placeholder resolution contract.
- [ ] Write `walletCapabilitySpike.ts` (dev-only, never imported by product code): probe A, attempt to obtain resolved open note ids from a prepared transaction (`strk20PrepareInvoke` result); probe B, attempt a two-step assemble/sign sequence with a member auth key; probe C, check `supportedWalletApi` versions of candidate wallets (Ready, Xverse).
- [ ] Write `walletCapabilitySpike.test.ts` with dry-run assertions that document observed behavior without side effects.
- [ ] Run the probes against a public network with a privacy-enabled wallet at zero or minimal value.
- [ ] Record findings in `docs/strk20/WALLET_NOTE_ID_SPIKE.md`.
- [ ] Gate decision: if any probe proves the app can obtain the note id before signing, the V1 path is unlocked and Milestones A3/A4 target the deployed V1 contracts instead of V2. Otherwise proceed to Milestone A3 (V2 domain) as designed.
- [ ] Do not ship any probe code in a product build.

## Task A1: browser authorization step (V1, no contract change)

This step is fully implementable on the deployed contracts. It makes `SettlementAuthorized` real for the saver.

- [ ] Test first: `payoutAuth.test.ts` covers: happy path (Scheduled -> authorize -> SettlementAuthorized), cured DeferredLocked authorizable, uncured DeferredLocked refused, non-scheduled member refused, nonce reuse refused (fixture: mock client returning contract errors), wrong chain refused, malformed signature refused before submission.
- [ ] Implement `payoutAuth.ts`: build `IWA_PAYOUT_V1` payload with `payoutAuthorizationHash`, sign with the derived member identity via `signChecked`, submit `authorize_payout_settlement` through `iwaStrk20Client`, poll until `SettlementAuthorized` or terminal error, map contract errors to user-safe messages (reuse existing error-mapping conventions).
- [ ] Test first: `payoutFlow.ts` tests for state derivation: which statuses make the authorize control available, which make it disabled with the existing closed-control wording.
- [ ] Implement `payoutFlow.ts` shared state derivation and wire it into `CircleView.tsx` timeline (member's turn section) with no visual redesign, following the contribution-control pattern.
- [ ] Update `actionCenter.ts` and its tests so the member's turn task carries the authorize action when authorizable.
- [ ] Update `features.ts` wording for POT_COLLECTION to reflect that authorization is open while settlement remains gated; keep `available: false` until the settlement step is live. Update `features.test.ts`.
- [ ] Verify: `cd iwa-web && npx vitest run`, `tsc -b`, `npm run build`. No contract change, no backend change, no mainnet write in tests.
- [ ] Read-only mainnet verification of the new UI path against Circle 1 state.

## Task A3: V2 settlement domain (Cairo, only if spike gate fails)

Design per spec section 3, Option A. New contract family; V1 circles untouched.

- [ ] Write `iwa_types_v2.cairo` test-first alongside `test_payout_settlement_v2.cairo`: new domain tag `IWA_PAYOUT_SETTLEMENT_V2`; SNIP-12-style typed-data payload binding (circle_id, round, member_ref, helper, pool, token, amount, open_note_id, nonce); verification via the member's registered account contract `is_valid_signature`; distinct from every V1 domain; low-s canonical checks preserved.
- [ ] Implement `iwa_circle_v2.cairo` as a minimal delta over V1 behavior: member join registers an optional settlement account address; `settle_payout_from_helper` on V2 verifies the V2 domain against the account; everything else mirrors V1 invariants exactly.
- [ ] Write `test_settlement_boundary_v2.cairo` and `test_audit_findings_v2.cairo` covering: double collect, wrong recipient, wrong amount, wrong round, stale state, replay across and within namespaces, helper-only caller, exact outbound availability, external-call ordering and reentrancy guards on the account call, failed `is_valid_signature` reverts the whole transition.
- [ ] Run `cd contracts/starknet && scarb test`; all existing 190 tests stay green (V1 untouched) plus the new V2 suites.
- [ ] Security review of the single new external call (account `is_valid_signature`): document target, authority, expected failure behavior, and state-ordering in SECURITY.md per its external-calls rule. Do not deploy anything.

## Task A4: private settlement flow (frontend)

- [ ] Test first: `payoutSettlement.test.ts` covers: action construction order (open note first, invoke second), calldata matches helper `privacy_invoke` signature exactly, `${openNoteIds[0]}` placeholder usage, shielded-balance readiness check, pool fee read (`get_fee_amount`), note maturity warning, `waitForTransaction` timeout treated as "submitted, not yet visible" with explorer link and resume polling, wrong-chain fail-closed, normalized address comparison (BigInt).
- [ ] Implement `payoutSettlement.ts` using `strk20InvokeTransaction` (or the V2-equivalent flow) with the two-action pattern; never request a viewing key or seed phrase.
- [ ] Wire into `payoutFlow.ts`/`CircleView.tsx`: settle control after `SettlementAuthorized`, status `Paid` on success.
- [ ] Update `features.ts`: flip `POT_COLLECTION.available` only after the verifier path and red-team gates pass; keep closed-control wording until then.
- [ ] Verify: full frontend suite, `tsc -b`, production build clean; Cairo suites green.
- [ ] STRK20 integration verification with a real privacy-enabled wallet on a public network at minimal value; record transactions in the evidence file only if verified.

## Task A5: recovery surface (frontend)

- [ ] Test first: `recoveryFlow.test.ts` covers: `RecoveryPending` read after `prepare_final_settlement`, settle-recovery action construction, `NoFundedRecovery` explained as terminal without offering a transaction, stale recovery states refused.
- [ ] Implement `recoveryFlow.ts` and wire into `CircleView.tsx` per the existing visual patterns.
- [ ] Verify: full frontend suite, `tsc -b`, production build clean.

## Task A6: release gates

- [ ] Run the Track C red-team matrix against everything shipped in this plan; no Critical or High findings open.
- [ ] Re-run: Cairo suite, frontend suite, backend suite (unchanged, must stay green), production build, `deployHeaders` tests.
- [ ] Mainnet read verification of the shipped UI paths; confirm no write was performed unless explicitly required and approved.
- [ ] Update `README.md` only if live-feature wording changes (with the approved product copy rules) and update `STATUS.md` with verified results.
- [ ] No commit, push, or deploy without explicit instruction.

## Acceptance criteria

- The saver can authorize their own payout from the browser on V1 mainnet state (`SettlementAuthorized`).
- The saver can settle the pot privately through STRK20 once the V2 (or spike-unlocked V1) path is live, with `Paid` state verified on chain.
- No organizer, admin, operator, or server path can authorize or move a payout.
- All red-team areas in Track C pass with no Critical/High open findings.
- Only verified work is committed, and only when explicitly instructed.

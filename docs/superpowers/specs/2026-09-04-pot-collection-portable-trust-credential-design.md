# Iwa V1 Pot Collection + Portable Trust Credential Design

> **Scope note (2026-09-07):** This is a V1 preservation artifact. Any V2
> suggestion in this file is superseded by
> `2026-09-04-iwa-circle-v2-design.md`. An account-based public payout or an
> unproven account signature over an assembly-time open note is not an approved
> V2 solution. V2 requires verified private payout. The superseding design has
> source-level verdict B through STRK20 shadow accounts, with runtime gates open.

**Status:** Approved planning artifact. No implementation has been done.
**Scope:** Pot collection (Track A), Portable Trust Credential V1 (Track B), red-team release program (Track C).
**Sources of truth:** `iwa_circle.cairo`, `iwa_strk20_helper.cairo`, `iwa_types.cairo`, `SECURITY.md`, `ARCHITECTURE.md`, `STATUS.md`, `PROJECT.md`, `docs/domain/IWA_INVARIANTS.md`, `docs/strk20/INTEGRATION_RESEARCH.md`, installed `strk20-wallet-api` / `strk20-privacy` / `strk20-anonymizer-contracts` skills.
**Verified against:** the deployed Starknet mainnet contract surface and the current working tree.

---

## 1. Pot Collection V1 feasibility verdict

**Verdict: PARTIAL. The authorization step is browser-implementable on the deployed V1 contracts today. The token-moving step is blocked in the browser and requires a new contract version.**

What is true, verified from source:

1. The complete on-chain settlement machinery exists, is deployed on Starknet mainnet, is immutable, and is covered by contract tests (`test_payout_accounting.cairo`, `test_payout_settlement.cairo`, `test_settlement_boundary.cairo`, `test_audit_findings.cairo`).
2. The browser already implements every signing primitive needed for the authorization step: `iwa-web/src/chains/strk20/iwaSigning.ts` provides `payoutAuthorizationHash`, `payoutSettlementHash`, `recoverySettlementHash`, `authPublicKey`, `signIwa`, `verifyIwa`, `deriveMemberIdentity`, `signChecked`, with parity tests pinning it to the Cairo verifier.
3. `authorize_payout_settlement(circle_id, round, nonce, r, s)` verifies the `IWA_PAYOUT_V1` hash, which binds `(circle_id, round, member_ref, amount, nonce)` and **no open note**. This signature can be produced in the browser before any wallet interaction. The step is fully doable on V1.
4. `settle_payout_from_helper` (reached through the STRK20 pool calling the helper's `privacy_invoke` with `IwaOperation::SettlePayout`) verifies the `IWA_PAYOUT_SETTLEMENT_V1` hash, which binds `(circle_id, round, member_ref, helper, pool, token, amount, open_note_id, nonce)`. The `open_note_id` is created inside the wallet during transaction assembly, from wallet-side randomness, and is only revealed to the app through the `${openNoteIds[N]}` placeholder resolution in the wallet API. The wallet cannot produce the member auth key signature (the member auth key is a browser-derived Stark-curve key, not the wallet account key), and the browser cannot know the open note id before the wallet assembles the transaction. This is the chicken-and-egg that gates the feature in `features.ts` (`POT_COLLECTION.available = false`).
5. The deployed V1 contracts cannot be changed: no owner, no pause, no setter, no class-hash replacement, setup authority burned to zero (readable from chain).

Therefore: shipping browser pot collection on the deployed V1 contracts is possible only up to `SettlementAuthorized`. Moving tokens requires either a wallet SDK capability that does not exist today (deterministic or app-supplied open note ids, or wallet signing with an app-derived key) or a new contract version with a settlement domain that a wallet account can sign after assembly.

Recommended path (Track A): ship the V1 browser authorization step immediately; run a strict wallet capability spike; if the spike fails (expected), implement the V2 settlement domain as designed in section 3, then ship the settlement flow against V2. No server-side signer is acceptable: it is custody.

## 2. Exact existing on-chain collection path

All on Starknet mainnet. `IwaCircle` = `0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be`, `IwaStrk20Helper` = `0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb`, STRK20 pool = `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`.

### Step 0. Accounting preparation (permissionless, no auth)

`finalize_round_payout_accounting(circle_id, round)`:

- Reverts unless payout does not yet exist, circle is `Active`, `round == current_round`.
- Reverts unless every obligation in the round is final (not `Pending`).
- Recipient is `payout_order[round - 1]` (immutable order).
- `unresolved_deficit = sum(required_amount)` over uncured `MissedDefault` obligations in the round.
- `funded_amount = contribution_amount * member_limit - unresolved_deficit`; asserts `round_outstanding_liability == funded_amount`.
- Status: `DeferredLocked` if deficit > 0, else `Scheduled`.
- Writes `PayoutState { circle_id, round, scheduled_member_ref, amount, status }`, emits `PayoutAccountingPrepared`, advances `current_round` when a round remains.

### Step 1. Member authorization (browser-doable on V1)

`authorize_payout_settlement(circle_id, round, nonce, r, s)`:

- Requires payout exists; status `Scheduled`, or `DeferredLocked` whose unresolved deficit is now zero (member cured).
- Consumes `nonce` in the `payout_nonces` namespace keyed by `(circle_id, scheduled_member_ref, nonce)`.
- Verifies ECDSA over `IWA_PAYOUT_V1 = poseidon(PAYOUT_AUTH_DOMAIN_TAG, circle_id, round, member_ref, amount, nonce)` against `member_auth_keys[(circle_id, member_ref)]`.
- Sets status `SettlementAuthorized`, emits `PayoutSettlementAuthorized`. No token movement.

### Step 2. Private settlement (pool -> helper -> circle)

The wallet assembles a single STRK20 transaction with two actions:

```ts
const actions: STRK20_ACTION[] = [
  { type: "transfer", token, amount: "OPEN", recipient: userAddress },
  {
    type: "invoke",
    contract: IWA_HELPER,
    calldata: [
      SettlePayout, circleId, round, memberRef, token,
      "${openNoteIds[0]}", nonce, signatureR, signatureS,
    ],
  },
];
await account.strk20InvokeTransaction(actions);
```

The wallet opens the output note, resolves `${openNoteIds[0]}`, proves, and submits. The pool withdraws the pot to the helper, calls `privacy_invoke`, and credits the returned `OpenNoteDeposit` into the open note atomically.

Helper `privacy_invoke(IwaOperation::SettlePayout, ...)`:

- Reverts unless `caller == privacy_pool`, token supported and equal to the circle's asset.
- Reverts unless `payout.status == SettlementAuthorized` and `member_ref == scheduled_member_ref`.
- Checks outbound availability: round liability, token liability, and live balance all sufficient.
- Calls `settle_payout_from_helper(circle_id, round, token, open_note_id, nonce, r, s)`:

  - Reverts unless helper-only caller, `open_note_id != 0`, token matches, payout exists, status `SettlementAuthorized`, unresolved deficit == 0.
  - Consumes `nonce` in the separate `payout_settlement_nonces` namespace keyed by `(circle_id, scheduled_member_ref, nonce)`.
  - Verifies ECDSA over `IWA_PAYOUT_SETTLEMENT_V1 = poseidon(PAYOUT_SETTLEMENT_DOMAIN_TAG, circle_id, round, member_ref, helper, pool, token, amount, open_note_id, nonce)` against the member auth key.
  - Debits round and token liability, sets status `Paid`, emits nothing further (state read on chain).
- Helper debits its own `round_token_liability` and `token_liability`, approves the pool for the exact amount (asserting zero prior allowance), and returns `[OpenNoteDeposit { note_id, token, amount }]`.

### Step 3. Final settlement

`prepare_final_settlement(circle_id)` is permissionless, refuses while any payout is `Scheduled` or a `DeferredLocked` with zero deficit, converts uncured `DeferredLocked` into `RecoveryPending` / `NoFundedRecovery`, closes cure windows, sets `CircleStatus::SettlementPending`. Recovery uses `settle_recovery_from_helper` with domain `IWA_RECOVERY_SETTLEMENT_V1` and the same open-note binding.

## 3. Whether any contract change is required

**Yes, for the token-moving step. No change is possible to the deployed V1 contracts; any fix requires a new contract version.**

Historical V2 ideas in the original version of this document are superseded:

- **Rejected: account signature over an assembly-time open-note ID.** This does
  not provide a safe browser ordering for the immutable V1 flow and is not the
  approved V2 architecture.
- **Rejected: public ERC20 payout followed by optional shielding.** This is not
  private payout.
- **Rejected: server-side signer.** This is custody and violates `AGENTS.md`
  and `SECURITY.md`.

The selected V2 direction is the separately specified STRK20 shadow-account
flow in `2026-09-04-iwa-circle-v2-design.md`. It precommits an opaque private
identity, authenticates the proof-derived shadow caller, and atomically collects
the state-derived payout into a wallet-owned note. It does not precommit or
member-sign the final open-note ID.

The authorization step (Step 1) requires **no** contract change and can ship immediately.

## 4. Payout state machine

```
finalize_round_payout_accounting
   │
   ├─ deficit > 0 ──────────────► DeferredLocked
   │                                 │  (member cures all deficits)
   │                                 ▼
   └─ deficit == 0 ──────────────► Scheduled ──► SettlementAuthorized (member signs IWA_PAYOUT_V1)
                                          │        │
                                          │        ▼
                                          │   settle_payout_from_helper (IWA_PAYOUT_SETTLEMENT_V1)
                                          │        │
                                          │        ▼
                                          │       Paid
                                          │
   DeferredLocked (uncured at final preparation)
        │
        ├─ recovery_amount > 0 ───► RecoveryPending ──► settle_recovery_from_helper ──► Recovered
        └─ recovery_amount == 0 ──► NoFundedRecovery (terminal, no token movement)
```

Invariants of the machine (from contract code):

- A payout exists for a (circle, round) at most once (`PAYOUT_ALREADY_PREPARED`).
- Only the scheduled member's key can authorize (`IWA_PAYOUT_V1` binds member_ref and amount).
- Only `SettlementAuthorized` (or `RecoveryPending`) can be settled, with exact amount and note binding.
- `SettlementAuthorized` with `unresolved_deficit > 0` cannot settle (`PAYOUT_LOCKED`).
- Nonce namespaces are separate per action: `payout_nonces`, `payout_settlement_nonces`, `recovery_settlement_nonces`; each consumed atomically with its transition.
- `prepare_final_settlement` refuses `Scheduled`; a stranded `Scheduled` blocks circle finalization (H-2).
- `NoFundedRecovery` is terminal and is never represented as `Paid` or `Recovered`.

## 5. Good Standing claim definition

**Claim:** in circle `C`, member `M` completed at least `N` rounds with no uncured default.

Derivable entirely from public chain state via view calls:

```text
for round in 1..=N:
  obligation = get_contribution_obligation(C, round, M)
  valid iff obligation.status in { OnTime, LateWithinGrace }
             or (MissedDefault and get_cure_state(C, round, M).deficit_settled == true)
no uncured default iff every obligation in 1..=N is valid
```

Parameters: `N` (rounds threshold), optional `maxLateWithinGrace` bound. V1 circles are single-cycle; a "cycle" is `member_limit` rounds, so "completed at least 1 cycle" means `N == member_limit` with all obligations valid. Product wording: scoped claim such as "completed at least 3 savings cycles with no defaults" (multi-circle aggregation is V2; V1 claims are per-circle).

## 6. Circle Completion claim definition

**Claim:** member `M` completed the full rotation of circle `C` (all `member_limit` rounds), and the circle reached terminal accounting.

Conditions, all readable on chain:

```text
is_final_settlement_prepared(C) == true                    (status SettlementPending or Completed)
M appears in get_payout_order(C)                            (public order)
for round in 1..=member_limit:
  obligation valid as in section 5
  get_payout_state(C, round).status in { Paid, Recovered, NoFundedRecovery }
```

`SettlementAuthorized` alone is not completion; token movement must be final (`Paid`/`Recovered`) or terminal-by-definition (`NoFundedRecovery`). The claim is per-circle; cross-circle aggregation is deferred.

## 7. Shareable credential artifact design

A signed, self-describing JSON envelope (V1, no new contracts, no ZK):

```json
{
  "schema": "iwa-credential/1",
  "claim": {
    "type": "good_standing" | "circle_completion",
    "params": { "thresholdRounds": 3, "requireNoDefaults": true }
  },
  "subject": { "network": "SN_MAIN", "circleId": 1, "memberRef": "0x..." },
  "evidence": {
    "iwaCircle": "0x01f81497...",
    "issuedAtBlock": 123456,
    "issuedAt": "2026-09-04T00:00:00Z"
  },
  "signature": { "signerKey": "0x...", "r": "0x...", "s": "0x..." }
}
```

Canonical hashing reuses the existing `iwaHash` convention (`poseidon_hash_span` over `[DOMAIN_TAG, ...]`):

```text
IWA_CREDENTIAL_V1 = poseidon(IWA_CREDENTIAL_V1_TAG, schema, claimType, claimParams, network,
                             circleId, memberRef, iwaCircle, issuedAtBlock, issuedAt)
```

Signature is Stark-curve ECDSA by the member auth key (the same key registered on chain), produced in the browser with `signIwa`. The artifact carries no wallet address, no invite secret, no viewing key, and no other member's data. Verifier-side flow: re-derive the claim from public chain reads, verify the signature against `get_member_auth_key(C, member_ref)`, and require a fresh possession challenge (section 8).

The legacy Groth16 circuit (`iwa-circuit/reputation.circom`, `iwa-prover`, `iwa-verifier`) is preserved but NOT used in V1: it proves standing without revealing `member_ref` (unlinkability), which is a V2 identity capability. Adding it to V1 would re-introduce unverified cryptographic surface for no release-blocking benefit.

## 8. Cryptographic ownership / proof-of-possession design

An artifact alone is a presentation, not a proof of control. Possession is proven with a challenge-response binding the artifact to the member key:

```text
IWA_CREDENTIAL_POSSESSION_V1 = poseidon(IWA_CREDENTIAL_POSSESSION_TAG, artifactHash, verifierNonce, issuedAt)
```

- The verifier sends a fresh random `verifierNonce` (and a validity window).
- The holder signs `IWA_CREDENTIAL_POSSESSION_V1` with the same member auth key that signed the artifact.
- The verifier checks ECDSA against `signerKey` in the artifact AND against `get_member_auth_key(circleId, memberRef)` on chain, so a swapped key fails both checks.
- Policy: challenge nonce must be single-use per verifier and expire; artifact `issuedAt` must be within the verifier's freshness window.

This design resists artifact theft (stolen artifact without the key cannot answer a challenge), subject substitution (member_ref bound in the signed payload, key bound on chain), replay (fresh nonce), and verifier fail-open (every verification path must fail closed, section 13).

## 9. Privacy limitations

Must be stated in product copy and in the spec (mirrors `SECURITY.md` "Public by construction"):

- `member_ref` is public: it appears in the payout order, obligations, events, and settlement paths.
- The join transaction has a public sender; the joining wallet is correlated with its `member_ref` on chain.
- The member auth key is public per circle and is derived from one wallet signature, so the same key is registered across that member's circles: cross-circle correlation via the auth key is possible today.
- Circle existence, size, cadence, asset, round progression, obligation statuses, and payout states are public.
- STRK20 hides settlement transfers, not membership. Deposit/withdrawal edges, timing, helper invocations, and open-note amounts are public.
- The V1 artifact names `member_ref`, so presenting it to a verifier who knows the circle reveals the member's participation in that circle.
- V1 membership is not anonymous by construction; no claim to the contrary may appear in product copy.

V2 (Member Identity V2) targets per-circle pseudonyms and signer recovery to remove the cross-circle correlation. The legacy Groth16 circuit remains the candidate for unlinkable proofs once identity V2 lands.

## 10. Threat model

Assets: the pot (user funds), member privacy, credential integrity, circle accounting integrity, backend coordination data.

Actors and capabilities:

- **Member:** holds invite secret, browser-derived auth key, wallet account. Can sign contribution/cure/payout payloads.
- **Organizer:** sets circle terms, distributes invites, manages drafts. No financial power in contracts.
- **Other members:** can read all public state; can finalize defaults permissionlessly (deterministic outcome).
- **Operator/administrator:** backend allowlist, read-only surfaces. No custody, no contracts power.
- **Backend:** coordination and indexing only; no key material, no signing.
- **Verifier (B2B):** receives artifacts; must not gain raw history or cross-claim data.
- **External attacker:** any caller on chain; anyone with an artifact copy.
- **STRK20 pool / wallet infrastructure:** trusted third parties; the pool is the pinned protocol; wallet behavior is verified by spike and parity tests.

Trust boundaries: user -> wallet -> STRK20 -> helper -> circle -> chain state; frontend/backend/admin are supporting systems with no authority over funds. Each boundary is covered by the red-team matrix in section 14 and Track C.

## 11. H-2 implications

H-2 (payout liveness under a lost member key) interacts with pot collection directly:

- Pot collection requires the member's browser-derived key for both `IWA_PAYOUT_V1` (authorize) and `IWA_PAYOUT_SETTLEMENT_V1` (settle). A member who loses the wallet the key was derived from can neither authorize nor settle; the pot stays `Scheduled` and `prepare_final_settlement` refuses, freezing the circle.
- This is the same design that stops redirection, and it is accepted in V1. Nothing in Track A weakens it.
- Track A's V2 settlement domain (Option A, account-based signer) is the designed recovery vector: the member's wallet account can authorize settlement even if the browser-derived key is lost, and it preserves non-custody. Option A must preserve the invariants in SECURITY.md section "Invariants any future recovery must preserve" (no organizer override, no admin override, deterministic, no silent privacy change).
- No V1 circle is migrated or stranded by Track A; V1 and V2 coexist.

## 12. UI flows

### Track A: pot collection

- Circle timeline, member's turn: primary control "Authorize my payout" once `PayoutStatus::Scheduled` (or cured `DeferredLocked`) is read. Browser signs `IWA_PAYOUT_V1`, submits `authorize_payout_settlement`, polls for `SettlementAuthorized`. Works on V1 today.
- "Settle my payout" (after `SettlementAuthorized`): checks shielded balance readiness, explains pool fee and note maturity (~10 blocks), then runs the two-action STRK20 flow with a bound `waitForTransaction` timeout that keeps the explorer link and resumes polling. Requires the V2 settlement domain (or SDK unlock).
- `DeferredLocked`: explains the deficit and the cure path; nothing is clickable until cured.
- `RecoveryPending`: member-facing explanation and settle-recovery flow after `prepare_final_settlement`.
- Every control follows the `features.ts` capability pattern: closed controls say why, and the underlying seam throws either way.
- No forced money movement: pre-confirmation state is shown; no mainnet transaction is required merely to demo.

### Track B: Portable Trust Credential

- Standing screen gains "Portable Trust Credential" when the capability flag flips: claim picker (good standing with N, circle completion), artifact preview with exactly what is shared and what is not, then "Create artifact" (browser signs, nothing leaves the device), then share/export.
- Verifier surface: public `/verify` page accepting a pasted artifact; server-side endpoint re-derives facts from chain and checks signature and freshness. Verifier sees only the claim, validity, and metadata.
- The surface stays capability-gated until the verifier endpoint exists and is tested; generation without verification is not offered (existing rule).

## 13. Security invariants

Applied to both tracks:

1. A round's pot settles at most once (`Paid` terminal; nonce namespaces consumed atomically).
2. Only the scheduled member can authorize or settle their round; member_ref and exact amount are bound in every financial hash.
3. Settlement binds helper, pool, token, exact amount, and open note; no substitution path exists.
4. No organizer, admin, or operator path can move funds, redirect payouts, rewrite history, or erase defaults.
5. Every financial transition is replay protected in its own nonce namespace.
6. Fail closed: every validation error reverts; the UI cannot spend money or time on a seam that forgot its check.
7. The backend stores no key material and signs nothing; read sessions cannot authorize money movement.
8. Credential verification fails closed: any missing fact, stale artifact, bad signature, or unknown schema returns invalid, never "valid with warnings".
9. An artifact proves only facts derivable from public protocol history; no raw history is embedded.
10. V1 credential keys are the registered member auth keys; no new key material is created.
11. No external calls are added to the deployed V1 contracts; any V2 external call (account `is_valid_signature`) gets its own security review and invariant tests before deployment.
12. Privacy claims in copy match the actual boundary (section 9); no overclaim.

## 14. Red-team strategy

Track C executes a scripted adversarial test program mapped to the 19 mandatory areas. Each area has named test files, concrete scenarios, and pass criteria; Critical or High findings block release. The matrix:

| Area | Primary target | Must prove |
|---|---|---|
| double collect | circle contract | second settle reverts; liability never goes negative |
| wrong recipient | circle contract | non-scheduled member signature fails; helper WRONG_MEMBER |
| wrong amount | circle contract | amount mismatch fails at both helper and circle |
| wrong round | circle contract | past/future round fails; current_round enforced |
| stale state | circle contract | settled/authorized/paid states reject re-entry |
| replay | circle contract | same nonce in same namespace fails; cross-namespace nonce reuse fails |
| signature/domain/chain confusion | types + frontend signing | each domain tag distinct; parity vectors; wrong-chain config fails closed |
| organizer/admin privilege escalation | contracts + backend | organizer cannot act financially; admin routes refuse sessions and non-allowlisted wallets |
| session escalation | backend | read sessions cannot reach admin or money-movement endpoints |
| credential forgery | artifact verifier | unsigned, wrong-key, tampered, stale artifacts invalid |
| N mutation | artifact verifier | threshold above actual standing invalid |
| credential type mutation | artifact verifier | good_standing vs circle_completion not interchangeable |
| subject substitution | artifact verifier | member_ref swap invalidates signature and chain check |
| artifact theft/reuse | possession protocol | stolen artifact fails live challenge; reuse across verifiers fails |
| verifier fail-open | verifier endpoint | every failure path returns invalid; no partial-valid states |
| malformed/truncated artifacts | verifier endpoint | schema, field, and encoding errors reject cleanly |
| cross-circle leakage | verifier + backend | one circle's claim reveals nothing about another; no aggregate endpoints in V1 |
| sensitive logging/API leakage | backend + frontend | no member_ref, key, invite token, or private data in logs or responses |

Full scenarios, files, and blocking rules are in the Track C plan.

## 15. Release gates

For Track A authorization step: Cairo suite green (190+), frontend suite green (555+), new frontend tests green, production build clean, `tsc -b` clean, mainnet read verification of the new UI path, no contract change, no backend change.

For Track A settlement (V2 route): all Cairo tests including new V2 settlement tests, red-team matrix clean with no Critical/High open, STRK20 integration verified with a real privacy-enabled wallet on a public network at minimal value, external-call review of `account.is_valid_signature` completed, deployment config and addresses verified read-only, secrets scan clean, `STATUS.md` updated.

For Track B: artifact builder and verifier test suites green, backend verify endpoint tests green (including Postgres-free paths), copy tests updated for any new product wording, capability flag flipped only after the verifier is live, red-team matrix clean.

Common: no commit/push/deploy without explicit instruction; commit only verified work; no AI attribution.

## 16. Deferred V2 work

- IwaCircle V2: account-based settlement signer, payout liveness recovery (H-2), capability reporting.
- Member Identity V2: per-circle pseudonyms, auth key epochs, signer recovery, no email-derived identity.
- Groth16-based unlinkable credentials (`iwa-circuit`/`iwa-prover`/`iwa-verifier`) after identity V2; external audit before any V2 mainnet deployment.
- Cross-circle standing aggregation and multi-cycle claims.
- Multichain: Base/EVM, Ethereum/BNB where justified, Solana later.
- Embedded email/passkey accounts (STRK20 feasibility spike first).
- Real product analytics on a proper event source.

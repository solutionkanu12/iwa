# Portable Trust Credential V2 Design

**Status:** Revised design artifact. Nothing in this V2 design is implemented, tested, or deployed. V2 credential implementation is blocked behind the Starknet private payout capability gate.
**Depends on:** `2026-09-04-iwa-circle-v2-design.md` (identity and protocol state), V1 circle state (unchanged), legacy Groth16 work (`iwa-circuit`, `iwa-prover`, `iwa-verifier`, preserved, not reused without rewrite).
**Sources:** `PROJECT.md`, `SECURITY.md`, `ARCHITECTURE.md`, `docs/domain/IWA_INVARIANTS.md` (INV-011, INV-017).

---

## 1. Goals

- Verifiable, shareable credentials for both approved claim types against both V1 and V2 circles.
- Versioned schemas (`iwa-credential/1` for V1 circles, `iwa-credential/2` for V2 circles) with strict version routing.
- Ownership verification separate from claim verification; the artifact is never a bearer credential.
- V2 claims use circle-scoped member references so a credential does not correlate a person across circles.
- Optional ZK variant designed but gated behind circuit rewrite and audit; never claimed as live until it is.

## 2. Non-goals

- No universal numeric score, no raw savings history in artifacts or verifier responses.
- No on-chain credential registry (facts are already public on chain; the artifact is off-chain).
- No new contracts are currently proposed for credentials (V2 identity keys and public state are the intended trust anchors). This assumption must be rechecked after the private payout primitive is selected.
- No ZK in the first credential release.
- No server-side storage of artifacts, keys, or member data.

## 3. Current V1 limitation

- V1 has a claim model and device-side proving from the legacy implementation but no deployed verifier and no versioned artifact schema; nothing can check a proof, so the capability is gated closed.
- V1 member_ref and auth key are the same across a member's circles, so a V1-style artifact would enable cross-circle correlation.
- V1 auth keys are non-rotatable; credentials signed by them break conceptually on rotation.

## 4. Architecture

```text
Member device:
  identity root -> circle_secret -> member_ref_v2 / identity key   (per circle)
  claim facts from public chain state
  artifact builder (signed by identity key, IWA_CREDENTIAL_V2 domain)
        |
        v
Artifact (JSON, versioned) ---> Holder shares file or link
        |
        v
Verifier: version detection -> routed verifier:
  1. ownership/integrity check (signature + possession challenge)
  2. claim validity against canonical public chain state
  only both pass -> "Verified"; chain unavailable -> "Unable to verify"; never fail open
```

Trust anchors: the identity public key registered on chain per (circle, member_ref) and the public obligation/payout state on the circle contract. The artifact is a presentation of public facts plus a signature; the verifier re-derives the facts from chain.

## 5. Claims (exact definitions)

### 5.1 Good Standing (V2)

In circle C (V2 protocol), member M completed at least N qualifying rounds with zero defaults, N bound into the credential:

```text
qualifying(obligation) = status in { OnTime, LateWithinGrace }
zero_defaults(1..N)   = no obligation in rounds 1..N has status MissedDefault,
                        whether or not it was later cured
claim holds iff for all r in 1..N: qualifying(obligation(r)) and zero_defaults(1..N)
```

Derived from public obligations via `get_contribution_obligation_v2` and `get_cure_state_v2`. N is a credential parameter; the verifier checks N against the member's actual completed rounds and member_limit.

### 5.2 Circle Completion (V2)

In circle C, member M successfully completed the circle:

```text
circle reached terminal accounting (final_settlement_prepared_v2 == true)
M is in the payout order
M's own payout state for M's scheduled round is PrivatelyPaid or PrivatelyRecovered
```

- PrivatelyPaid qualifies only after verified private value movement to the member-bound destination.
- PrivatelyRecovered qualifies only after verified private recovery of the deterministic net amount to the member-bound destination.
- NoFundedRecovery does not qualify.
- Scheduled, PrivateSettlementAuthorized, and RecoveryPending do not qualify.
- Other members' defaults do not disqualify M's completion claim; M's blemish-free record is the Good Standing claim's job.

The names above are design names. They are not final ABI values until the private payout primitive passes the capability gate and the state machine is frozen.

### 5.3 V1 circle variants

The same two claims defined against V1 state: V1 Good Standing uses V1 obligations (OnTime/LateWithinGrace, no MissedDefault in 1..N); V1 Circle Completion uses `is_final_settlement_prepared` and payout states {Paid, Recovered} (V1 recovery semantics preserved: Recovered qualifies because it is the member's own settled recovery; NoFundedRecovery does not).

## 6. Artifact schemas

### 6.1 `iwa-credential/1` (V1 circles)

```json
{
  "schema": "iwa-credential/1",
  "claim": { "type": "good_standing" | "circle_completion", "params": { "thresholdRounds": 3 } },
  "subject": { "network": "SN_MAIN", "circleId": 1, "memberRef": "0x..." },
  "evidence": { "iwaCircle": "0x...", "issuedAtBlock": 123, "issuedAt": "..." },
  "signature": { "signerKey": "0x...", "r": "0x...", "s": "0x..." }
}
```

Signed by the V1 member auth key. `signerKey` must match `get_member_auth_key(circle, member_ref)` on the V1 contract.

### 6.2 `iwa-credential/2` (V2 circles)

```json
{
  "schema": "iwa-credential/2",
  "claim": { "type": "good_standing" | "circle_completion", "params": { "thresholdRounds": 3 } },
  "subject": { "network": "SN_MAIN", "circleId": 1, "memberRef": "0x..." },
  "evidence": { "iwaCircleV2": "0x...", "issuedAtBlock": 123, "issuedAt": "..." },
  "signature": { "signerKey": "0x...", "r": "0x...", "s": "0x..." }
}
```

Signed by the member's V2 identity key (stable across auth-key rotations). `signerKey` must match the identity public key registered on the V2 contract, and `memberRef` is circle-scoped, so the same person presents a different memberRef per circle.

### 6.3 Canonical hashing and domains

```text
IWA_CREDENTIAL_V1 = poseidon(IWA_CREDENTIAL_V1_TAG, schema, claimType, claimParams,
                             network, circleId, memberRef, iwaCircle, issuedAtBlock, issuedAt)
IWA_CREDENTIAL_V2 = poseidon(IWA_CREDENTIAL_V2_TAG, schema, claimType, claimParams,
                             network, circleId, memberRef, iwaCircleV2, issuedAtBlock, issuedAt)
IWA_CREDENTIAL_POSSESSION_V1/V2 = poseidon(POSSESSION_TAG, artifactHash, verifierNonce, issuedAt)
```

Distinct tags keep version and domain separation: a V1 signature never validates a V2 artifact and vice versa.

## 7. Ownership verification

Two independent checks, both required:

1. Integrity: ECDSA over the canonical artifact hash, checked against the artifact's `signerKey` and against the key registered on chain for that (circle, memberRef, version).
2. Possession: challenge-response. The verifier sends a fresh single-use nonce; the holder signs `IWA_CREDENTIAL_POSSESSION_*` with the same key; the verifier checks ECDSA and freshness. An artifact without a live possession response is a presentation, not proof.

Policy: possession nonces expire (5 minutes), artifacts expire per verifier freshness window, and any failure returns "Invalid" with a reason. The challenge binds schema version, credential hash, verifier origin or verifier identifier, nonce, and expiry so possession proof cannot replay across versions or verifiers.

## 8. ZK variant (designed, gated)

Goal: prove Good Standing without revealing memberRef, so the verifier cannot correlate the holder across circles. Design:

- V2 contract stores the member_ref Merkle root at circle activation (membership closes at activation, so the root is fixed and public).
- Rewritten Groth16 circuit (BN254, from `reputation.circom`): private inputs = circle_secret, path; public inputs = root, threshold N, claim type, nullifier; proves memberRef(root membership) and the claim facts, without revealing which leaf.
- The nullifier binds member + claim to prevent reuse.
- Gates: circuit rewrite, constraint review, trusted-setup handling, external audit, verifier contract deployment. Not part of the first credential release; never claimed as live beforehand.

## 9. Privacy model

- V2 artifact reveals: circle, circle-scoped memberRef, claim type and N, timestamps, signer key (identity public key, circle-scoped and public on chain).
- V2 artifact reveals nothing about other circles (distinct memberRef, distinct identity key per circle).
- No raw round-by-round history in the artifact; the verifier re-derives only the facts the claim needs.
- Verifier responses contain only validity and claim metadata.
- V1 artifacts necessarily expose more context (V1 memberRef and auth key are cross-circle); this is documented and versioned.
- Logs, backend responses, and admin surfaces never contain memberRef, keys, or artifact bodies (enforced by tests).

## 10. Data flow

Holder: read public state -> build canonical payload -> sign with identity key -> artifact file or link. Verifier: paste artifact -> version detection -> ownership check (signature + possession) -> claim check (chain re-derivation) -> "Verified" / "Invalid" / "Unable to verify".

## 11. Error handling

- Unknown schema version: rejected, never reinterpreted.
- Malformed, truncated, wrong-typed, oversized fields: rejected with schema-safe errors.
- Chain unavailable: "Unable to verify" (never valid).
- Signature, possession, freshness, or fact mismatch: "Invalid" with a reason.
- Every path fails closed; there is no partial-valid state.

## 12. Interfaces

```text
frontend:
  lib/credential/claims.ts        claim types, params, canonical payload
  lib/credential/artifact.ts      builder + signer (identity key for V2, auth key for V1)
  lib/credential/verify.ts        pure verification core (shared rules)

backend:
  POST /api/credential/verify     stateless, version-routed, public
  GET  /api/circle/:id/version    protocol version of a circle (indexed)

contract reads (public views, no new contracts):
  V1: get_member_auth_key, get_contribution_obligation, get_cure_state,
      get_payout_state, is_final_settlement_prepared
  V2: get_member_v2 (identity key), get_contribution_obligation_v2,
      get_cure_state_v2, get_payout_state_v2, is_final_settlement_prepared_v2
```

## 13. Threat model

- Forged Good Standing / Circle Completion: signature + chain re-derivation; self-asserted numbers impossible (facts come from chain).
- N mutation: N bound in the signed payload and re-checked against chain facts.
- Claim-type mutation: type bound in the signed payload.
- Subject substitution: memberRef and signerKey bound and re-checked on chain.
- Artifact reuse: freshness window + single-use possession nonce.
- Artifact theft: possession challenge requires the private key; a stolen file alone is not accepted.
- Malformed proof: strict schema validation, fail closed.
- Verifier fail-open: every failure returns invalid or unable-to-verify; tested exhaustively.
- Chain evidence substitution: the verifier reads the pinned circle contract address from version-routed configuration, never from the artifact alone.
- Cross-circle correlation: circle-scoped identity (V2); documented V1 limitation.
- Privacy leakage: no member data in logs or responses; backend stores nothing.

## 14. Testing

- Pure verify-core tests for every failure branch.
- Artifact builder tests: canonicalization, tamper sensitivity, key binding.
- Backend route tests: version routing, unknown-version rejection, fail-closed behavior, no-leak assertions.
- Fixture-based chain-state tests for both V1 and V2 claim definitions, including cured-default (Good Standing fails), authorization-only (Completion fails), no-funded-recovery (Completion fails), and verified private recovery (Completion qualifies) edge cases.
- Copy tests for product wording (no credit score, no privacy overclaim).
- Red-team coverage in the V2 security release spec.

## 15. Compatibility

- `iwa-credential/1` verifies V1 circles exactly as V1 state defines them; a V1 artifact can never be interpreted under V2 rules.
- `iwa-credential/2` verifies V2 circles; signer key rules differ per version and are routed by schema.
- Unknown versions are rejected; future schemas add a new version instead of mutating an old one.

## 16. Migration behavior

- None. Credentials are derived per circle and per version; nothing migrates.

## 17. Deferred work

- ZK unlinkable variant (section 8).
- Cross-circle aggregation and multi-cycle claims.
- Verifier API products (B2B tiers, per-verification fees) on top of the same verification core.

## 18. Release dependency

`iwa-credential/2` must not be implemented against the rejected public-transfer V2 design. Its Circle Completion verifier depends on the final, tested private payout state machine. Good Standing rules and owner-bound artifact design may be tested independently, but the V2 credential capability stays closed until the private payout gate, V2 contract implementation, red-team program, and testnet verification pass.

Internal tests are not an external audit, and no document may describe this credential design as audited or live.

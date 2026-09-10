# Iwa Portable Trust Credential V1 Implementation Plan (Track B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a verifiable Portable Trust Credential for V1: a signed, shareable artifact proving a scoped reliability claim (Good Standing or Circle Completion) derived from public on-chain state, verified by a fail-closed server endpoint and, later, by a public verifier page. No new contracts, no ZK, no custody, no raw history in the artifact.

**Spec:** `docs/superpowers/specs/2026-09-04-pot-collection-portable-trust-credential-design.md` sections 5, 6, 7, 8, 9, 13, 15. Supporting: `PROJECT.md`, `SECURITY.md`, `ARCHITECTURE.md`.

## Global Constraints

- No automatic commit, push, or deploy at any step. Commits only when explicitly instructed and only after verification.
- Do not change contracts. V1 credential uses only public view calls and the existing member auth key.
- Do not use the legacy Groth16 circuit (`iwa-circuit`, `iwa-prover`, `iwa-verifier`) in V1. It is preserved for V2 identity/unlinkability work only.
- Do not change `iwa-PRD.md`, `iwa-PRD.md.md`, or `install.cmd`.
- Preserve frontend visual design and copy conventions.
- The capability stays gated (`CREDENTIAL_VERIFICATION.available = false`) until the verifier endpoint is live and tested; generation without verification is not offered.
- The backend stores no key material and no artifacts; verification is stateless per request.
- Never call the credential a credit score; never present raw savings history to a verifier.
- No em dashes or exclamation marks in new copy.
- Update `STATUS.md` after each verified milestone.
- No AI attribution in commits.

## Existing files this plan builds on

```text
iwa-web/src/chains/strk20/iwaSigning.ts           iwaHash, signIwa, verifyIwa, deriveMemberIdentity, signChecked
iwa-web/src/chains/strk20/iwaSigning.test.ts      parity vectors
iwa-web/src/lib/features.ts                       CREDENTIAL_VERIFICATION gated
iwa-web/src/lib/standing.ts                       per-circle standing derivation
iwa-web/src/lib/standing.test.ts
iwa-web/src/lib/backend.ts                        backend client conventions
iwa-web/src/screens/StandingView.tsx              saver standing screen
iwa-web/src/screens/ProveView.tsx                 legacy proving screen (gated, preserved, not reused)
backend/src/routes                                existing route conventions (app.ts wiring)
backend/test/api.test.ts                          route test conventions
contracts/starknet/src/iwa_circle.cairo           public view reads only (reference)
iwa-web/src/lib/router.ts                         route table (verifier page route addition)
iwa-web/src/lib/router.test.ts
```

## File Structure (new and changed)

```text
iwa-web/src/lib/credential/claims.ts               claim schema, types, canonical payload
iwa-web/src/lib/credential/claims.test.ts
iwa-web/src/lib/credential/artifact.ts             artifact builder and signer
iwa-web/src/lib/credential/artifact.test.ts
iwa-web/src/lib/credential/verify.ts               pure verification core (shareable with backend)
iwa-web/src/lib/credential/verify.test.ts
backend/src/credentialVerify.ts                    stateless verify endpoint handler
backend/src/credentialVerify.test.ts
backend/src/app.ts                                 route wiring (edit)
iwa-web/src/screens/StandingView.tsx               credential surface (edit)
iwa-web/src/screens/CredentialShareView.tsx        artifact preview/share
iwa-web/src/screens/CredentialShareView.test.tsx
iwa-web/src/screens/VerifyView.tsx                 public verifier page
iwa-web/src/lib/router.ts                          /verify route (edit)
iwa-web/src/lib/router.test.ts
iwa-web/src/lib/features.ts                        capability flip (edit, only at gate)
iwa-web/src/lib/copy.test.ts                       new-copy truth guard (edit)
```

## Task B1: claim schema and canonical payload

- [ ] Test first: `claims.test.ts` covers: `good_standing` and `circle_completion` claim types with exact params, canonical payload ordering is deterministic, unknown claim types rejected, threshold bounds validated (N >= 1, N <= member_limit for the circle), `requireNoDefaults` boolean only, felt encoding matches the `iwaHash` convention.
- [ ] Implement `claims.ts`: claim types, params, `canonicalPayload(claim, subject, evidence)` producing the exact field list hashed under `IWA_CREDENTIAL_V1` per spec section 7.
- [ ] Verify: `cd iwa-web && npx vitest run` on the new suite; `tsc -b`.

## Task B2: artifact builder and signer

- [ ] Test first: `artifact.test.ts` covers: artifact builds from valid claim+subject+evidence, signature verifies with `verifyIwa`, tampering any field (claim type, params, memberRef, circleId, network, evidence) invalidates verification, memberRef zero rejected, signer key must equal the member auth key supplied by the caller, deterministic canonicalization across field orderings, no wallet address, invite secret, or viewing key ever appears in the artifact.
- [ ] Implement `artifact.ts`: build the JSON envelope (spec section 7), sign the `IWA_CREDENTIAL_V1` hash with the derived member identity via `signChecked`, never persist the artifact or the key.
- [ ] Verify: new suite green; existing `iwaSigning.test.ts` parity vectors untouched and green.

## Task B3: pure verification core

- [ ] Test first: `verify.test.ts` covers the full fail-closed matrix: valid artifact verifies only when facts, signature, freshness, and key all hold; wrong key fails; stale `issuedAt` fails; N above actual standing fails; `circle_completion` claim fails when a payout is `SettlementAuthorized` but not `Paid`/`Recovered`/`NoFundedRecovery`; member not in payout order fails; uncured default fails; malformed JSON, truncated JSON, wrong schema version, and non-felt values reject without throwing raw errors; every failure returns `invalid` with a reason, never `valid` with warnings.
- [ ] Implement `verify.ts`: recompute the claim from a fixture on-chain state snapshot (pure function of provided state, so it is testable without a network), check ECDSA against the artifact signer key, enforce freshness policy, enforce chain-identity checks (network + circle contract).
- [ ] Verify: new suite green.

## Task B4: stateless backend verify endpoint

- [ ] Test first: `credentialVerify.test.ts` (backend conventions): endpoint returns `valid` for a fixture artifact whose facts match a fixture chain state; `invalid` for each tamper case; unknown schema returns 400 with no schema detail leaked; unauthenticated callers may use the public endpoint (verification is public by design) but the endpoint returns no member data beyond claim validity; no key material or invite token in any response; request-bound only, no sessions involved.
- [ ] Implement `credentialVerify.ts` and wire a `POST /api/credential/verify` (or GET with a capped body) into `backend/src/app.ts` following existing validation and response conventions; the handler fetches the public chain state it needs (circle view, payout order, obligations, cure states, payout states, final-prepared flag) and runs `verify.ts` logic; fail closed on any RPC error (return invalid, not 500-with-partial-data).
- [ ] Verify: `cd backend && npx vitest run` (existing 245 must stay green), `npm run typecheck`.
- [ ] Do not store artifacts, keys, or member data anywhere.

## Task B5: saver credential surface

- [ ] Test first: `CredentialShareView.test.tsx` covers: claim picker offers only claims the member's actual standing supports, artifact preview states exactly what is shared and what is not, create button disabled until the capability flag is open, closed state uses the existing features.ts wording, no wallet address or invite token rendered, copy/export copies the artifact only.
- [ ] Implement `CredentialShareView.tsx` and wire into `StandingView.tsx` per existing visual patterns (no redesign). Keep the surface capability-gated.
- [ ] Update `copy.test.ts` with truth guards for the new copy (no credit score, no em dashes, no overclaim of privacy).
- [ ] Verify: full frontend suite, `tsc -b`, production build clean.

## Task B6: public verifier page

- [ ] Test first: `router.test.ts` additions for `/verify` route and `VerifyView` rendering tests: paste artifact -> valid result, invalid result, malformed input messaging, no console or UI leakage of member history.
- [ ] Implement `VerifyView.tsx` and the `/verify` route in `router.ts`; the page calls the backend endpoint and shows only claim validity and metadata.
- [ ] Verify: full frontend suite, `tsc -b`, production build clean.

## Task B7: capability flip and release gates

- [ ] Run the Track C red-team matrix against the credential surface; no Critical or High findings open.
- [ ] Confirm the endpoint is deployed before flipping `CREDENTIAL_VERIFICATION.available`; the flip itself is a reviewed one-line change with tests updated.
- [ ] Re-run: frontend suite, backend suite, Cairo suite (must be untouched and green), production build, `deployHeaders` tests.
- [ ] Mainnet read verification of the endpoint against Circle 1 state.
- [ ] Update `README.md` live-feature wording only if approved and per the product copy rules; update `STATUS.md` with verified results.
- [ ] No commit, push, or deploy without explicit instruction.

## Acceptance criteria

- A saver can create a signed Portable Trust Credential for a Good Standing or Circle Completion claim that verifies against public mainnet state.
- A verifier can check the artifact through the public endpoint and receives only claim validity and metadata.
- No artifact, key, or private data is stored by the backend; nothing is logged.
- Every failure path returns invalid; no fail-open state exists.
- Red-team matrix clean; capability gate flipped only after the verifier is live.
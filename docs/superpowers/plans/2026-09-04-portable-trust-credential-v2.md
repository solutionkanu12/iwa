# Portable Trust Credential V2 Implementation Plan (Track 2)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. TDD: failing test first, expected failure, minimal implementation, passing command, regression, STOP for review.
> **No commit, push, or deploy steps exist in this plan.** Commits are approved separately.

**Spec:** `docs/superpowers/specs/2026-09-04-portable-trust-credential-v2-design.md`
**Depends on:** Track 1 capability gate G5, implemented V2 identity keys and private payout state views, plus Track 3 version routing and registry. Source-level verdict B does not unblock this plan; it begins only after the real-wallet shadow-account gate passes.

**Baseline:** existing V1 suites green; the credential capability flag stays closed until the verifier path is live.

## Task CR-1: claim schema and canonical payload (shared)

- Files: `iwa-web/src/lib/credential/claims.ts` (new), `iwa-web/src/lib/credential/claims.test.ts` (new)
- Interfaces: `ClaimType = "good_standing" | "circle_completion"`, `ClaimParams { thresholdRounds?: number }`, `canonicalPayload(version, claim, subject, evidence) -> bigint` per the spec section 6.3 field lists for versions 1 and 2; `validateClaimParams(params, memberLimit)`.
- Failing test: exact canonical field ordering per version; unknown claim type rejected; N bounds (1 <= N <= member_limit) enforced; N missing for good_standing rejected; N forbidden for circle_completion; felt encoding matches the V2 frontend reference; version tags never cross.
- Expected failure: `Error` on invalid params/unknown type.
- Minimal implementation: schema types and canonical hashing using the existing `iwaHash` convention.
- Passing command: `cd iwa-web && npx vitest run src/lib/credential/claims.test.ts`
- Expected pass: all cases green.
- Regression command: `npx vitest run`
- Review checkpoint: canonical payload and tags frozen and cross-checked with the Cairo parity suite (Track 1 T12).

## Task CR-2: artifact builder and signer

- Files: `iwa-web/src/lib/credential/artifact.ts` (new), `iwa-web/src/lib/credential/artifact.test.ts` (new)
- Interfaces: `buildArtifact(version, claim, subject, evidence, signer: { key, sign }) -> Artifact`; V1 signs with the member auth key (`signChecked`), V2 signs with the identity key (from the identity module in Track 3); `schema` = `iwa-credential/1` or `iwa-credential/2`.
- Failing test: envelope shape matches the spec JSON; signature verifies with `verifyIwa` against the declared signerKey; tampering any field invalidates; a V1 signature does not verify a V2 payload and vice versa; zero memberRef rejected; no wallet address, invite secret, or viewing key ever appears in the artifact; nothing is persisted.
- Expected failure: verification failures on every tamper case.
- Minimal implementation: canonical payload -> sign -> envelope.
- Passing command: `npx vitest run src/lib/credential/artifact.test.ts`
- Expected pass: green.
- Regression command: `npx vitest run`
- Review checkpoint: artifact shape approved before UI work.

## Task CR-3: pure verification core

- Files: `iwa-web/src/lib/credential/verify.ts` (new), `iwa-web/src/lib/credential/verify.test.ts` (new)
- Interfaces: `verifyArtifact(artifact, chainState, policy) -> { status: "valid" | "invalid", reason? }`; `verifyPossession(artifactHash, nonce, signedAt, signature, chainState) -> boolean`; chainState is a pure fixture object (testable without a network) covering V1 and V2 views.
- Failing test: the full fail-closed matrix: valid artifact verifies only when facts, signature, freshness, and key all hold; cured default fails Good Standing; Scheduled, PrivateSettlementAuthorized, RecoveryPending, and NoFundedRecovery fail Circle Completion; only the final G5-approved `PrivatelyPaid` and `PrivatelyRecovered` states pass; N above actual standing fails; claim-type swap fails; memberRef or signerKey swap fails; stale artifact fails; expired, reused, cross-version, or cross-verifier possession nonces fail; malformed, truncated, wrong-schema, wrong-typed inputs reject with schema-safe reasons; every failure returns `invalid` with a reason; no partial-valid state.
- Expected failure: each specific `invalid` reason.
- Minimal implementation: verification rules per version.
- Passing command: `npx vitest run src/lib/credential/verify.test.ts`
- Expected pass: green.
- Regression command: `npx vitest run`
- Review checkpoint: verify-core rules reviewed against the claim definitions (spec 5.1-5.3).

## Task CR-4: stateless version-routed backend endpoint

- Files: `backend/src/credentialVerify.ts` (new), `backend/src/credentialVerify.test.ts` (new), `backend/src/app.ts` (edit), `backend/src/config.ts` (edit: versioned contract registry from the compatibility plan)
- Interfaces: `POST /api/credential/verify`; body `{ artifact, possession?: { nonce, signedAt, r, s } }`; routes by schema version to V1 or V2 rules; resolves contract addresses from the registry, never from the artifact alone; returns `{ status: "valid" | "invalid" | "unable_to_verify", reason?, claimMeta }`; public endpoint, no sessions; no storage.
- Failing test: valid V1 artifact and valid V2 artifact each verify against their own rules; unknown schema version rejected (400, no schema detail leaked); every tamper case returns invalid; RPC failure or timeout returns `unable_to_verify`, never valid; no memberRef, key, invite token, or artifact body in logs or responses; request-size cap enforced; possession required when policy demands it.
- Expected failure: invalid statuses and leak assertions fail until implemented.
- Minimal implementation: version dispatch, chain reads, verify-core integration.
- Passing command: `cd backend && npx vitest run src/credentialVerify.test.ts` (suite name adjusted to conventions)
- Expected pass: green; existing backend suites stay green.
- Regression command: `cd backend && npx vitest run && npm run typecheck`
- Review checkpoint: no-leak assertions reviewed against SECURITY.md.

## Task CR-5: saver credential surface (V2)

- Files: `iwa-web/src/screens/StandingView.tsx` (edit), `iwa-web/src/screens/CredentialShareView.tsx` (new), `iwa-web/src/screens/CredentialShareView.test.tsx` (new), `iwa-web/src/lib/features.ts` (edit), `iwa-web/src/lib/copy.test.ts` (edit)
- Interfaces: claim picker offers only claims the member's actual standing supports (per version); preview states exactly what is shared and what is not; create button gated by `CREDENTIAL_VERIFICATION` availability, which flips only after CR-4 is live; V2 subjects use the circle-scoped memberRef and identity key; V1 subjects keep the V1 path.
- Failing test: unsupported claims not offered; preview text honest; gated wording preserved until flip; no wallet address or invite token rendered; copy guards pass (no credit score, no em dashes, no privacy overclaim); V2 artifact shows no cross-circle identifiers.
- Expected failure: copy-guard and gating assertions fail before implementation.
- Minimal implementation: picker, preview, artifact creation, export.
- Passing command: `cd iwa-web && npx vitest run` then `npx tsc -b` then `npm run build`
- Expected pass: all green; build clean.
- Regression command: full frontend suite.
- Review checkpoint: visual parity with the existing Standing screen (no redesign).

## Task CR-6: public verifier page

- Files: `iwa-web/src/lib/router.ts` (edit), `iwa-web/src/lib/router.test.ts` (edit), `iwa-web/src/screens/VerifyView.tsx` (new), `iwa-web/src/screens/VerifyView.test.tsx` (new)
- Interfaces: `/verify` route; paste artifact -> backend verification -> "Verified" / "Invalid" / "Unable to verify"; possession step for holders; version shown on screen.
- Failing test: route resolves; valid, invalid, and unable-to-verify states render correctly; malformed input messaging; no member history rendered; no console leakage.
- Expected failure: route or state assertions fail.
- Minimal implementation: page, route, backend call.
- Passing command: `cd iwa-web && npx vitest run && npx tsc -b && npm run build`
- Expected pass: green; build clean.
- Regression command: full frontend suite.
- Review checkpoint: page copy approved; no new visual language.

## Task CR-7: ZK gate decision (deferred by default)

- Files: `docs/superpowers/specs/2026-09-04-portable-trust-credential-v2-design.md` section 8 (review), `docs/strk20/INTEGRATION_RESEARCH.md` (edit)
- Interfaces: decision record: whether the ZK variant enters a gated design phase now or stays deferred; criteria: identity V2 landed, verifier endpoint live, external audit capacity available.
- Failing test: none (decision document).
- Expected failure: n/a.
- Minimal implementation: a dated decision entry; if approved, a separate plan is written; the legacy `reputation.circom` is not reused without a rewrite and audit.
- Passing command: document review.
- Expected pass: decision recorded.
- Regression command: n/a.
- Review checkpoint: no ZK claims added to product copy.

## Acceptance criteria

- Both claim types verify against both versions through the live endpoint.
- Artifact is never a bearer credential; possession is always required.
- No fail-open path exists; every failure is invalid or unable-to-verify.
- The capability flag flips only after the endpoint is live and the red-team matrix is closed.
- V2 Circle Completion is implemented only against a tested private-settlement state machine; no public ERC20 payout state can qualify.

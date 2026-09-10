# Iwa Pot Collection + Credential Red-Team Release Plan (Track C)

> **Scope note (2026-09-07):** This is the V1 security/release record. V2 uses
> `2026-09-04-v2-red-team-testnet-release.md`. V2 has source-level verdict B,
> but its runtime wallet, deployment, and real-pool gates remain open.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripted adversarial test program that must pass with no Critical or High findings open before pot collection and Portable Trust Credential V1 can release. Every mandatory area maps to named test files with concrete scenarios and blocking rules.

**Spec:** `docs/superpowers/specs/2026-09-04-pot-collection-portable-trust-credential-design.md` sections 13 and 14. Supporting: `SECURITY.md`, `docs/domain/IWA_INVARIANTS.md`, `ARCHITECTURE.md`.

## Global Constraints

- No automatic commit, push, or deploy at any step.
- Critical or High findings block release. Medium and Low findings must be recorded with a disposition (fixed, accepted with rationale, or deferred with a tracked owner) before release.
- Every red-team scenario is written as a failing test first where it targets code, or as a scripted manual scenario where it targets deployment behavior.
- Red-team work never uses mainnet funds beyond minimal approved verification values, and only read-only calls otherwise.
- Do not weaken the security model to pass a finding; reduce scope instead.
- Update `SECURITY.md` and `STATUS.md` with verified findings and dispositions.
- No AI attribution in commits.

## Test harness and file structure

```text
# Contract-level adversarial suite (Cairo, test-first)
contracts/starknet/tests/test_redteam_pot_collection.cairo
contracts/starknet/tests/test_redteam_recovery.cairo
contracts/starknet/tests/test_redteam_v2_settlement.cairo        (only when Track A V2 exists)
contracts/starknet/tests/test_redteam_credential_facts.cairo

# Frontend adversarial suite (Vitest)
iwa-web/src/chains/strk20/redteamSettlement.test.ts
iwa-web/src/lib/credential/redteamArtifact.test.ts
iwa-web/src/lib/credential/redteamVerify.test.ts

# Backend adversarial suite (Vitest + supertest)
backend/test/redteamCredentialVerify.test.ts
backend/test/redteamEscalation.test.ts

# Deployment behavior checklist (scripted, manual)
scripts/demo/redteam_deployment_checklist.md
```

## Task C1: double collect

- [ ] Contract test: settle a payout to `Paid`, then attempt `settle_payout_from_helper` again with a fresh nonce: must revert `PAYOUT_NOT_AUTHORIZABLE`; `round_outstanding_liability` never goes below zero; `round_settled_outflows` sums exactly once.
- [ ] Contract test: attempt a second `finalize_round_payout_accounting` for the same round: must revert `PAYOUT_ALREADY_PREPARED`.
- [ ] Contract test: `settle_recovery_from_helper` after `Recovered`: must revert; recovery nonce namespace cannot double-spend.
- [ ] Blocking rule: any path that moves the pot twice is Critical.

## Task C2: wrong recipient

- [ ] Contract test: a non-scheduled member's valid signature over `IWA_PAYOUT_V1` fails `INVALID_SIGNATURE`; the helper's `privacy_invoke` with a non-scheduled `member_ref` fails `WRONG_MEMBER`.
- [ ] Contract test: organizer cannot authorize, settle, or recover any round (organizer holds no member auth key).
- [ ] Frontend test: the authorize control is only offered to the member whose `member_ref` the derived identity matches (from public reads, not from a claim).
- [ ] Blocking rule: any recipient substitution is Critical.

## Task C3: wrong amount

- [ ] Contract test: settlement with any amount other than `payout.amount` fails at the hash/solvency layer; `assert_round_can_debit` blocks over-debit; helper `assert_outbound_available` blocks amounts above round and token liability.
- [ ] Contract test: recovery amount must equal `get_recovery_amount`; zero-value `NoFundedRecovery` cannot be turned into a token operation.
- [ ] Blocking rule: any path moving more than the exact accounted amount is Critical.

## Task C4: wrong round

- [ ] Contract test: settle round 1's pot against round 2's payout key fails; `round == current_round` enforcement in contribution paths; payout keys are exact `(circle_id, round)` pairs.
- [ ] Contract test: recovery for a round without `recovery_amount_exists` fails `RECOVERY_NOT_READY`.
- [ ] Frontend test: timeline never offers actions for a round other than the current one.
- [ ] Blocking rule: cross-round settlement or recovery is Critical.

## Task C5: stale state

- [ ] Contract test: `SettlementAuthorized` -> `Paid` transitions only from the exact predecessor state; `DeferredLocked` with unresolved deficit cannot be settled; `Scheduled` cannot be settled directly; `RecoveryPending` cannot be settled as payout; `Paid`/`Recovered`/`NoFundedRecovery` are terminal.
- [ ] Frontend test: controls derive only from freshly read chain state; a stale local state never enables a control.
- [ ] Blocking rule: any transition from a non-predecessor state is Critical.

## Task C6: replay

- [ ] Contract test: same nonce replayed in `payout_nonces` fails `PAYOUT_NONCE_USED`; same nonce replayed in `payout_settlement_nonces` fails; same nonce reused across namespaces succeeds only where the namespace is distinct (assert namespaces are independent and atomic with their transitions).
- [ ] Contract test: replay of a settlement signature after `Paid` fails on state.
- [ ] Backend test: admin and organizer challenge nonces are single-use and expiring (existing suites re-run).
- [ ] Blocking rule: any financial replay is Critical.

## Task C7: signature, domain, and chain confusion

- [ ] Contract/type test: every domain tag is distinct (`IWA_CONTRIBUTION_V1`, `IWA_CURE_V1`, `IWA_PAYOUT_V1`, `IWA_CONTRIBUTION_SETTLEMENT_V1`, `IWA_CURE_SETTLEMENT_V1`, `IWA_PAYOUT_SETTLEMENT_V1`, `IWA_RECOVERY_SETTLEMENT_V1`, new `IWA_CREDENTIAL_V1`, `IWA_CREDENTIAL_POSSESSION_V1`, and any V2 tag); a signature for one action fails verification for every other action.
- [ ] Parity test: browser `signIwa`/`verifyIwa` vectors match Cairo `check_ecdsa_signature` behavior (existing suite re-run, extended for credential domains).
- [ ] Chain-confusion test: frontend signing refuses when the connected chain is not SN_MAIN; the backend refuses non-SN_MAIN facts; artifact verification binds `network` and the exact `iwaCircle` address.
- [ ] Blocking rule: any cross-domain signature acceptance is Critical.

## Task C8: organizer/admin privilege escalation

- [ ] Contract test: organizer has no financial entry point that accepts organizer-only authority (all financial paths are member-signed or helper-only).
- [ ] Backend test: admin routes refuse bearer sessions (per-request SNIP-12 only); non-allowlisted wallet refused; unset allowlist denies everybody; no admin mutation route exists (re-run existing admin suites plus a route-enumeration test asserting the closed set).
- [ ] Frontend test: admin shell renders no saver controls and vice versa (existing suites re-run).
- [ ] Blocking rule: any path giving organizer or admin financial authority is Critical.

## Task C9: session escalation

- [ ] Backend test: a captured read session cannot reach `/api/admin/overview` or any new credential endpoint that requires authorization; read sessions never authorize money movement (existing session suites re-run against the new route table).
- [ ] Backend test: the credential verify endpoint is public by design and returns no data beyond claim validity; it must not accept or honor session tokens.
- [ ] Blocking rule: session-to-privilege escalation is Critical.

## Task C10: credential forgery

- [ ] Verify-core test: unsigned artifact invalid; signature by any key other than the artifact's `signerKey` invalid; signature by the right key but a member auth key not registered on chain for `(circleId, memberRef)` invalid.
- [ ] Verify-core test: tampered claim params, memberRef, circleId, network, evidence, or signature fields invalidate verification.
- [ ] Blocking rule: any forged artifact verifying is Critical.

## Task C11: N mutation

- [ ] Verify-core test: `thresholdRounds` above the member's actual completed rounds invalidates a `good_standing` claim; N below is valid only when facts match; N <= 0 rejected; N > member_limit rejected.
- [ ] Blocking rule: threshold inflation verifying is Critical.

## Task C12: credential type mutation

- [ ] Verify-core test: a `circle_completion` artifact cannot satisfy a `good_standing` verifier and vice versa; claim type is bound in the signed hash; a claim type swap invalidates the signature.
- [ ] Blocking rule: cross-type acceptance is Critical.

## Task C13: subject substitution

- [ ] Verify-core test: swapping `memberRef` (or the signer key) to another member invalidates both the signature and the on-chain key check.
- [ ] Contract test: `get_member_auth_key` returns only the registered key for the exact `(circle_id, member_ref)` pair.
- [ ] Blocking rule: any subject substitution verifying is Critical.

## Task C14: artifact theft and reuse

- [ ] Possession test: artifact alone (no possession signature) is not accepted by a verifier that requires possession; a challenge signed by a different key fails; a reused nonce fails; an expired challenge fails.
- [ ] Policy test: verifier freshness window rejects old artifacts; `issuedAt` in the future rejects.
- [ ] Blocking rule: a stolen artifact being accepted without possession is Critical.

## Task C15: verifier fail-open

- [ ] Verify-core test: every failure branch returns `invalid` with a reason; there is no partial-valid state, no warning-valid state, and no default-valid path.
- [ ] Backend test: RPC failure, timeouts, and malformed chain data return `invalid` (or 503 for infrastructure outage, never "valid"); no fallback to a weaker check.
- [ ] Blocking rule: any fail-open verification path is Critical.

## Task C16: malformed and truncated artifacts

- [ ] Verify-core test: truncated JSON, unknown schema version, missing fields, extra fields, wrong types, oversized fields, and non-felt encodings all reject cleanly with schema-safe errors.
- [ ] Backend test: request-size caps enforced; no schema detail leaked in error responses.
- [ ] Blocking rule: malformed artifacts causing crashes, 500s, or partial verification are High.

## Task C17: cross-circle leakage

- [ ] Verify-core/backend test: a V1 claim for circle A reveals nothing about circle B; the verify endpoint accepts one artifact and returns only its claim validity; no endpoint aggregates across circles in V1.
- [ ] Frontend test: Standing shows only the connected member's own circles (existing suites re-run).
- [ ] Contract test: no view exposes more than the public per-circle state.
- [ ] Blocking rule: cross-circle data exposure in the credential path is High.

## Task C18: sensitive logging and API leakage

- [ ] Backend test: request logs and error responses contain no member_ref, auth key, invite token, artifact body, or private data; the verify endpoint logs only a correlation id and outcome.
- [ ] Frontend test: no console logging of artifacts, signatures, or member data; error paths render user-safe messages only.
- [ ] Deployment checklist: scan production config for secret exposure; verify no `.env` committed; no viewing key or seed phrase ever requested by the app.
- [ ] Blocking rule: any secret or private data in logs or responses is Critical.

## Task C19: deployment behavior checklist

- [ ] `scripts/demo/redteam_deployment_checklist.md` executed: read-only verification of deployed class hashes and addresses, allowlist configuration, HSTS/CSP headers, route table (no new unexpected routes), feature flags match the release, mainnet state of Circle 1 re-read and recorded.
- [ ] No mainnet write performed by red-team unless explicitly required and approved with minimal value.

## Release gates

- [ ] All C1-C19 tasks executed; no Critical or High findings open.
- [ ] Medium/Low findings recorded with disposition and owner.
- [ ] Full suites green: Cairo (190 + new), frontend (555 + new), backend (245 + new), production build, `deployHeaders`.
- [ ] `SECURITY.md` and `STATUS.md` updated with findings and dispositions.
- [ ] No commit, push, or deploy without explicit instruction.

## Acceptance criteria

- The red-team matrix is closed with no Critical or High findings open and every mandatory area evidenced by a passing test or a documented scenario result.
- Any finding that cannot be fixed in scope results in reduced release scope, never a weakened security model.

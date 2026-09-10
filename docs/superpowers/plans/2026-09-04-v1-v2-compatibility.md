# V1/V2 Compatibility and Version Routing Implementation Plan (Track 3)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. TDD: failing test first, expected failure, minimal implementation, passing command, regression, STOP for review.
> **No commit, push, or deploy steps exist in this plan.** Commits are approved separately.

**Spec:** `docs/superpowers/specs/2026-09-04-v1-v2-compatibility-design.md`
**Depends on:** Track 1 capability gate G5 and the resulting V2 contracts and views, plus Track 2 credential routing. Source-level verdict B does not authorize a V2 runtime entry before real-wallet and real-pool proof.

**Baseline:** all V1 frontend and backend suites stay green and unchanged in behavior. V1 circles never resolve to V2 logic and vice versa.

## Task CP-1: deployment registry

- Files: `iwa-web/src/chains/deployments.ts` (new), `iwa-web/src/chains/deployments.test.ts` (new), `iwa-web/src/chains/starknetProduction.ts` (edit: re-export the V1 entry from the registry)
- Interfaces: `Deployment { version: 1 | 2, iwaCircle, helper, pool, usdc, strk, classHashes, capabilities: string[], defaultForCreate: boolean }`; `DEPLOYMENTS: Deployment[]`; `deploymentFor(version)`, `deploymentByCircleAddress(address)`, `isKnownVersion(version)`; V2 entry present but `enabled: false` until the mainnet gate passes.
- Failing test: registry has exactly the pinned V1 entry and a disabled V2 entry; address lookups normalize felts (BigInt comparison); unknown versions and unknown addresses resolve to `undefined`; V1 addresses match `starknetProduction.ts` exactly; no stale URLs or testnet addresses.
- Expected failure: lookups fail before implementation.
- Minimal implementation: registry module and lookups.
- Passing command: `cd iwa-web && npx vitest run src/chains/deployments.test.ts`
- Expected pass: green.
- Regression command: `npx vitest run`
- Review checkpoint: addresses cross-checked against `scripts/demo/demo.config.json` and the V2 deployment record.

## Task CP-2: frontend version resolver

- Files: `iwa-web/src/lib/versionRouting.ts` (new), `iwa-web/src/lib/versionRouting.test.ts` (new)
- Interfaces: `resolveCircle(contractAddress, id) -> { version, deployment } | undefined`; `versionOfCircle(circle) -> 1 | 2`; `classHashMatches(version, observedClassHash) -> boolean` (chain introspection fallback); `defaultCreateVersion() -> 1 | 2`.
- Failing test: V1 address resolves to version 1; V2 address resolves to version 2; unknown address undefined; circle ids are scoped to their contract (V1 id 1 never collides with V2 id 1 in resolution); class-hash mismatch returns false; default is 1 until the flip.
- Expected failure: undefined/incorrect version before implementation.
- Minimal implementation: resolver logic.
- Passing command: `npx vitest run src/lib/versionRouting.test.ts`
- Expected pass: green.
- Regression command: `npx vitest run`
- Review checkpoint: resolver is the only version decision point in the app (no scattered version logic).

## Task CP-3: backend protocol_version

- Files: `backend/migrations/20260904_add_protocol_version.sql` (new), `backend/src/indexer/` (edit), `backend/src/routes/` (edit: `GET /api/circles/:id/version`), `backend/src/config.ts` (edit: V2 indexer addresses, disabled until gate), `backend/test/versionRouting.test.ts` (new)
- Interfaces: `circles.protocol_version smallint not null default 1`; indexer derives the version from the emitting contract address via the registry; `GET /api/circles/:id/version -> { protocolVersion } | 404`; index-miss returns "unknown" explicitly.
- Failing test: migration applies cleanly on scratch Postgres; a V1 create event indexes version 1; a V2 create event indexes version 2 (with the V2 address enabled in the test config); unknown emitting address is not indexed as a circle; version endpoint returns the indexed value and 404 on unknown; stale index path returns unknown, never a guess.
- Expected failure: version assertions fail before implementation.
- Minimal implementation: migration, indexer derivation, endpoint.
- Passing command: `cd backend && npx vitest run test/versionRouting.test.ts` (scratch Postgres via `TEST_DATABASE_URL`)
- Expected pass: green including the Postgres integration cases.
- Regression command: `cd backend && npx vitest run && npm run typecheck`
- Review checkpoint: no new sensitive columns; version is public metadata.

## Task CP-4: V2 frontend adapter wiring

- Files: `iwa-web/src/chains/strk20/v2/iwaStrk20ClientV2.ts` (new), `iwa-web/src/chains/strk20/v2/identityV2.ts` (new), `iwa-web/src/chains/strk20/v2/identityV2.test.ts` (new), `iwa-web/src/chains/strk20/v2/payoutV2.ts` (new), `iwa-web/src/chains/strk20/v2/payoutV2.test.ts` (new), `iwa-web/src/chains/types.ts` (edit)
- Interfaces: `ChainAdapter` implemented for V2 (create, join, contribute, cure, register/rotate private destination, authorize private settlement, settle, private recovery, reads); `identityV2.ts` implements the identity derivation (root, circle_secret, member_ref_v2, identity key, auth key epochs, encrypted-at-rest root) with the frozen vectors from Track 1; `payoutV2.ts` implements only the private destination and authorization flow approved at gate G5.
- Failing test: identity vectors match the Cairo parity vectors exactly; distinct circles produce distinct memberRefs; auth epoch rotation changes keys without changing memberRef; authorization fields and order match the contract expectation; the final private destination is proof-bound to the registered commitment; wrong-chain, wrong-contract, wrong-member, wrong-round, wrong-amount, wrong-destination, stale-epoch, and replay cases fail closed; no viewing key or identity root crosses the adapter boundary or persists in plaintext; adapter capability contract tests pass for V2.
- Expected failure: vector and binding mismatches fail.
- Minimal implementation: adapter modules and identity module.
- Passing command: `npx vitest run` (new suites) and `npx tsc -b`
- Expected pass: green; build clean.
- Regression command: full frontend suite.
- Review checkpoint: no V1 code path modified; adapter swaps cleanly.

## Task CP-5: version-aware screens and capability flags

- Files: `iwa-web/src/lib/features.ts` (edit), `iwa-web/src/lib/roundState.ts` (edit), `iwa-web/src/screens/CircleView.tsx` (edit), `iwa-web/src/screens/StandingView.tsx` (edit), `iwa-web/src/lib/actionCenter.ts` (edit), corresponding test files (edit)
- Interfaces: `capabilitiesFor(version) -> Capability[]`; `roundState(circle, version)`; screens resolve state and actions through the versioned adapter; the V1 pot-collection gate stays closed (open-note problem); V2 private settlement controls appear only when the private payout capability and V2 deployment are enabled and released. No public payout control exists.
- Failing test: V1 circle renders with V1 semantics and gates; V2 circle renders with V2 semantics; capability lists are per-version and disjoint where required; no screen hardcodes a version.
- Expected failure: version leakage assertions fail.
- Minimal implementation: parameterize state derivation and capability resolution.
- Passing command: `npx vitest run && npx tsc -b && npm run build`
- Expected pass: green; build clean.
- Regression command: full frontend suite.
- Review checkpoint: zero visual redesign; only behavior routing changed.

## Task CP-6: create-default flip (gated)

- Files: `iwa-web/src/chains/deployments.ts` (edit), `iwa-web/src/screens/CreateCircleView.tsx` (edit, name per repo conventions), `iwa-web/src/lib/features.test.ts` (edit)
- Interfaces: `defaultForCreate` flips to true only after the private payout, security, testnet, external-audit, and mainnet gates (manual, reviewed change); the create screen uses the versioned deployment; V1 create path remains implemented for preserved circles.
- Failing test: default remains 1 until the flip; after the flip, the create screen targets the V2 deployment and validates against V2 rules.
- Expected failure: pre-flip assertions fail if default changed early.
- Minimal implementation: flag flip and screen wiring.
- Passing command: `npx vitest run && npx tsc -b && npm run build`
- Expected pass: green.
- Regression command: full frontend suite.
- Review checkpoint: the flip requires explicit approval and a STATUS.md entry.

## Task CP-7: admin version labels

- Files: `iwa-web/src/lib/adminView.ts` (edit), `backend/src/admin.ts` (edit), `backend/test/admin.test.ts` (edit)
- Interfaces: admin aggregates labelled by protocol version; chain health rows per deployment; no new private data.
- Failing test: version labels present and correct; V2 counts separate from V1 counts; no member data leaks.
- Expected failure: label assertions fail.
- Minimal implementation: label versioned aggregates.
- Passing command: `cd iwa-web && npx vitest run` and `cd backend && npx vitest run`
- Expected pass: green in both.
- Regression command: both full suites.
- Review checkpoint: admin remains read-only.

## Acceptance criteria

- V1 circles behave exactly as today, forever.
- V2 circles resolve, render, and act through the V2 adapter once enabled.
- Version resolution is centralized, tested, and fails closed.
- Creation defaults to V2 only after the approved flip.
- Until the source-level verdict B passes runtime wallet, real-pool, recovery, and release gates, the V2 registry entry is absent or disabled, has no enabled payout capability, and cannot become the create default.

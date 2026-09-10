# V1/V2 Application Compatibility and Version Routing Design

**Status:** Revised design artifact. Nothing in this V2 routing design is implemented. Source-level payout verdict B does not enable V2; runtime wallet, deployment, real-pool, recovery, security, and release gates remain open.
**Depends on:** `2026-09-04-iwa-circle-v2-design.md`, `2026-09-04-portable-trust-credential-v2-design.md`.
**Sources:** `iwa-web/src/lib/router.ts`, `navigation.ts`, `features.ts`, `chains/starknetProduction.ts`, `backend/src/app.ts`, `STATUS.md`.

---

## 1. Goals

- Every existing V1 circle keeps loading, showing its timeline, contributions, and standing, with its historical truth intact, forever.
- V2 circles are supported by the same application with explicit version detection.
- New circle creation defaults to V2 only after V2 is deployed and release gates pass.
- Version routing is explicit, testable, and fails closed on unknown versions.

## 2. Non-goals

- No automatic migration of V1 circles, member state, or balances.
- No bridge between V1 and V2.
- No silent reinterpretation of one version's state as another's.
- No changes to V1 contract behavior or V1 adapter behavior.

## 3. Current V1 limitation

- The application is bound to one deployment: `iwa-web/src/chains/starknetProduction.ts` pins one IwaCircle address, one helper, one pool. Circle ids are global (per deployment). There is no version concept anywhere in the app, so a second protocol version cannot exist without a routing model.
- The backend indexer records circles created without a protocol version.

## 4. Version routing model (final recommendation)

**Explicit protocolVersion stored with each indexed circle + config-pinned contract registry, with chain introspection as a verification fallback.**

1. **Contract registry (frontend config):** one module lists known deployments:

```text
iwa-web/src/chains/deployments.ts
  { version: 1, iwaCircle, helper, pool, capabilities: [...] }
  { version: 2, iwaCircleV2, helperV2, privacyAdapter, capabilities: [], enabled: false,
    defaultForCreate: false }
```

All addresses are pinned and verified read-only before a version is enabled.

2. **Indexed version (backend):** the indexer records `protocol_version` on every circle row, derived from the contract address that emitted the creation event (address -> version mapping from the same registry). This is the primary routing signal for `GET /api/circles` and `/api/circles/:id`.

3. **Chain introspection (fallback and verification):** the frontend can read the circle contract's class hash from chain and compare it to the pinned class hashes for each version. Used when the backend index is stale or unreachable, and by deployment verification tooling. Never trusted alone; the registry is the source of truth.

4. **Circle id namespacing:** V1 and V2 have separate circle id spaces (separate contracts). All URLs and identifiers carry the contract address or version: the app resolves a circle by (contractAddress, id), never by id alone.

Comparison of rejected alternatives: a global registry contract (adds a trusted third contract and deployment complexity), version sniffing from UI alone (backend would not know), and address-only routing without an indexed version (breaks when the backend is stale).

## 5. Frontend behavior

- `router.ts` keeps the same paths; circle routes resolve through a version resolver: `resolveCircle(contractAddress, id)` -> `{ version, adapter }`.
- The V1 adapter (`chains/strk20/iwaStrk20Client.ts` and friends) is untouched and remains the V1 path.
- A V2 adapter (`chains/strk20/v2/...`) implements the same `ChainAdapter` capability contract (`chains/types.ts`) for V2 semantics.
- Every circle screen renders from the versioned state derivation module (`lib/roundState.ts` gains a version parameter); nothing in the UI hardcodes a V1-only assumption.
- Capability flags become version-aware: `features.ts` keeps global gates (pot collection for V1 remains gated by the open-note problem) plus per-version capability maps from the registry. V2 private settlement stays disabled until the private destination capability, contracts, red-team program, testnet verification, and explicit release approval all pass. There is no public-settlement capability.
- Create flow: the creation screen uses the V2 deployment only when `defaultForCreate` is true after all gates and explicit approval. Existing V1 circles and their routes remain supported; no V1 state or history is removed.
- Admin surface: `adminView.ts` reads versioned aggregates and chain health for both deployments, each labelled with its version.

## 6. Backend behavior

- Migration: `circles` table gains `protocol_version smallint not null default 1` and the circle contract address column (already present as indexed data) is used to derive it.
- Indexer: watches both IwaCircle and IwaCircleV2 addresses; sets `protocol_version` from the emitting address.
- `GET /api/circles/:id/version` returns the indexed version; on index miss, the service reports "unknown" rather than guessing.
- Admin aggregates label counts by version.
- No backend custody, no new sensitive data; version is public metadata.

## 7. Credential routing

The verifier routes by artifact schema: `iwa-credential/1` -> V1 verification rules, `iwa-credential/2` -> V2 rules, unknown -> reject. Credential subject resolution uses the versioned contract registry, never addresses embedded in the artifact alone (the artifact's contract address must be in the registry for that version).

## 8. Error handling

- Unknown version for a circle id: the app shows the existing not-found/unsupported state with a clear explanation; it never guesses a version.
- Index stale: frontend falls back to chain introspection; if that also fails, the circle screen shows "unavailable" state with the existing stale-data marking rules.
- Version mismatch between backend index and chain introspection: the frontend surfaces a warning and fails closed. It does not route until the config-pinned registry and observed class hash agree.
- Unknown credential version: rejected, never reinterpreted.

## 9. Interfaces

```text
iwa-web/src/chains/deployments.ts          registry, capability maps, defaultForCreate flag
iwa-web/src/lib/versionRouting.ts          resolveCircle(contractAddress, id), versionOf(circle), classHashCheck
iwa-web/src/chains/strk20/v2/*             V2 adapter modules
iwa-web/src/lib/features.ts                version-aware capability resolution
backend/src/indexer/                       protocol_version derivation on create-event indexing
backend/migrations/20260904_add_protocol_version.sql
backend/src/routes/                        /api/circles/:id/version
backend/src/credentialVerify.ts            version-routed verification
```

## 10. Testing

- Frontend: version resolver tests (unknown version, stale index, mismatch), adapter selection tests, capability-per-version tests, create-default tests, route tests for V1 and V2 circle ids.
- Backend: indexer version derivation tests, migration tests, version endpoint tests, credential version routing tests.
- Existing V1 suites must stay green and unchanged in behavior.

## 11. Compatibility guarantees

- V1 circles: identical reads, identical UI, identical gated capabilities as today.
- V2 circles: full V2 surface per the V2 spec only after the private payout gate passes. Until then, no V2 deployment is registered or enabled.
- Both versions coexist in the same app, same routes, same shells.
- No V1 state is ever read by V2 logic or vice versa.

## 12. Migration behavior

- None automatic. The flip of `defaultForCreate` to V2 is a reviewed change only after private payout capability proof, implementation, red team, testnet verification, external audit review, and the mainnet gate pass.
- Existing V1 links (shared circle URLs) keep resolving: the resolver treats the indexed contract address as part of the resource identity.

## 13. Deferred work

- Embedded accounts and passkeys (identity compatible by design).
- Third chain versions and the chain capability registry generalization.
- Automatic V1 retirement messaging (only if product decisions later require it; no state changes).

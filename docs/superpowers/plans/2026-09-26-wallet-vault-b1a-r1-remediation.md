# Wallet Vault B1-A R1 Remediation Plan

## Scope

Remediate the seven confirmed B1-S1 findings only. Preserve the existing
security PoCs and add permanent negative and race regressions. No chain keys,
wallet provisioning, network calls, production configuration, commits, or
pushes are part of this work.

## Work slices

1. Correct WebAuthn PRF capability and assertion semantics against WebAuthn
   Level 3; make missing or malformed PRF output fail closed.
2. Replace the exported warm-secret object with an opaque capability whose
   corresponding secrets live only in module-private state. Bind privileged
   operations to the live capability and require a fresh passkey assertion for
   recovery export.
3. Add an operation epoch. Every asynchronous unlock/import/export boundary
   verifies its captured epoch; invalidation wipes uncommitted material.
4. Make vault persistence insert-only with IndexedDB `add`, so create/import
   races cannot overwrite an existing wallet.
5. Create a canonical SHA-256 authority-record manifest, bind it into the root
   AES-GCM associated data, and require the persisted records to match it
   exactly at unlock.
6. Tighten envelope and recovery parsers, including exact root ciphertext
   length and KDF bounds; move cleanup into earliest possible `finally` paths.
7. Rotate recovery generation on successful import and return a mandatory new
   recovery package. Document the unavoidable offline freshness limit.

## Verification

Run focused red-to-green tests after each slice, then the complete vault test
suite, TypeScript typecheck, parser mutation corpus, state-machine races,
storage substitution tests, recovery corruption tests, and secret canary
tests. Review the diff and run a separate B1-S1-style review before reporting
readiness.

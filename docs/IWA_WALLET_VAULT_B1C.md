# Iwa Wallet Vault B1-C: Portable recovery and new-device recovery

## Scope

B1-C connects the existing B1-A encrypted recovery envelope to onboarding and
new-device handling. It creates no blockchain private key, account, STRK20
viewing key, settlement authority, deployment, production configuration, or
network transaction.

## Original-device flow

1. The user cold-unlocks the local Iwa Wallet with its wallet password and
   dedicated PRF-capable wallet passkey.
2. Recovery export requires a fresh wallet-passkey assertion and generates a
   separate random 256-bit recovery code locally.
3. The browser downloads only the encrypted package and explicitly reveals the
   separate code. Iwa receives neither.
4. The user selects the saved package and enters the code again.
5. Verification decrypts and validates in memory, returns only non-secret
   evidence to UI, and records generation 1 metadata server-side.

Downloading alone never marks recovery verified.

## New-device flow

An Iwa Account session can read the opaque wallet ID and non-secret recovery
generation, but cannot unlock, recover, or sign. If the local IndexedDB record
is absent and a verified generation exists, the product routes to Recover Iwa
Wallet. It never silently creates a second wallet.

The user supplies package plus recovery code, then enrolls a **new** dedicated
wallet passkey and chooses a new vault password plus new device-only PIN. The
old passkey private credential is never copied or needed. The same logical
wallet ID is restored locally. The old PIN is not in the package and cannot be
restored. Recovery creates a generation N+1 replacement package; the user must
retain it with the same separate recovery code.

## Server metadata

Migration `009_add_iwa_wallet_recovery_state.sql` is unapplied. It adds only:

```text
recovery_status      notConfigured | verified
recovery_generation  positive integer or null
```

The client reports exactly `{ walletId, generation }` through a session, CSRF,
and origin-protected endpoint. The server accepts initial generation 1, an
idempotent current generation, or exactly the next generation. It keeps the
onboarding stage at `recovery`; B1-C does not mark overall onboarding complete.
It cannot accept a recovery package, code, password, PIN, passkey output,
ciphertext, root secret, or future authority.

## Local conflict and offline behavior

A normal recovery import refuses to overwrite an existing healthy local vault.
A browser profile containing a different wallet is reported as a conflict and
must use a separate browser profile. B1-C does not introduce a casual
replacement or migration action.

With online metadata, older authenticated packages are rejected before local
import. Without Iwa, package plus recovery code still recovers independently,
but offline freshness cannot be proved. See the exact portable format and
failure rules in `IWA_WALLET_RECOVERY_FORMAT_V1.md`.

## Verified synthetic proof

The `iwaDisappearanceRecovery` test creates a synthetic authority, exports a
package, deletes the original local vault, retains only package plus code,
imports into a fresh isolated store under a different passkey and password,
checks the identical synthetic bytes and wallet ID, and outputs generation 2.
No backend is called in that proof.

## Residual limitations

- Browser/device WebAuthn PRF, IndexedDB, upload, and download behavior need a
  later disposable real-browser gate across Chrome, Firefox, and Safari where
  supported.
- Offline stale-package detection is inherently limited as described above.
- The standalone recovery tool is specified but not yet released.
- B2 remains required before any real Starknet, EVM, Solana, STRK20, viewing,
  settlement, or signing authority exists.

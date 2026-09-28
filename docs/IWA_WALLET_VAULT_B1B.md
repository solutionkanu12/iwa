# Iwa Wallet Vault B1-B: Onboarding lifecycle

## Scope

B1-B connects the B1-A browser vault to the existing Iwa Account onboarding
sequence. It creates a real, encrypted **empty** local container. It does not
generate blockchain keys, seed phrases, chain accounts, STRK20 viewing keys,
settlement authority, or recovery artifacts for a user.

## Account and wallet boundary

Iwa Account email/Google authentication and its HttpOnly session identify a
user and allow the product to read non-secret setup metadata. They cannot
unlock, recover, export, or sign with Iwa Wallet.

Iwa Wallet setup requires a separate user-verified, PRF-capable wallet
passkey and the local vault password. The six-digit PIN is set only after the
local vault is warm and remains an in-memory convenience confirmation. It
cannot cold-unlock, recover, enroll a passkey, export a package, or sign.

## Server coordination record

`iwa_wallet_setups` has exactly one row per user:

```text
user_id       Iwa account UUID
wallet_id     server-generated opaque UUID
setup_status  reserved | vaultProvisioned
timestamps
```

It deliberately has no wallet authority. The server returns only `{ walletId,
status }`. `POST /api/onboarding/wallet/reserve` takes `{}`. `POST
/api/onboarding/wallet/provisioned` takes exactly `{ walletId }`. These routes
use the current Iwa session, allowed origin, and CSRF proof, but that session
does not become wallet authority.

The server permits a reservation only at `passwordPin`. It advances to
`walletProvisioning` atomically only when the returned opaque ID matches its
reservation. A generic client state transition cannot skip this boundary.

## Local creation flow

1. The user enters and confirms a 12 to 128 character wallet password and a
   six-digit PIN.
2. The browser reserves the opaque wallet ID with an empty request.
3. The browser creates a dedicated Iwa Wallet WebAuthn credential. PRF and
   user verification are required; unsupported or cancelled ceremonies fail
   closed.
4. The browser creates the B1-A IndexedDB root wrapper with `authorities: []`.
5. It cold-unlocks that container with the password and fresh wallet-passkey
   assertion only to set the warm in-memory PIN verifier.
6. It clears the page password/PIN before sending the ID-only provisioned
   report, refreshes account progress, and presents the wallet-provisioning
   stage.

If the provisioned report response is lost, a same-device retry cold-unlocks
the original insert-only container and never overwrites it or enrolls another
passkey. No chain authority is created in either path.

## Lifecycle

`IwaWalletVaultProvider` exposes only an opaque public view:

```text
walletId: string | null
localVault: unknown | absent | present
state: cold | warm
```

The actual `WalletVault` and opaque warm capability live outside React state.
`IwaAuthProvider` registers only a lock callback. Logout, logout-all, invalid
session refresh, account switching, suspension, pagehide, and provider
teardown lock. Visibility changes alone do not prematurely lock a user who
briefly switches tabs; the B1-A idle timer remains active. Refresh/restart
always starts cold.

On a device with no matching IndexedDB record, B1-B displays recovery-required
and does not create a second wallet. B1-C now owns actual recovery import and
portable package UX; its exact format is documented separately in
`IWA_WALLET_RECOVERY_FORMAT_V1.md`.

## Residual limitations

- The server cannot verify an encrypted local container without becoming a
  custodian, so the provisioned report is setup progress only.
- B1-B does not perform a real-device WebAuthn ceremony in CI; browser/device
  coverage is a later release gate.
- B1-C verifies portable recovery with synthetic authorities only. Later
  chain-specific authority work remains separately approved and is not implied
  by this lifecycle integration.
- No production migration has been applied, and no production wallet exists.

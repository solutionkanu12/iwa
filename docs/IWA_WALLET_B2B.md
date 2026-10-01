# Iwa Wallet B2-B: STRK20 viewing authority and private-state boundary

## Scope

B2-B adds a separate STRK20 viewing authority to the existing B2-A Starknet
account. The Starknet spending scalar remains the only account signing
authority. This phase does not add an Iwa settlement authority, EVM, Solana,
mainnet support, a production prover/discovery service, or a production
provider configuration.

## Local authority model

`strk20ViewingAuthority.ts` creates a fresh 32-byte scalar from Web Crypto
CSPRNG with rejection sampling in the exact SDK-supported interval
`[1, Stark curve order / 2]`. It is not derived from the Starknet spending
scalar, Iwa account identity, password, PIN, passkey credential ID, recovery
code, or another chain authority.

The encrypted authority record has namespace `strk20/viewing` and a public
descriptor only:

```text
namespace
descriptorVersion
networkId
poolAddress
accountAddress
registrationState: local | registered
```

The descriptor is bound to the deployed B2-A Starknet account and pool. It is
included in the authenticated root manifest and portable recovery package. A
missing, extra, substituted, or context-mismatched record fails closed before
unlock or use.

## Direct SDK boundary

The runtime boundary is pinned to the B0.2-compatible package contract:

```text
@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5
createPrivateTransfers({ account: { address, signer }, ... })
```

The compatibility source is the pinned upstream
[`starknet-privacy` SDK README at `66e3caae`](https://github.com/starkware-libs/starknet-privacy/blob/66e3caae8c0201227a6719696d004e30d90aea65/sdk/README.md),
whose documented direct account shape, viewing-key provider, discovery, proving,
and invoke path were exercised in B0.1/B0.2.

The caller is a locally constructed Starknet.js `Signer` over a short-lived
copy of the encrypted B2-A authority. No `WalletAccountV6`, injected extension,
or external wallet API is used. The viewing scalar is available only to the
in-process SDK, protocol registration probe, discovery provider, and prover
where the protocol requires it. It is never sent to an Iwa backend route, URL,
cookie, web storage, telemetry, or React state.

After a protocol registration succeeds, only the public `registered` state is
rewrapped into the vault record. A retry first probes the protocol and never
creates another viewing identity. Discovery returns a minimized in-process
summary only; raw notes and the scalar remain inside the vault adapter.

The pinned SDK does **not** submit `IwaStrk20Helper.privacy_invoke` as the
outer account call. Its canonical output is instead
`PrivacyPool.apply_actions(server_actions, screening)`: the intended Iwa
operation is the proof-authenticated inner `ServerAction::Invoke`. The wallet
therefore decodes `proof.output[1..]` as the pinned
`Span<privacy::actions::ServerAction>` using the vendored SDK ABI, then
round-trips it to reject malformed or trailing bytes. It never uses a string
search or hand-written calldata offsets.

Before submission the narrow B2-B operation reconstructs a trusted intent and
requires exact equality for the pool, account, network, helper target, nine
`privacy_invoke` calldata felts, Iwa operation, nonce, required token/amount,
and complete ordered server-action transcript. The outer call must be that
pool's `apply_actions`; the submitted action span must equal the proof action
span; and the remaining screening suffix must match the pinned `Option`
encoding. Unknown action forms, duplicate or additional invocations,
unapproved transfers, reordered actions, an `InvokeWithComputation`, and any
extra proof-bound action fail closed. The pool's `Invoke` dispatch has the
protocol-defined `privacy_invoke` selector, so a different helper selector is
represented as a different action type and is rejected.

This remains intentionally *not* exposed through the React lifecycle, vault,
or UI as a generic call builder. B2-C may add only a separately reviewed fixed
settlement intent.

## Recovery and coordination

Recovery restores the same Starknet authority and the same viewing scalar under
a new local passkey, password, and device-only PIN. It does not create a
replacement viewing identity. The recovered record retains its registration
state and rotates the package generation as the B1-C recovery format requires.

Migration `011_add_iwa_strk20_provisioning_stage.sql` is unapplied. It changes
only the existing public `chain_provisioning_stage` constraint to permit the
forward `strk20` marker after local proof succeeds. It adds no columns and no
secret material. The server accepts exactly `{ walletId }` on the protected
completion endpoint; it cannot accept a viewing scalar, note, balance, proof,
vault record, recovery material, password, PIN, or passkey output.

## Local evidence and remaining remote proof

Local unit and lifecycle tests cover CSPRNG bounds, manifest inclusion,
duplicate registration resume, wrong network/context rejection, direct signer
shape, helper-target binding, public-only server transition, storage/log canary
checks, and recovery of the identical viewing scalar. These use structural SDK
fixtures and synthetic private state only.

The exact upstream privacy package is not available to this local worktree:
the package registry rejects unauthenticated package reads. The required real
proof remains a disposable GitHub Actions/devnet run using the exact B0-pinned
upstream stack and package revision. It must exercise real viewing-key
registration, discovery, proving, a private deposit or transfer, Iwa helper
interaction, wrong-key/signer/account cases, and recovered rediscovery. That
run requires an explicitly approved temporary CI branch; no milestone branch
has been pushed for B2-B.

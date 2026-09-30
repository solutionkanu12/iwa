# Iwa Wallet B2-B: STRK20 viewing authority and private-state integration

**Spec:** User-approved Task 1.3C-B2-B brief, 2026-09-30.  This plan extends
the approved B2-A commit `4ac8a2aa66d66a7c59b474afea44a3374520b14c` only.

## Scope and non-goals

B2-B adds one locally generated STRK20 viewing authority to the existing Iwa
Wallet vault.  It retains the B2-A Starknet spending authority and uses it
through the Starknet Privacy SDK's supported direct `{ address, signer }`
interface.  It does not use `WalletAccountV6`, injected wallets, settlement
authority, EVM, Solana, mainnet, a production provider, real funds, or a
production deployment.

The local milestone branch remains unpushed.  A separate, explicitly approved
temporary CI branch will be needed before the disposable devnet proof.

## Design decisions

1. Add `strk20/viewing` as a distinct, 32-byte, rejection-sampled Stark-curve
   scalar authority. It is not derived from any spending, account, password,
   PIN, passkey, recovery, email, or user-id material.
2. Encrypt the authority using the existing root-secret record encryption and
   authenticate it in the existing exact child-record manifest. Its descriptor
   binds the wallet's Starknet account address, network, pool address, and
   descriptor version. It contains no private data.
3. Extend recovery encoding and validation so a recovered vault restores the
   exact viewing scalar and descriptor. Recovery never creates a new viewing
   authority.
4. Keep decrypted scalar use module-private. The public vault capability never
   returns the viewing scalar, private notes, a direct signer, or an SDK
   object. A narrow internal operation constructs the SDK account and viewing
   key provider only for a bounded callback, then wipes temporary copies.
5. Introduce an injectable Privacy SDK boundary. Production code uses the
   exact Iwa-pinned SDK (`@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5`,
   compatible with the contracts' `starknet-privacy` revision
   `66e3caae8c0201227a6719696d004e30d90aea65`); local tests use safe fakes.
   Test-only devnet providers and proof services are supplied by the future
   disposable CI harness, never baked into product configuration.
6. Add only a forward `strk20` chain-provisioning substage and public setup
   status through a new, unapplied migration. No secret, package, vault, or
   private-state material is persisted by the backend.

## Execution tasks

1. **Authority and recovery model**
   - First add failing tests for independent CSPRNG generation, strict
     descriptor validation, vault encryption, manifest substitution/deletion
     rejection, and exact recovery round-trip.
   - Implement the STRK20 viewing-authority type, parser, serializer,
     wiper, and recovery support.

2. **Embedded privacy operation boundary**
   - First add failing tests for registration idempotency, wrong key/account
     rejection, discovery result handling, private invoke intent binding,
     interrupted resume, and secret-sink absence.
   - Implement a direct-SDK adapter boundary that supplies the existing
     Starknet account signer and viewing key locally, without `WalletAccountV6`.
   - Bind all operation input to the stored wallet, network, pool, and account
     descriptor before invoking providers.

3. **Public-only provisioning state**
   - Add a new migration to extend the allowed chain-provisioning stage and
     only the non-secret STRK20 status needed for a server-authoritative,
     forward-only transition.
   - Update backend validation and tests. No migration is applied.

4. **Recovery and resiliency**
   - Test recovery after private state exists using synthetic protocol fakes
     locally, including new passkey/password/PIN wrapping and recovery
     generation rotation.
   - Refuse missing local authority, wrong wallet/account/network, duplicate
     registration, and interrupted transitions unless resumption can verify
     the original identity.

5. **Verification and remote gate**
   - Run focused B2-B, all wallet-vault, onboarding/frontend, backend,
     typecheck, build, parser/property, secret-sink, and diff checks locally.
   - Stop for approval before creating or pushing a new temporary CI branch.
     The approved disposable runner must demonstrate the matching upstream
     privacy stack, viewing-key registration, discovery, proof/private invoke,
     Iwa helper path, and same-authority recovery without retaining secrets.

## Completion criteria

Local implementation is complete only when the STRK20 viewing authority is a
distinct encrypted/recoverable vault record, all local invariants and negative
tests pass, and no public API can expose it. B2-B is not marked fully proven
until the separately approved devnet CI proof passes.

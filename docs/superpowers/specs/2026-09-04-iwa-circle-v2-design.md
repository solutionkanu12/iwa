# IwaCircle V2 Protocol, Identity, and Private Payout Design

**Status:** Revised architecture and completed capability spike. Nothing in this document is implemented, tested, or deployed. V1 mainnet contracts remain immutable and supported.
**Decision gate:** **B. FEASIBLE WITH SMALL V2 CONTRACT CHANGE.** The pinned STRK20 source and current Wallet API development specification expose a shadow-account route that can authenticate a precommitted private payout identity and collect the payout into a wallet-owned open note atomically. Production implementation remains gated on real-wallet support, target-network deployment verification, and Iwa-specific tests.
**Chain:** Starknet is the first V2 implementation, not the product boundary.
**Evidence baseline:** Iwa dependency pin `starkware-libs/starknet-privacy@66e3caae8c0201227a6719696d004e30d90aea65`, upstream SDK `0.14.3-rc.5`, `starknet@10.5.0`, installed Wallet API types `@starknet-io/types-js@0.10.3`, and Wallet API development specification `0.10.4-rc.1`.

---

## 1. Hard product invariant

A Starknet payout is complete only when the scheduled member receives the pot through a validated private settlement path. A normal public ERC20 transfer, including a transfer followed by optional re-shielding, does not satisfy V2.

This rules out:

- direct helper-to-account ERC20 payout
- organizer or admin recovery
- server-held signer or viewing keys
- a bearer secret used as payout authority
- caller-selected recipient, destination, note, or amount
- claiming private payout support before the wallet, pool, and contract path is verified end to end

If no safe private outbound primitive is available, the correct state is a closed capability and a release blocker, not a public fallback.

## 2. Chain-neutral core

Iwa Core owns only product concepts and invariants:

```text
Circle
Member
Contribution
Obligation
Payout
Standing
Credential
Identity
```

Chain implementations sit behind explicit boundaries:

```text
Iwa Core
  -> ChainAdapter
       -> PaymentAdapter
       -> PrivacyAdapter
       -> CredentialVerifier
```

- `ChainAdapter` maps lifecycle, reads, writes, finality, and public identifiers.
- `PaymentAdapter` moves the configured asset and proves actual value movement.
- `PrivacyAdapter` states and implements the exact privacy capabilities available on that chain.
- `CredentialVerifier` validates versioned claims and owner possession without changing financial state.

The core requires deterministic payout order, immutable completed history, exact accounting, member-controlled authorization, and truthful capability reporting. It does not require Starknet types, EVM types, wallet RPC shapes, or one privacy technology.

## 3. Adapter families

### Starknet

- Private inbound: current STRK20 pool and helper pattern.
- Private outbound design: a member-precommitted STRK20 shadow identity, authenticated by its deterministic shadow account, with the payout collected into a wallet-owned open note in the same pool transaction.
- Current V2 status: architecture verdict B. Implementation and release remain blocked on the verification gates in section 6.

### EVM and Zama

- Current Prize Savings implementation uses encrypted balances and FHE-based selection and payout accounting on Ethereum Sepolia.
- A future EVM circles adapter may reuse the EVM family, but it must satisfy circle invariants and confidential payout requirements independently.
- Prize Savings is not proof that EVM savings circles are shipped.

### Celo

- Planned EVM-compatible payment and agent integration.
- Not shipped. It must implement the same core interfaces and its actual privacy capabilities must be declared.

### Nimiq

- Planned Nimiq Pay Mini App integration.
- Not shipped. It must implement the same core interfaces and its actual privacy capabilities must be declared.

### Base and other EVM chains

- Planned reuse of the EVM adapter family after the shared implementation and security review exist.
- Not shipped.

Adding a chain should require an adapter and chain-specific security review, not a new product protocol. A V3 is justified only by a fundamentally incompatible protocol flaw, not by routine chain expansion.

## 4. V1 problem statement

V1 private payout binds `open_note_id` in `IWA_PAYOUT_SETTLEMENT_V1`. The wallet creates that identifier from private channel material and a sequential note index while assembling the STRK20 transaction. The member authorization must already bind the final identifier before settlement. Those operations cannot be safely ordered in the immutable V1 browser flow.

V2 cannot solve this by removing the note binding. At the pool boundary, `OpenNoteDeposit` contains only `note_id`, `token`, and `amount`; the public `get_note` view returns only the packed value and token. The helper cannot infer or validate the private owner of an arbitrary open note.

## 5. STRK20 private payout capability spike

### 5.1 Exact findings

| Question | Evidence-backed result |
|---|---|
| Can an empty open note be created and kept for later? | No. The pool counts every `EmitOpenNoteCreated` and requires the count to return to zero in the same applied action set, otherwise `UNDEPOSITED_OPEN_NOTES`. |
| Can a filled open note be reused? | No. `_deposit_to_open_note` requires the current amount to be zero and otherwise raises `NOTE_ALREADY_DEPOSITED`. |
| Can the dapp know the future note ID before wallet assembly? | Not through the installed Wallet API. `${openNoteIds[N]}` is explicitly the Nth open note created in the same transaction and is resolved during assembly. |
| Can the helper verify an arbitrary note belongs to the scheduled member? | No. Deposit validation checks existence, open-note salt, zero current amount, token, and nonzero amount. It has no recipient ownership check, and `get_note` exposes no owner. |
| Can the dapp derive the note ID independently? | Not safely. `note_id = Poseidon(NOTE_ID_TAG, channel_key, token, index, 0)`, and `channel_key` includes the sender's private viewing key plus recipient data. The index is sequential. The app must not obtain the viewing key. |
| Is there a reusable destination or note-reservation API? | There is no reusable open note. The supported precommitment is instead a shadow identity commitment derived from wallet-private material, a dapp domain, and a nonce. It deterministically maps to a shadow account. |
| Is there a proof-bound pseudonymous identity primitive? | Yes in the pinned source and current Wallet API development specification. `wallet_strk20ShadowAccountCommitment` computes the commitment, and `STRK20_SHADOW_ACCOUNT_INVOKE_ACTION` proves and invokes through the corresponding shadow account. Iwa's installed `0.10.3` types do not yet expose it. |
| Can the helper authenticate the precommitted private identity? | Yes. During the shadow invocation the anonymizer deploys or loads the deterministic account and records the commitment-to-account mapping. A V2 helper can load the stored commitment and require its caller to equal `get_shadow_account(commitment)`. |
| Can the payout become a private note atomically? | Yes in the upstream implementation and tests. The shadow account invokes the dapp, receives the state-derived ERC20 payout, approves the pool, and returns an `OpenNoteDeposit`; the pool funds the wallet-owned note in the same STRK20 transaction. |
| Can Iwa switch to the direct SDK without changing the trust model? | Not for production browser use. The SDK wallet route is a wallet-class security boundary. V2 should use a compatible wallet implementation of the standardized shadow-account methods so the dapp never receives viewing keys or note witnesses. |

### 5.2 Source proof

- `contracts/starknet/Scarb.toml` pins the pool source to commit `66e3caae...`.
- Pinned `packages/privacy/src/privacy.cairo` creates the open note at lines 674-711, enforces same-action-set open-note accounting at lines 854-904, validates deposits at lines 1008-1040, and exposes only `Note` at lines 1073-1075.
- Pinned `packages/privacy/src/hashes.cairo` defines the private channel key at lines 114-132 and note ID at lines 200-210.
- Installed `iwa-web/node_modules/@starknet-io/types-js/dist/types/wallet-api/components.d.ts` defines same-transaction placeholders at lines 169-177 and the complete action union at lines 184-227.
- Pinned `packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo` lines 48-58 derives the commitment from the private identity key, dapp name, and nonce; lines 96-134 collects call results into open notes; lines 302-323 derives the pool-bound identity, deploys or loads the shadow account, executes calls, and collects; lines 326-367 resolves deterministic addresses; and lines 404-446 implements `All`, `Diff`, and exact collection policies.
- Pinned `sdk/src/internal/shadow-accounts.ts` derives partial and full commitments locally and constructs the shadow invoke action without exposing the identity key to the dapp.
- Pinned `e2e/tests/devnet/shadow-account-invoke.test.ts` and `shadow-account-compute-invoke.test.ts` prove that a dapp payout through a shadow account is collected into a privacy-pool open note and that the shadow address/class are checked.
- Current Wallet API development specification `0.10.4-rc.1` defines `wallet_strk20ShadowAccountCommitment` and `STRK20_SHADOW_ACCOUNT_INVOKE_ACTION` with `dapp_name`, `nonce`, calls, and collection policy.
- Installed Iwa types remain `0.10.3` and do not expose this API. No compatible production wallet or target-network anonymizer deployment has been verified in this phase.

### 5.3 Verdict

**B. FEASIBLE WITH SMALL V2 CONTRACT CHANGE.**

The note-ID chicken-and-egg remains real, and V2 must not bind an open-note ID before transaction assembly. The shadow-account route removes that requirement. The member precommits an opaque shadow identity commitment. At payout, the wallet proves that identity to the STRK20 pool, invokes the V2 helper through the deterministic shadow account, and collects the exact payout into a newly created wallet-owned open note atomically.

The small V2 contract change is an authenticated helper entry point that accepts calls only from the shadow account resolved from the member's stored commitment and derives member, round, token, and amount from circle state. No V1 contract changes. No public payout fallback.

## 6. Verification gates before production implementation

The architecture is feasible at the pinned source level, but implementation and release require all of these:

1. Verify a real browser wallet implementing Wallet API `0.10.4-rc.1` shadow commitment and shadow invoke methods on the target network.
2. Pin and verify the shadow-account anonymizer address, class hash, pool binding, account class, and governance or upgrade authority. No address is assumed from unverified notes.
3. Add an isolated Iwa V2 helper harness against the real pinned pool and anonymizer, not only mocks.
4. Freeze the Iwa dapp name, nonce derivation, commitment encoding, helper ABI, and authorization vectors only after cross-language tests pass.
5. Run minimal-value testnet settlement and record the public metadata and recipient-side private receipt evidence.

The acceptance proof must show:

- private-identity authentication without revealing the wallet's note owner or viewing key
- exact or state-derived amount binding
- single-use payout nonce, monotonic destination epoch, and pool nullifier behavior
- no caller substitution of destination, amount, circle, round, token, helper, pool, or contract
- browser-side construction without backend custody or viewing-key disclosure
- wallet compatibility on the target network
- failure atomicity and liability conservation
- explicit public metadata and privacy leakage analysis

## 7. Proposed private payout flow

1. At join or before the payout turn, the wallet derives a per-circle, per-destination-epoch shadow identity commitment with `wallet_strk20ShadowAccountCommitment(iwa_dapp_name, nonce)`.
2. The member registers that opaque commitment, its monotonic destination epoch, auth epoch, and a separately controlled recovery commitment with the V2 circle.
3. The circle locks payout order and derives the scheduled member, round, token, and exact funded amount from contract state.
4. The member signs the versioned Iwa payout authorization against the stored shadow commitment and state-derived context. The open-note ID is deliberately absent because it does not exist yet.
5. At payout, the wallet assembles one STRK20 transaction containing an open-amount private transfer action and one shadow-account invoke action scoped to Iwa's dapp name and nonce.
6. The pool proof derives the same shadow identity. The anonymizer deploys or loads its deterministic shadow account and invokes the narrow V2 helper call.
7. The helper requires that its caller equals `get_shadow_account(stored_commitment)`, validates the signed authorization and current epochs, and asks the circle for the exact authorized payout.
8. The circle consumes the authorization nonce, debits the exact liability, and transfers only the state-derived amount to the authenticated shadow account.
9. The anonymizer collects the account's token balance delta into the wallet-created open note and returns `OpenNoteDeposit` to the pool in the same transaction.
10. Only after the atomic transaction succeeds does the circle enter a final successful private-settlement state. Any failure reverts the financial state and liability debit.

## 8. Information timing and privacy

### Known at join or pre-registration

- protocol version, chain, V2 circle contract, helper/privacy adapter, pool, and token
- circle ID, circle-scoped `member_ref_v2`, identity public key, auth epoch
- opaque shadow identity commitment, deterministic shadow account address, and destination epoch
- member-committed fallback destination commitment and its delay policy

### Known at payout time

- round ID, scheduled member reference, deterministic funded payout amount
- current destination and authorization epochs
- authorization nonce and expiry
- action identifier
- wallet-created open note and proof-time shadow identity, generated only during transaction assembly

### Must remain private

- identity root, circle secret, auth private keys, viewing keys, note witnesses, nullifiers before use
- private identity key, open-note recipient, and linkage from the shadow account to the recipient's private balance
- private contribution graph and unnecessary cross-circle identity links
- payout ownership linkage beyond unavoidable protocol metadata

### Unavoidable public metadata

- contract and pool addresses, token, transaction timing and sender/paymaster metadata exposed by the chosen wallet path
- circle existence, terms, round progression, payout state, and circle-scoped member references already public in the circle protocol
- open-note token and amount in the current STRK20 design
- the shadow anonymizer and helper invocation, shadow account deployment/use, transaction timing, and configured collection policy
- events required for protocol verification, including commitment rotation and fallback activation without revealing private identity ownership

V2 must not claim anonymity. Privacy claims are capability-specific.

## 9. Proposed payout authorization

Do not freeze SNIP-12 encoding until the private destination primitive and wallet signature support are verified. The authorization must bind at least:

```text
protocol_version
chain_id
circle_contract
privacy_adapter_or_helper
privacy_pool
token
circle_id
round_id
scheduled_member_ref
shadow_identity_commitment
payout_amount_or_state_amount_commitment
authorization_epoch
destination_epoch
nonce
expiry
action_identifier
```

The circle supplies the member, round, token, and payout amount from trusted state. The caller may not choose them. The shadow commitment must already be registered by the member. The helper authenticates the proof-derived shadow account against that commitment; the pool transaction creates and funds the wallet-owned output note atomically.

## 10. Recovery and liveness

Recovery remains member controlled and uses the same private shadow-account capability:

- separate, rotatable auth key and settlement destination
- monotonic auth and destination epochs
- identity-key-authorized rotation
- time-locked member-committed fallback shadow identity, controlled by separately backed-up or recoverable wallet material
- every fresh member authorization or destination registration resets the fallback timer
- payout submission becomes permissionless after valid authorization or timeout, but its recipient never becomes caller controlled
- no organizer, admin, backend, or helper discretion

A fallback to a public account is not acceptable. Recovery availability depends on the member preserving at least one privacy identity path. The precise timer, rotation race handling, and fallback wallet experience remain release blockers until tested.

## 11. Member Identity V2

```text
identity_root = 32 random bytes generated client side
circle_secret = HKDF-SHA256(identity_root,
  salt = chain_id || circle_contract || circle_id,
  info = "IWA_IDENTITY_V2")
member_ref_v2 = Poseidon(IWA_MEMBER_REF_V2, circle_secret)
identity_key = derived per circle and stable across auth rotations
auth_key(epoch) = derived per circle and per monotonic epoch
```

- The root is encrypted at rest under a wallet-authorized wrapping key and is exportable in member-controlled encrypted form.
- The root, circle secret, and private keys never enter backend state or logs.
- The same person has no globally reusable public member reference.
- Identity-key proof authorizes auth-key and private-destination rotation.
- Exact scalar derivation and cross-language vectors must be frozen before implementation.

## 12. Circle and payout states

V1 contribution, grace, default, deterministic payout order, and accounting rules carry forward. V2 adds explicit private-settlement states:

```text
Scheduled
DeferredLocked
PrivateSettlementAuthorized
PrivatelyPaid
RecoveryPending
PrivatelyRecovered
NoFundedRecovery
PrivateFallbackPaid
```

`PrivateSettlementAuthorized` is never completion. `NoFundedRecovery` is terminal accounting but never a successful payout. Final successful states require verified private value movement.

## 13. Portable Trust Credential rules

The credential design is separate from the payment adapter and remains version routed.

### Good Standing

- At least N qualifying finalized obligations.
- `OnTime` qualifies.
- `LateWithinGrace` may qualify and does in the initial policy.
- `MissedDefault` never qualifies, even if later cured.
- N, claim type, version, chain, contract, circle, member, and evidence boundary are signed and verified.

### Circle Completion

- Circle accounting is terminal.
- The member is in the immutable payout order.
- The member's own payout reached a verified successful private-settlement state.
- Scheduled, authorized, recovery-pending, no-funded-recovery, or otherwise incomplete states do not qualify.

Artifacts are owner-bound, not bearer JSON. Integrity signature plus a fresh proof-of-possession challenge are both required. Raw amounts, full history, member graph, and unnecessary cross-circle identity are excluded. Groth16 and ZK remain future work unless separately implemented and audited.

## 14. V1 and V2 coexistence

- V1 identity is `(V1 contract address, circle id)` and is never rewritten.
- V2 identity is `(V2 contract address, circle id)` in a separate deployment and storage space.
- Every indexed/read model carries `protocol_version`.
- A config-pinned contract registry is primary; verified class hash is a fallback check, not a source for guessing.
- Unknown version or address fails closed.
- No automatic migration, bridge, shared state, or V1 deletion.
- New-circle creation stays on V1 or closed until V2 is implemented, red-teamed, testnet verified, and explicitly approved. It must not default to an incomplete V2.

## 15. Security and release gate

The mandatory matrix covers double collect; payout, nonce, chain, domain, contract, round, member, destination, amount, epoch, and expiry replay or substitution; rotation races; fallback timing; admin/organizer escalation; helper abuse; malicious callbacks; credential forgery and mutation; possession replay; malformed artifacts; verifier fail-open; correlation; and logging leakage.

Critical or High findings block release. Internal testing is not an external audit. No V2 testnet release begins until the real-wallet, anonymizer deployment, and Iwa harness gates pass against exact pinned versions.

## 16. Decision status

- **DESIGN:** chain-neutral core, adapter boundaries, identity model, conditional authorization fields, recovery invariants, credential rules, compatibility, and red-team requirements.
- **SPIKE:** source-level STRK20 capability investigation completed against the pinned pool, shadow-account anonymizer, SDK/client source, upstream e2e tests, installed wallet types, and current Wallet API development specification.
- **IMPLEMENTED:** none for V2.
- **TESTED:** no V2 production behavior. Existing V1 tests are historical evidence only; no new Cairo suite was run in this phase because no V2 code was written and Scarb is not available on the current PATH.
- **DEPLOYED:** V1 only. No V2 contract or configuration exists.

## 17. Exact next phase

After review approval, run a test-first shadow-account integration phase before building the complete protocol:

1. write failing tests for commitment registration, authenticated shadow caller, substitution, replay, rotation, recovery timing, and atomic settlement
2. verify a compatible real wallet and exact target-network anonymizer deployment
3. implement only the minimal isolated V2 helper/circle harness needed to make the real-pool tests pass
4. prove the flow with a minimal-value testnet wallet transaction
5. freeze exact authorization encoding and cross-language vectors, then return for security review

The isolated V2 implementation spike may begin after review approval. Full V2 implementation and release remain gated on the spike, red team, testnet proof, and explicit release approval.

# V2 Security and Release Design

**Status:** Revised design. No V2 code is implemented, tested, audited, or deployed.
**Release blocker:** Verdict B is source-level only. No testnet release begins until real-wallet, target-network anonymizer, Iwa real-pool, recovery, and red-team gates pass.
**Depends on:** `2026-09-04-iwa-circle-v2-design.md`, `2026-09-04-portable-trust-credential-v2-design.md`, and `2026-09-04-v1-v2-compatibility-design.md`.

---

## 1. Release principles

- Private inbound and private outbound are both required for Starknet V2.
- Public ERC20 payout, optional re-shielding, backend custody, and admin recovery are prohibited.
- Every code-targeted security row starts with a failing test against real code.
- Critical or High findings block release.
- Medium findings require a documented disposition. Low findings require a recorded fix or acceptance.
- Internal testing is not an external audit.
- V1 is immutable and is never migrated, redeployed, or reinterpreted as V2.

## 2. Capability gate before contract work

The selected Starknet privacy primitive must demonstrate, against pinned source and a compatible real wallet:

1. member-controlled per-circle shadow identity commitment before payout
2. helper authentication of the proof-derived shadow account against that commitment
3. exact, state-derived payout amount
4. single-use payout nonce, destination epoch, pool nullifier, and replay protection
5. safe rotation with monotonic epochs
6. private fallback shadow identity under the same ownership rules
7. browser construction without exposing viewing keys to Iwa or its backend
8. atomic private settlement and liability debit
9. explicit metadata leakage analysis

Failure of any item downgrades the source-level verdict to C and stops implementation.

## 3. Payout red-team matrix

| Attack | Required assertion | Blocking severity |
|---|---|---|
| Double collect | A second payout, recovery, or fallback settlement cannot move value or debit liability. | Critical |
| Payout replay | A consumed payout authorization and destination cannot be replayed. | Critical |
| Wrong round | Authorization and proof for one round fail on every other round. | Critical |
| Wrong member | Only the scheduled circle-scoped member may authorize or receive. | Critical |
| Wrong private destination | Helper caller must resolve from the registered shadow commitment and current destination epoch; a different account or commitment fails. | Critical |
| Wrong amount | Caller cannot choose amount; private transfer equals the state-derived funded liability. | Critical |
| Stale authorization | Rotated auth or destination epoch, or expired authorization, fails. | High |
| Nonce replay | Nonces are single-use within a domain and cannot cross action namespaces. | Critical |
| Expiry bypass | Contract time enforces expiry on authorization and settlement. | High |
| Chain/domain confusion | Version, chain, action, token, circle, helper/adapter, pool, member, and round are domain bound. | Critical |
| Contract substitution | Signature or proof for one V2 deployment fails on another. | Critical |
| Destination substitution | Changing commitment, proof, note, or destination invalidates settlement. | Critical |
| Rotation race | Exactly one current epoch wins; old and concurrent registrations cannot settle. | High |
| Fallback timing attack | Fallback cannot fire before the lock and a fresh member registration resets the timer. | Critical |
| Organizer/admin escalation | No organizer, admin, backend, or operator can select or redirect a recipient. | Critical |
| Helper abuse | Helper accepts only exact configured contracts, token, state, amount, and privacy caller. No arbitrary call surface exists. | Critical |
| Malicious callback/reentrancy | Account, token, privacy adapter, or wallet callback cannot reenter settlement or mutate authorization. | Critical |
| Liability mismatch | No cross-round or cross-token borrowing; failure is atomic and backing never falls below liability. | Critical |
| Privacy downgrade | No successful path pays a normal public account or marks public movement as private completion. | Critical |
| Ownership gap | Note existence alone is never accepted as recipient ownership. | Critical |

## 4. Credential red-team matrix

| Attack | Required assertion | Blocking severity |
|---|---|---|
| Forged credential | Artifact signature, registered owner key, possession proof, and chain facts all validate. | Critical |
| Changed N threshold | N is signed, schema validated, and re-derived from qualifying facts. | Critical |
| Changed credential type | Claim type is domain bound and cannot be swapped. | Critical |
| Subject substitution | Chain, contract, circle, member reference, and owner key are bound. | Critical |
| Artifact reuse by another wallet | Fresh challenge proves current possession of the owner key; the JSON alone is insufficient. | Critical |
| Cross-chain replay | Chain and deployment registry are bound and verified. | Critical |
| Cross-contract replay | Contract address is registry resolved and signed. | Critical |
| Cross-version replay | `iwa-credential/1` and `/2` use distinct schemas, domains, keys, and routing. | Critical |
| Malformed/truncated artifact | Strict size and schema validation rejects safely. | High |
| Fail-open verifier | RPC, decoding, timeout, or evidence failures return invalid or unable-to-verify, never valid. | Critical |
| Cross-circle correlation | V2 member reference and identity key differ per circle; no global identifier is added. | High |
| Raw contribution leakage | Artifact and response contain no amounts or round-by-round history. | High |
| Member graph leakage | Artifact and response contain no other member data or payout order. | High |
| Logging leakage | No artifact body, member reference, keys, invite data, viewing key, or raw evidence is logged. | Critical |
| False completion | Scheduled, authorized, pending recovery, public payout, and NoFundedRecovery never qualify. | Critical |
| Cured-default laundering | `MissedDefault` never becomes qualifying Good Standing because it was cured. | Critical |

## 5. Identity and compatibility matrix

| Attack | Required assertion | Blocking severity |
|---|---|---|
| Root exposure | Identity root and derived private keys never cross frontend storage boundary unencrypted. | Critical |
| Cross-circle linkage | Same root yields distinct member reference and identity/auth keys per circle. | High |
| Auth epoch rollback | Epochs increase monotonically; old signatures fail. | Critical |
| Destination epoch rollback | Old destination commitments and proofs fail after rotation. | Critical |
| Recovery takeover | Only identity-key proof changes auth or destination data. | Critical |
| V1/V2 collision | Resource identity is `(contract address, circle id)` and every read carries `protocol_version`. | Critical |
| Unknown version | Unknown address, class, schema, or version fails closed. | High |
| V1 regression | Existing V1 tests and behavior remain unchanged. | Critical |
| Premature default | V2 cannot become the create default while any release gate is closed. | Critical |

## 6. Testnet gates

All are required:

1. capability gate reclassified A or B with exact source and wallet evidence
2. full Cairo suites, including unchanged V1 and real privacy-pool integration
3. property and invariant suites for identity, epochs, state machine, and accounting
4. frontend and backend suites, typechecks, and production builds
5. real compatible-wallet private payout and private recovery at minimal testnet value
6. private fallback test with a testnet-only shortened delay
7. both credential types and possession verification end to end
8. V1/V2 routing and unknown-version fail-closed behavior
9. responsive browser verification without changing the approved visual system
10. red-team matrices closed with Critical = 0 and High = 0
11. class hashes, addresses, token, pool/privacy primitive, and feature flags verified read only
12. secrets and logs reviewed

## 7. Mainnet gates

Mainnet additionally requires:

1. reviewed testnet evidence
2. independent external audit disposition appropriate to the financial and privacy risk
3. reviewed source-to-class-hash verification
4. config-pinned deployment registry
5. production V1 and V2 coexistence verification
6. explicit human approval before every deployment write
7. no open Critical or High finding
8. truthful STATUS and SECURITY records

No automatic deployment or create-default flip is permitted.

## 8. Current release decision

Verdict B is established at the pinned source level through STRK20 shadow accounts. The release gate remains closed because Iwa's installed Wallet API types are `0.10.3`, no compatible real browser wallet has been exercised, and the exact target-network anonymizer deployment, governance, recovery behavior, and Iwa real-pool path remain unverified. No V2 testnet or mainnet release is authorized.

After review, the next security work is the test-first shadow-account capability plan G1 through G5, not complete IwaCircleV2 production implementation.

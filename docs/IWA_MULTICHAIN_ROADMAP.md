# Iwa Multichain Roadmap

_Last updated: 2026-09-10_

## Purpose

This is the living source of truth for Iwa's multichain expansion.

Iwa should remain one product and one protocol, with multiple chain implementations.

Core principle:

> People use Iwa. Iwa uses crypto.

The user should not need to understand which chain is underneath unless they choose to.

---

## Recommendation

Preserve the live Starknet V1 product and the current EVM/Zama Prize Savings
implementation. Do not multiply savings-circle implementations until the
Starknet V2 private payout primitive and chain-neutral protocol are proven.

For the current release:

- Keep the working Starknet V1 deployment and its preserved history.
- Keep Prize Savings as the current EVM/Zama implementation on Ethereum Sepolia.
- Preserve the current V1 contracts for existing circles.
- Keep V2 and further multichain work as a deliberate product protocol program.
- Design all V2 work to be chain-neutral from the beginning.
- Treat Celo, Nimiq, Base, and other future integrations as planned, not shipped.

Why:

1. Multiple chains multiply audit and maintenance risk.
2. V2 identity and recovery need a protocol-level redesign first.
3. The current Starknet implementation already has real users/state and must not be destabilized.
4. Celo, Base, Ethereum, and other EVM chains can later share an audited EVM adapter family.
5. Solana requires a separate Rust/Solana implementation and should come after the protocol spec is stable.

---

# Product Architecture

## Iwa User

The product identity.

Should not equal a wallet address.

Future model:

```text
IwaUser
  Accounts[]
    Starknet
    EVM
    Solana
    future chains

  Authenticators[]
  RecoveryMethods[]
```

## Private Member Identity

Separate from the Iwa user account and chain address.

V2 target:

- random private identity root
- different member pseudonym per circle
- different pseudonym per chain
- no derivation from email
- no derivation from public wallet address
- stable when account signer changes
- stable after recovery

## Chain Account

May be:

- connected external wallet
- future embedded/passkey account
- future chain-specific account

## Web Session

Read-only product authentication.

Must never authorize money movement.

---

# Protocol Rule

Iwa is:

> One protocol, multiple chain implementations.

We do not create separate business logic for each chain.

## Architectural rule

> One Iwa protocol, multiple chain implementations. Chain-specific privacy and
> settlement primitives must never leak into the core domain.

Made explicit:

- The Iwa core protocol / domain is chain-neutral. It knows `Circle`, `Member`,
  `Contribution`, `Obligation`, `Payout`, `Standing`, `Credential`, `Identity` —
  and nothing about a specific chain's wallet API, RPC, proof system, token
  standard, or transaction envelope.
- **Portable Trust Credential semantics are chain-neutral.** The claims (Good
  Standing over N qualifying rounds; Circle Completion on the member's own
  settled private payout), the canonical artifact, and the proof-of-possession
  challenge are defined at the protocol level. Only the hash primitive, the
  signature curve, and the on-chain fact source are supplied by the chain
  adapter.
- **Private pot collection semantics are chain-neutral.** "The scheduled member
  privately collects the round's state-derived amount; no public-ERC20 payout;
  no admin path; the amount is never caller-supplied" is a protocol rule. How
  privacy is achieved (STRK20 precommitted note on Starknet; a different
  mechanism elsewhere) lives entirely in the PrivacyAdapter / PaymentAdapter.
- The **Starknet implementation** uses Cairo contracts + the STRK20 privacy pool
  + a browser wallet (Ready X) reached through a Starknet adapter. Cairo types,
  `sncast`/`snforge`, Poseidon, the Stark curve, and STRK20 server actions are
  all adapter-internal.
- **EVM implementations** bring their own payment and privacy adapters (their
  own settlement path, their own privacy technology — e.g. FHE or a shielded
  pool), satisfying the same protocol spec and invariant suite.
- **Solana**, later, uses a Solana-specific adapter (Rust, PDAs, SPL tokens),
  again against the same spec.
- **No cross-chain fund bridge is required for the first multichain phase.**
  Each circle lives entirely on one chain. Portability in this phase is for
  identity and the Portable Trust Credential, not for circle funds.

A chain-neutral Iwa Protocol Specification must define:

- circle lifecycle
- membership
- payout order
- contribution requirements
- grace/default rules
- settlement
- stable member identity
- rotatable authorization key
- recovery
- payout fallback
- event semantics
- privacy capability flags
- security invariants

Every chain implementation must satisfy the same protocol specification.

The implementation boundary is:

```text
Iwa Core
  -> ChainAdapter
       -> PaymentAdapter
       -> PrivacyAdapter
       -> CredentialVerifier
```

Core concepts are `Circle`, `Member`, `Contribution`, `Obligation`, `Payout`,
`Standing`, `Credential`, and `Identity`. Chain-specific wallet, RPC,
cryptography, token, and transaction types stay behind the adapters.

---

# Current Release

## Current chain

Starknet mainnet.

## Current state

- IwaCircle V1 deployed
- STRK20 privacy integration
- working invite/join/contribution flows
- read-only Iwa sessions
- wallet lifecycle hardening
- production deployment hardened
- known V1 payout liveness limitation documented
- Prize Savings implemented through Zama FHE on Ethereum Sepolia
- shared frontend wallet management for Starknet and EVM
- Starknet V2 private payout: shadow-account path **superseded / infrastructure-blocked**
  (no canonical browser-wallet shadow-account + anonymizer infrastructure on the
  target network — blocker V2-02). Selected path is **Candidate P**: a
  precommitted per-circle private destination note against the pinned STRK20
  pool. V2 contracts (`IwaCircleV2`, `IwaStrk20HelperV2`) are implemented and
  tested (A2/A3); the V2 frontend payout path is complete; the Portable Trust
  Credential is implemented. Mainnet declare/deploy and the real-value mainnet
  proof remain pending.
- A1 (Ready X `wallet_addDeclareTransaction` support) confirmed on real Ready X
  against Starknet mainnet — the declare request reached the wallet approval
  prompt.

## Do not change before submission

- V1 member identity
- deployed V1 contracts
- existing circle state
- current payout order
- current settlement authorization
- STRK20 transaction model

---

# Post-Submission Program

## Phase M0: Freeze Current Release

Goal:

Preserve the current working release before protocol expansion.

Tasks:

- final E2E audit
- run Cairo tests with Scarb/snforge
- contract PoC/adversarial testing
- mainnet read verification
- complete demo/release documentation
- tag the stable V1 release

Deliverable:

A reproducible V1 release baseline.

---

## Phase M1: Iwa Protocol Specification V2

Goal:

Write the chain-neutral protocol before writing new chain contracts.

Create:

```text
protocol/
  SPEC.md
  SECURITY_INVARIANTS.md
  IDENTITY_V2.md
  EVENTS.md
  TEST_VECTORS.md
```

Specify:

- circle state machine
- member states
- contribution lifecycle
- payout lifecycle
- recovery
- auth key rotation
- timeout behavior
- fallback payout behavior
- contract version capabilities

No chain-specific assumptions unless unavoidable.

---

## Phase M2: Member Identity V2

Goal:

Fix current V1 identity limitations.

Target architecture:

```text
identity_root = 32 random bytes

circle_secret =
  HKDF(identity_root, chain_id + circle_id)

member_ref =
  Poseidon(circle_secret)

auth_key =
  HKDF(identity_root, chain_id + circle_id + epoch)
```

Important:

- exact final construction requires reviewed test vectors
- never derive identity from email
- never derive identity directly from wallet address
- member_ref must not include a rotatable auth key
- V1 circles remain unchanged

Security properties:

- stable membership identity
- rotatable authorization key
- signer recovery
- per-circle unlinkability
- multichain compatibility

---

## Phase M3: IwaCircle V2 on Starknet

Goal:

Build the first implementation of the V2 protocol only after Phase M3A passes.

### Phase M3A: private payout capability gate

Current result is **B: feasible with a small V2 contract change at the pinned
source level**.

The originally-identified route (a precommitted per-circle STRK20 *shadow
account* invoked by an anonymizer) is **superseded / infrastructure-blocked**:
there is no canonical browser-wallet shadow-account primitive and no verified
anonymizer deployment on the target network (blocker V2-02). The RED tests that
red-teamed it are kept for history but ignored/skipped in CI
(`contracts/starknet/tests/test_private_destination_capability_v2.cairo`,
`iwa-web/src/chains/strk20/v2/privateDestinationCapability.test.ts`).

The **selected route is Candidate P**: the scheduled member pre-registers a
private destination note (amount from circle state, destination bound by a
member-auth-key signature) *before* the STRK20 transaction is assembled; at
payout the V2 helper settles the state-derived transfer into that precommitted
note. No inline settlement signature, no caller-supplied amount, no admin path,
no assembly-time open-note ID to sign. Its production security matrix is
`contracts/starknet/tests/test_payout_settlement_v2.cairo`; its capability proof
against the genuine pinned pool is
`contracts/starknet/tests/test_precommitted_note_payout_v2.cairo`.

Status: V2 contracts implemented and tested (A2/A3 complete); V2 frontend payout
path complete; Portable Trust Credential implemented. Still pending before
mainnet: the declare/deploy itself, rotation and private recovery hardening, a
real minimal-value mainnet receipt, and external audit. Public ERC20 payout
remains prohibited.

Expected additions:

- V2 join flow
- stable member_ref
- separate authorization key
- auth key epoch
- recovery commitment
- delayed key rotation
- rotation cancellation
- rotation nonce namespace
- recovery events
- capability/version reporting

No V1 migration.

V1 and V2 coexist.

---

## Phase M4: Payout Liveness V2

Goal:

Address H-2 without giving Iwa custody.

Preferred direction:

- member-chosen fallback destination
- private payout and private fallback only
- fallback committed before funds are at risk
- long time lock
- no organizer override
- no admin override
- recovery cannot silently change payout order
- auth and destination epochs are monotonic
- fresh member authorization resets the fallback timer

Conditional pairing, after the private destination primitive is proven:

- time-locked fallback
- member recovery key
- V2 signer recovery

Must be externally audited before mainnet.

---

## Phase M5: V2 Security Program

Before V2 mainnet:

- full Cairo tests
- fuzz tests
- invariant tests
- state-machine tests
- unauthorized key rotation PoCs
- replay PoCs
- payout redirection attempts
- recovery takeover attempts
- duplicate member attempts
- stuck-state scenarios
- mainnet source/class-hash verification
- external security audit

No mainnet deployment before this gate passes.

---

# Chain Expansion

## Phase C1: Base

Recommended first new chain.

Why:

- EVM ecosystem
- relatively inexpensive transactions
- USDC availability
- broad developer tooling
- good fit for consumer-facing payments

Build:

```text
contracts/evm/
```

Language:

Solidity.

Do not clone Cairo line by line.

Implement the V2 specification and invariant suite.

---

## Phase C2: Ethereum

Use the same audited EVM contract family where possible.

Differences should mainly be:

- deployment configuration
- addresses
- fee assumptions
- supported assets
- operational limits

Avoid Ethereum-specific protocol forks unless necessary.

---

## Phase C3: BNB Chain

Reuse the audited EVM implementation.

Only launch if there is a clear user/distribution reason.

Do not add chains simply for a multichain badge.

---

## Phase C4: Solana

Treat Solana as a separate implementation.

Expected stack:

- Rust
- Anchor where appropriate
- PDAs
- Solana account model
- SPL tokens

Do not attempt Solana until the V2 protocol specification is mature.

Solana must pass the same logical invariant suite as Starknet/EVM even if the implementation is different.

---

# Shared Repository Direction

Future structure:

```text
protocol/
  SPEC.md
  SECURITY_INVARIANTS.md
  IDENTITY_V2.md
  EVENTS.md
  TEST_VECTORS.md

contracts/
  starknet/
  evm/
  solana/

packages/
  protocol-types/
  identity/
  chain-adapters/
  sdk/

apps/
  web/
```

---

# Chain Capability Model

Not every chain will support the same privacy features.

The UI must expose capabilities honestly.

Example:

```text
ChainCapabilities {
  privateContributions
  privatePayouts
  recoverableIdentity
  sponsoredTransactions
  supportedTokens
  portableTrustCredential
  contractVersion
}
```

Possible initial model:

| Chain | Product implementation | Privacy capability | V2 identity | Status |
|---|---|---|---|---|
| Starknet | Savings circles V1 + V2 (Candidate P) | STRK20 private inbound; V2 private payout via precommitted destination note | Planned | V1 shipped; V2 contracts + frontend + Portable Trust Credential implemented and tested; mainnet deploy + real-value proof pending |
| Ethereum Sepolia | Prize Savings | Zama FHE encrypted balances, draw and claim accounting | Not shared with circles V2 | Current testnet implementation |
| Celo | Payment/agent integration | To be validated | Planned | Planned, not shipped |
| Nimiq | Pay Mini App integration | To be validated | Planned | Planned, not shipped |
| Base and other EVM | EVM adapter family | To be declared per deployment | Planned | Planned, not shipped |

Never claim equal privacy where it does not exist.

---

# Embedded Accounts

Embedded accounts are separate from multichain contract deployment.

They should be built only after Member Identity V2 is solved.

Future entry:

```text
Enter Iwa

Continue with email
Connect a wallet
```

Target:

- passkey-controlled
- no seed phrase by default
- no server-held private key
- no email-only money authorization
- account control transferable away from Iwa
- recovery without Iwa being able to steal funds

Open blocker:

STRK20 currently delegates privacy responsibilities to the wallet.

An embedded account path needs a dedicated STRK20 privacy feasibility spike.

---

# Multichain Security Invariants

These apply everywhere:

1. Iwa admin cannot move user funds.
2. Organizer cannot redirect payouts.
3. Payout order is deterministic.
4. Member identity is not derived from email.
5. Member identity is not globally reusable across circles in V2.
6. Rotating an auth key never changes the member_ref.
7. Recovery cannot silently change payout recipient.
8. Every money-moving action requires explicit user confirmation.
9. Read sessions never authorize transactions.
10. No chain-specific implementation may weaken protocol invariants.
11. Existing V1 circles are never force migrated.
12. New contract families require chain-specific security review.
13. Cross-chain bridges are not required for Iwa to be multichain.
14. Privacy claims must match the actual chain capability.
15. Protocol behavior must be testable from common vectors.

---

# Cross-Chain Strategy

Do not begin by bridging circle funds between chains.

Prefer:

- each circle belongs to one chain
- each circle has one asset/configuration
- Iwa provides one application experience across all chains

This avoids making bridges part of the core trust model.

Future cross-chain portability should focus first on:

- Iwa user identity
- Portable Trust Credential
- reputation proofs

not moving active circle funds between chains.

---

# Rollout Policy

A new chain is added only when all are true:

- clear user/distribution reason
- protocol implementation complete
- invariant suite passing
- chain-specific threat model complete
- contracts audited
- frontend capability handling ready
- monitoring/indexing ready
- deployment runbook ready
- supported asset verified
- recovery behavior understood

No "ship everywhere" launches.

---

# Current Priority Order

## Before current submission

1. Finish current Starknet product features.
2. Finish organizer experience.
3. Finish admin operational view if time permits.
4. Full E2E.
5. Full Cairo/toolchain run.
6. Contract security/PoC pass.
7. Mainnet verification.
8. Demo and submission.

## Current V2 sequence

1. Private Starknet payout capability gate with exact wallet and contract evidence.
2. Freeze the chain-neutral Protocol V2 specification and adapter interfaces.
3. Freeze Member Identity V2 test vectors.
4. Implement IwaCircle V2 and private recovery test-first only if the gate passes.
5. Complete the V2 red-team matrix.
6. Verify Starknet V2 on testnet with a real compatible wallet.
7. Complete independent external audit review.
8. Consider the shared EVM circles adapter family.
9. Plan Celo and Nimiq integrations against actual product demand and capabilities.
10. Consider Base and other EVM deployments later.

---

# Ideas Backlog

Use this section for future ideas without treating them as approved scope.

- passkey embedded accounts
- sponsored onboarding
- email product accounts
- external wallet linking
- recovery signer
- second passkey
- Portable Trust Credential across chains
- private credentials
- chain capability registry
- per-chain fee abstraction
- mobile notifications
- stablecoin abstraction
- fiat/mobile-money entry
- circle discovery
- business/organization circles
- lending based on private reliability proofs
- public SDK
- protocol indexer
- developer API
- analytics
- governance only if genuinely needed

---

# Decision Log

## 2026-09-10

### Decision

The Starknet V2 private payout path is **Candidate P** (precommitted private
destination note). The shadow-account / anonymizer path is superseded.

### Reason

The shadow-account path depends on browser-wallet and anonymizer infrastructure
that does not exist on the target network (blocker V2-02). Candidate P achieves
the same protocol guarantee — private, state-derived payout with no admin path
and no public-ERC20 fallback — using only the pinned STRK20 pool that is already
in production for private contributions. Its RED history is retained but ignored
in CI.

### Decision

Restate the core architectural rule: chain-specific privacy and settlement
primitives must never leak into the core domain; Portable Trust Credential and
private pot collection semantics are chain-neutral.

### Reason

V2 work (Cairo contracts, STRK20 helper, credential library) is the first real
test of the adapter boundary. Writing the rule down keeps the EVM and Solana
implementations honest against one protocol spec.

## 2026-09-03

### Decision

Do not build multiple chain implementations before the current submission.

### Reason

The current Starknet product works, while V2 identity/recovery and protocol specification must be stabilized before multiplying implementations.

### Decision

Design V2 as chain-neutral.

### Reason

Base, Ethereum, BNB, Solana and future chains should implement one protocol rather than diverging copies.

### Decision

Base is the preferred first expansion chain.

### Reason

It gives Iwa an EVM deployment with practical transaction costs and strong stablecoin tooling.

### Decision

Solana comes after the EVM implementation.

### Reason

It requires a separate Rust/Solana architecture, increasing security and maintenance burden.

---

# Open Questions

Keep updating this section.

- What exact V2 member identity construction passes external review?
- Which real browser wallet implements Wallet API `0.10.4-rc.1` shadow
  commitment and shadow invoke on the target network without exposing a viewing
  key to the dapp?
- Which shadow-account anonymizer deployment, class hash, pool binding, account
  class, and governance posture are acceptable for V2?
- What is the final V2 private recovery model after shadow-account rotation and
  fallback timing are tested?
- What is the payout fallback delay after its attack model is tested?
- Which account implementation will embedded Iwa accounts use?
- Can STRK20 privacy work without a traditional wallet client?
- Can account deployment be sponsored reliably on Starknet?
- What current user need makes Celo, Nimiq, or Base the next adapter priority?
- Should EVM circles use upgradeable or immutable contracts?
- What event schema should be identical across chains?
- How do Portable Trust Credentials remain unlinkable across chains?
- What chain should follow Base based on actual users?
- When does Solana justify its separate implementation cost?

---

# Update Rules

Whenever a new multichain idea is proposed:

1. Add it to Ideas Backlog.
2. Do not treat it as approved scope immediately.
3. Record architectural/security implications.
4. If approved, move it into the roadmap.
5. Add important choices to Decision Log.
6. Update current priority order.
7. Never erase historical decisions without recording why they changed.

This file is intentionally a living document.

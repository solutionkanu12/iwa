# IWA — Architecture

## Purpose

IWA is a private community savings and portable financial trust platform.

The architecture is designed around two requirements:

1. private savings and payouts must work correctly on Starknet through STRK20
2. the IWA product must remain portable to future chains without rewriting the core business model

Starknet is the first native chain implementation.

It is not the permanent canonical chain for all future IWA deployments.

## High-level architecture

```text
┌──────────────────────────────────────────┐
│                Frontend                  │
│   mobile-first saver + verifier UX       │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│             Application Layer            │
│      workflows, use cases, orchestration │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│                IWA Core                  │
│                                          │
│  circles · rounds · obligations          │
│  payout rules · grace/default states     │
│  credential semantics · invariants       │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│             Chain Interface              │
└───────────────┬───────────────┬──────────┘
                │               │
                │               └── future chain adapters
                │
                ▼
┌──────────────────────────────────────────┐
│            Starknet Adapter              │
│                                          │
│  wallet · RPC · transactions · events    │
│  token configuration · explorers         │
└────────────────────┬─────────────────────┘
                     │
        ┌────────────┴─────────────┐
        │                          │
        ▼                          ▼
┌───────────────────┐   ┌────────────────────┐
│   Cairo IWA       │   │       STRK20       │
│   Contracts       │   │  Privacy Protocol  │
│                   │   │                    │
│ IwaCircle         │   │ shielded balances  │
│ helper contract   │   │ private transfer   │
└───────────────────┘   └────────────────────┘
```

Supporting infrastructure:

```text
Backend / Indexer
├── public event indexing
├── notifications
├── public metadata
├── contract health
├── analytics
├── verification usage
└── admin reporting

Admin Dashboard
├── platform health
├── public circle metrics
├── tx monitoring
├── operational alerts
├── audit logs
├── revenue metrics
└── narrowly scoped maintenance controls
```

## Architectural rule

The most important rule in the repository is:

**IWA Core must not depend directly on Starknet.**

Starknet-specific behavior belongs behind the chain interface.

This rule allows IWA to support future ecosystems without replacing the product architecture.

## IWA Core

IWA Core defines the chain-neutral business behavior.

It owns:

- circle lifecycle
- member eligibility rules
- invitation model
- contribution obligations
- round progression
- fixed payout rotation
- grace periods
- deficit handling
- reliability states
- Portable Trust Credential claim semantics
- admin permission rules
- emergency-control semantics
- core invariants

IWA Core should use chain-neutral types wherever possible.

Examples of concepts that belong in Core:

```text
Circle
Member
Round
ContributionObligation
ContributionStatus
PayoutState
CredentialClaim
AdminPermission
AssetId
ChainTransactionReference
```

## Chain interface

The chain interface is the boundary between IWA Core/application code and a specific blockchain.

It should expose capabilities such as:

```text
createCircle
joinCircle
submitContribution
finalizeRound
claimPayout
getCircleState
getContributionState
getTransactionStatus
verifyCredential
```

The exact signatures will be finalized during implementation planning.

The interface should not expose arbitrary Starknet internals to UI components.

## Native chain implementations

Each supported chain gets a native implementation.

### Starknet

Current implementation:

- Cairo smart contracts
- Starknet wallet integration
- Starknet RPC
- STRK20
- USDC
- STRK

### Future EVM

Potential implementation:

- Solidity contracts
- EVM wallet adapter
- EVM settlement/privacy integration

### Future Solana

Potential implementation:

- Rust program
- Solana wallet adapter
- Solana-native settlement/privacy integration

Each implementation may differ internally.

They must satisfy the same IWA business behavior and security invariants.

## Starknet contract architecture

The first Starknet release should use a deliberately small contract surface.

### IwaCircle

Responsible for savings-circle business state.

Expected responsibilities:

- create circles
- maintain membership state
- enforce invitation/approval rules
- lock payout order
- track contribution obligations
- track round progression
- classify missed obligations
- enforce deficit rules
- determine scheduled recipient
- finalize rounds
- expose minimal required public state
- apply limited pause logic

IwaCircle must not contain arbitrary external-call functionality.

### IwaStrk20Helper

Privacy-critical STRK20 integration contract.

Responsible for the exact private-DeFi/helper interaction required by STRK20.

This contract must be designed only after reading:

- `strk20-privacy`
- `strk20-anonymizer-contracts`
- bundled upstream references

Do not infer its interface from memory.

Its expected role is to bridge STRK20 private execution with validated IWA circle state transitions without unnecessarily exposing user financial relationships.

### IwaCredential

This contract is optional.

It should exist only if STRK20's available selective-disclosure model cannot satisfy the required Portable Trust Credential experience.

Do not build it merely because the previous Stellar implementation had a verifier contract.

## STRK20 role

STRK20 is not a shield button attached to an otherwise public savings contract.

The integration must be load-bearing.

Target privacy-sensitive flows include:

- shielding supported assets
- private contribution execution
- private payout execution
- concealed financial relationships
- selective disclosure where supported

The exact protocol flow must be validated during Phase 1 research.

## Assets

Initial supported assets:

- USDC
- STRK

Do not support arbitrary tokens in the first release.

Token configuration must be explicit and allowlisted.

Chain-specific addresses belong in configuration, not inside IWA Core.

## Circle lifecycle

A simplified conceptual lifecycle:

```text
CREATED
  ↓
OPEN_FOR_MEMBERS
  ↓
ACTIVE
  ↓
ROUND_N
  ↓
ROUND_N_FINALIZED
  ↓
NEXT_ROUND
  ↓
COMPLETED
```

Emergency states may include:

```text
PAUSED_FOR_NEW_ACTIONS
```

A pause must not rewrite historical state.

## Membership

The initial product uses private, invite-based circles.

Joining is controlled by:

- invitation
- approval where configured
- circle capacity
- contract state

Membership rules must not allow arbitrary public users to join an existing trusted circle unless that circle explicitly supports such a future mode.

## Payout rotation

Payout order is determined before active contributions begin.

Once locked:

- admin cannot reorder recipients
- admin cannot skip recipients arbitrarily
- admin cannot redirect funds
- payout logic follows deterministic contract state

## Contribution state

Each required member contribution should have a deterministic obligation.

Possible status:

```text
PENDING
ON_TIME
LATE_WITHIN_GRACE
MISSED_DEFAULT
```

A completed status is immutable.

Admin cannot change a default into an on-time contribution.

## Grace periods

A contribution that misses the original due time may remain valid during a configured grace period.

After the grace window expires without settlement:

```text
MISSED_DEFAULT
```

The exact timestamp/block semantics must be deterministic and tested.

Locked decision (August 27, 2026):

- Time source: Starknet block timestamp in seconds.
- `due_at` and `grace_ends_at` are derived from one authoritative
  contract-side timestamp source (the same read used to classify the
  obligation); no component computes the deadline independently.
- Classification for every contribution obligation:

```text
now <= due_at                          -> ON_TIME
due_at < now <= grace_ends_at          -> LATE_WITHIN_GRACE
now > grace_ends_at (no valid
settlement)                            -> MISSED_DEFAULT
```

- Boundaries are inclusive as written above; the exact boundary behavior is
  pinned by tests (slice 6E).

## Deficit handling

If a scheduled payout recipient has an unresolved contribution deficit:

- their payout does not proceed normally
- the payout remains locked under predefined rules
- the member may cure the deficit where allowed
- fallback behavior is deterministic
- admin cannot choose a different recipient manually

The exact fallback state machine must be finalized before contract implementation.

Locked decision (August 27, 2026):

- If the scheduled payout recipient has an unresolved deficit, the payout is
  **not redirected** and is marked `DEFERRED/LOCKED`.
- The circle continues to later rounds; the locked payout does not stall
  progression.
- The member may cure the deficit under the predefined cure rules and then
  claim their deferred payout.
- Admin cannot select a replacement recipient and cannot release the payout
  arbitrarily.
- If the cycle reaches final settlement while the deficit remains uncured, a
  deterministic recovery/refund state-machine path applies (no admin
  discretion); the exact recovery amount derives from verified state and the
  path is replay protected.

Locked cure-rule parameters (August 28, 2026). Stored on each circle at
creation as `CureConfig`; not caller-configurable; execution is Task 6F.

1. Eligibility: a member in `MISSED_DEFAULT` may cure only the unresolved
   contribution deficit for that specific circle + round + obligation.
2. Window: a cure is allowed until that member's deferred payout reaches
   final settlement/recovery. No admin extension. Contract timestamps/state
   decide whether the window is still open.
3. Amount: exactly the unresolved contribution deficit. No partial cure in
   MVP. No admin-selected amount.
4. Accounting: a successful cure settles that deficit, does **not** rewrite
   `MISSED_DEFAULT` into `ON_TIME` or `LATE_WITHIN_GRACE`, preserves the
   historical default for credentials, may unlock that member's previously
   deferred payout if all required conditions are met, must not create or
   destroy value, and must be replay protected.
5. Admin cannot waive the deficit, change the cure amount, extend the window,
   erase the default, or release a deferred payout without the deterministic
   cure conditions.

## Reliability model

IWA intentionally avoids one opaque universal score.

Reliability derives from events such as:

- completed rounds
- `ON_TIME`
- `LATE_WITHIN_GRACE`
- `MISSED_DEFAULT`
- completed cycles

Possible credential claims:

```text
completed_cycles >= N
default_count == 0
on_time_rate >= X
successful_rounds >= N
```

The credential system should reveal the requested claim rather than a complete profile.

## Portable Trust Credential

The user should be able to present a scoped statement such as:

> completed at least 3 IWA savings cycles with no defaults

The verifier should receive only:

- requested claim
- validity result
- expiry or validity context where required
- issuer/protocol context
- proof metadata needed for verification

The verifier should not receive the user's raw savings history.

## Legacy ZK architecture

The previous implementation contains:

```text
iwa-circuit/
iwa-prover/
iwa-verifier/
```

These were built around the old Stellar/Circom/Groth16 architecture.

Current rule:

**Preserve until STRK20 research is complete.**

Possible outcome A:

STRK20 disclosure capabilities satisfy the credential MVP.

Then remove unnecessary legacy proving infrastructure.

Possible outcome B:

A separate proof layer is genuinely needed.

Then preserve reusable reputation concepts while rebuilding only the smallest necessary proof system.

Do not mechanically port Soroban verifier code.

## Frontend architecture

The existing `iwa-web/` application is adapted rather than discarded.

The frontend should separate:

```text
UI Components
      ↓
Feature / Application Services
      ↓
Chain-Neutral Interface
      ↓
Starknet Adapter
```

UI components must not directly scatter Starknet SDK calls throughout the application.

The frontend should remain usable if a different chain adapter is later introduced.

## Starknet frontend adapter

Responsible for:

- wallet discovery/connect
- chain validation
- STRK20 wallet interaction
- transaction construction
- IWA Cairo contract calls
- transaction tracking
- explorer links
- address/token configuration
- user-safe errors

A wrong chain or invalid configuration must fail closed.

## Backend/indexer architecture

The backend is optional supporting infrastructure.

It improves usability but is not custody and is not authoritative financial state.

Allowed responsibilities:

- index public contract events
- index non-sensitive public circle metadata
- notification scheduling
- transaction-health monitoring
- contract-health monitoring
- verification usage metrics
- product analytics
- admin reporting
- public discovery where applicable

It must not become the source of truth for private financial state.

## Backend privacy boundary

Never store:

- wallet seeds
- private keys
- signing secrets
- viewing keys
- raw private transfer graph
- raw private contribution history
- private user-to-wallet identity mappings unless a separate explicit future identity product requires it and receives a dedicated privacy/security design
- raw credential evidence

The absence of private backend state is intentional.

## Backend outage behavior

If the indexer is unavailable:

- contracts remain authoritative
- funds remain controlled by protocol rules
- core transactions should remain possible where technically feasible
- analytics may become unavailable
- admin reporting may become stale
- frontend must clearly mark indexed data as unavailable or stale

Never silently substitute fabricated or fixture data in production.

## Admin dashboard architecture

The admin dashboard is non-custodial.

It reads public/indexed operational data and exposes limited maintenance controls.

Allowed capabilities may include:

- contract health
- transaction health
- public circle statistics
- failed action monitoring
- alerts
- support workflow
- audit logs
- verification usage
- subscription/revenue metrics
- feature flags where safe
- narrowly scoped emergency controls

Forbidden capabilities:

- move user funds
- reveal private financial history
- access viewing keys
- rewrite contributions
- rewrite defaults
- change locked payout rotation
- forge credentials
- arbitrarily redirect payouts

## Admin authentication

Admin authentication must protect operational surfaces.

The exact implementation is intentionally deferred until the backend stack is selected.

Regardless of implementation:

- privileged actions must be authenticated
- sensitive actions must be logged
- roles should follow least privilege
- emergency actions should be clearly attributable

## Emergency pause

The first implementation may include a narrow pause capability.

Safe targets for pause include:

- new circle joins
- new contributions
- selected new state-changing operations if required

Pause must not grant authority to:

- seize existing funds
- erase state
- change payout order
- forge financial history

Recovery/withdrawal behavior during pause must be designed explicitly before mainnet.

## Data model

Conceptual chain-neutral entities:

### Circle

```text
id
chain
asset
contributionAmount
cadence
memberLimit
currentRound
status
payoutOrderCommitment
gracePeriod
createdAt
```

Exact public/private representation depends on STRK20 research.

### Member

```text
memberId or commitment
circleId
slot
membershipState
```

Do not assume the member's public wallet address must be persisted as the primary identity.

### ContributionObligation

```text
circleId
round
memberRef
dueAt
graceEndsAt
status
```

### PayoutState

```text
circleId
round
scheduledMember
eligibilityState
settlementState
```

### CredentialClaim

```text
claimType
threshold
validityContext
proofReference
```

These are conceptual domain models, not finalized storage layouts.

## Public data minimization

Only make information public because protocol correctness or product functionality requires it.

Potential public data:

- existence of a circle
- supported asset
- general cadence
- non-sensitive status
- aggregate membership metadata where safe
- contract state necessary for verification

Avoid unnecessary exposure of:

- individual contribution behavior
- payout relationships
- precise private balances
- user financial graph

## Configuration

Chain-specific configuration should include:

```text
chainId
rpcUrl
explorerUrl
strk20PoolAddress
usdcAddress
strkAddress
iwaCircleAddress
iwaHelperAddress
optionalCredentialAddress
```

Secrets must be separated from public configuration.

Alchemy or equivalent API keys belong only in environment variables.

Never commit them.

## Deployment verification

Before a mainnet deployment or interaction:

1. verify expected chain is `SN_MAIN`
2. verify official STRK20 pool address
3. verify supported token addresses
4. verify deployed Cairo class hashes
5. verify contract addresses
6. verify admin/pause roles
7. verify frontend configuration
8. verify backend configuration
9. verify no secret material is present in the repository
10. begin with minimal-value transactions

Any mismatch should stop deployment.

## Security boundaries

Major trust boundaries:

```text
User Wallet
    │
    ▼
STRK20
    │
    ▼
IWA Cairo Contracts
    │
    ▼
Public Chain State

Frontend
    │
    └── must not leak private data

Backend / Indexer
    │
    └── receives public/non-sensitive data only

Admin Dashboard
    │
    └── operational authority only, no custody
```

Each boundary requires separate testing.

## Testing architecture

Testing should exist at multiple levels.

### Core tests

Test chain-neutral business behavior.

### Cairo unit tests

Test individual contract behavior.

### Cairo fuzz tests

Test unexpected values and state transitions.

### Invariant tests

Prove persistent properties such as:

- payout order cannot change after lock
- one obligation cannot be satisfied twice
- one payout cannot execute twice
- unauthorized admin cannot alter protected state
- contribution history cannot be rewritten
- accounting remains internally consistent

### STRK20 integration tests

Test exact privacy protocol interactions.

### Frontend integration tests

Test wallet and user flows without exposing sensitive state.

### Backend tests

Test privacy boundaries, stale data, indexing, and authentication.

### Mainnet verification

Use small-value real Starknet Mainnet transactions only after audit gates pass.

## Migration strategy

Do not delete the legacy implementation immediately.

Migration order:

```text
1. preserve old system
2. document current behavior
3. research STRK20
4. define chain-neutral core
5. build Cairo replacement
6. verify replacement
7. integrate STRK20
8. verify privacy path
9. migrate frontend
10. verify end-to-end flow
11. retire obsolete Stellar/Soroban components
```

Replacement must precede deletion.

## Revenue architecture

Revenue surfaces should remain outside the financial trust boundary where possible.

Primary models:

- B2B credential verification
- Pro circle subscriptions
- enterprise/white-label
- optional protocol/partner revenue

Admin revenue analytics may use:

- verification counts
- plan status
- subscription metadata
- aggregate usage

Never monetize private raw financial history.

## STRK20 sprint architecture priority

When making scope decisions:

```text
STRK20 depth
        >
mainnet correctness
        >
security
        >
core saver flow
        >
credential capability
        >
admin depth
        >
visual polish
```

A polished interface cannot compensate for a shallow privacy integration.

## Architectural non-goals

The first Starknet release does not require:

- arbitrary token execution
- cross-chain bridging
- all future adapters
- giant centralized backend
- custodial account management
- universal numerical credit score
- unrestricted admin powers
- unnecessary second ZK architecture

## Source-of-truth rule

When implementation and this document disagree:

1. stop
2. determine whether implementation or architecture changed intentionally
3. update the approved architecture if necessary
4. do not silently allow architecture drift

This file describes the current technical direction for IWA.
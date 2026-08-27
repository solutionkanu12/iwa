# IWA — Project

## One line

IWA is private community savings and portable financial trust infrastructure.

It lets people participate in rotating savings circles while keeping their contributions, payouts, balances, financial relationships, and underlying savings history private.

Users can later share a scoped Portable Trust Credential that proves a specific reliability claim without exposing their full financial history.

## Problem

Millions of people build real financial reliability outside formal banking systems.

They save through ajo, esusu, cooperatives, community groups, family circles, informal savings clubs, and other trusted networks.

That reliability is real, but it is usually:

- difficult to verify
- difficult to carry between services
- invisible to formal financial institutions
- exposed if users are forced to share complete transaction histories

IWA turns that informal financial reliability into something portable and verifiable without requiring users to surrender their full financial lives.

## Core principle

IWA monetizes trust verification and infrastructure, not private financial data.

Privacy is part of the product architecture, not a marketing feature.

## Primary users

### Savers

People participating in community savings circles.

They should be able to:

- join a trusted private circle
- contribute privately
- receive payouts privately
- build a reliability history
- selectively prove reliability

The saver is the primary product user.

### Circle organizers

Trusted people or organizations coordinating savings circles.

They can manage limited operational settings but cannot:

- seize member funds
- redirect payouts
- rewrite contribution history
- erase defaults
- forge credentials
- reveal member private financial activity

### Credential verifiers

Banks, lenders, fintechs, landlords, insurers, merchants, employers, service providers, and other institutions.

They may verify a scoped claim such as:

> completed at least 3 savings cycles with no defaults

They must not receive the user's complete contribution history unless the user explicitly chooses a future disclosure mode designed for that purpose.

## STRK20 Private Sprint

IWA is being rebuilt for the STRK20 Private Sprint on Starknet.

Starknet is the first production chain implementation of IWA, not the permanent home of all future deployments.

The Starknet implementation uses:

- Cairo
- Starknet Mainnet
- STRK20
- USDC
- STRK
- Starknet-native wallet integration

STRK20 is a core protocol dependency for the sprint.

A shallow integration is unacceptable.

The main demo must prove a real privacy-preserving savings flow.

## Main Starknet demo flow

Wallet

→ shield USDC or STRK using STRK20

→ join a private IWA circle

→ make a private contribution

→ progress through the circle

→ receive a private payout

→ build reliability history

→ selectively disclose a Portable Trust Credential

## Multichain strategy

IWA is a multichain product.

The product must not be architecturally coupled to Starknet.

The long-term structure is:

```text
IWA Domain Specification
        ↓
Chain Interface
        ↓
Native Chain Implementations
        ├── Starknet / Cairo / STRK20
        ├── Future EVM / Solidity
        ├── Future Solana / Rust
        └── Future chain implementations
```

Each chain gets its own native smart-contract implementation.

Future integrations must not require rewriting the IWA business model.

The implementations may differ internally, but they must satisfy the same IWA domain behavior and security invariants.

## Chain-agnostic product rules

The following belong to IWA Core and must not depend directly on Starknet:

- circle lifecycle
- membership rules
- contribution obligations
- round progression
- payout rotation
- grace periods
- deficit rules
- reliability states
- Portable Trust Credential semantics
- admin permission model
- core business invariants
- frontend product state
- chain-neutral application services

Chain-specific code belongs behind an adapter boundary.

## Circle model

The first release uses private, invite-based circles.

A user joins through an invite or controlled approval flow.

Circles are not permissionless public pools in the MVP.

### Payout order

Payout rotation is agreed when a circle is created.

Once contributions begin, the payout order is immutable.

Admins cannot arbitrarily change recipients.

### Missed contributions

A member who misses a contribution receives a predefined grace window.

Contribution status is classified as:

- `ON_TIME`
- `LATE_WITHIN_GRACE`
- `MISSED_DEFAULT`

History is immutable.

A default cannot be erased by an admin.

### Deficit and payout rule

If a member reaches their payout turn while they have an unresolved deficit, their payout remains locked under predefined rules.

Admin cannot redirect those funds arbitrarily.

A fallback path must be defined by the contract state machine.

## Public versus private data

### Public or indexable

Only minimal operational data should be visible where necessary:

- circle existence
- supported asset
- contribution cadence
- non-sensitive member-count/status metadata
- public contract state
- contract health
- non-sensitive protocol events

### Private

The following must remain private wherever STRK20 supports that privacy boundary:

- member identity
- wallet-to-person mapping
- individual contribution history
- private contribution amounts
- balances
- payout recipient relationships
- private transaction graph
- viewing keys
- raw credential evidence

## Portable Trust Credential

The Portable Trust Credential is a scoped proof of reliability.

It must not become a universal numerical credit score.

Example claims include:

- completed at least 3 cycles
- completed at least 6 cycles with no defaults
- maintained at least a defined on-time threshold
- participated successfully for at least N rounds

The verifier should see only the requested claim, its validity context, and required proof metadata.

The verifier should not see raw savings history.

## Privacy architecture rule

The previous Stellar implementation used Circom and Groth16 as its primary privacy architecture.

That design must not be blindly ported.

For the STRK20 release:

1. understand STRK20 privacy capabilities first
2. use STRK20's native privacy and disclosure mechanisms where they satisfy the requirement
3. add a separate ZK reputation layer only if it provides a capability STRK20 cannot provide cleanly

The old `iwa-circuit` and `iwa-prover` remain preserved until that research is complete.

## Backend and indexer

IWA may use a small chain-neutral backend/indexer to make the product usable as a real service.

It may handle:

- public circle indexing
- public transaction indexing
- notifications
- contract health monitoring
- analytics
- non-sensitive credential metadata
- admin reporting
- API usage metrics
- business metrics

It is not the financial source of truth.

Contracts remain authoritative for protocol state.

The backend must never store:

- wallet private keys
- wallet seeds
- viewing keys
- signing material
- private transfer graphs
- raw private contribution histories
- raw credential evidence

## Admin dashboard

IWA will include a non-custodial admin dashboard.

The dashboard may provide:

- platform statistics
- public circle activity
- contract health
- transaction monitoring
- operational alerts
- failed transaction monitoring
- support tooling
- audit logs
- verification usage
- premium-plan metrics
- revenue metrics
- maintenance controls
- narrowly scoped emergency pause controls

Admin must never be able to:

- seize user funds
- move user funds
- redirect payouts
- change locked payout order
- rewrite contribution history
- erase defaults
- reveal viewing keys
- access private savings history
- forge credential results

## Emergency controls

The Starknet implementation may include a narrowly scoped emergency pause.

The pause should be able to stop risky new actions such as:

- new joins
- new contributions
- selected new protocol actions where required

The pause must not give admin authority to:

- seize funds
- rewrite history
- redirect payouts
- arbitrarily freeze user ownership forever

Safe recovery or withdrawal paths should remain available where technically possible.

## Revenue model

IWA has four primary revenue rails.

### 1. B2B credential verification

Primary long-term revenue model.

Businesses pay to verify scoped Portable Trust Credentials.

Possible models:

- monthly API subscription
- per-verification fee
- usage-based API tiers
- enterprise contracts

IWA sells verification capability, not user data.

### 2. IWA Pro circles

Basic savings participation can remain free or low cost.

Paid plans may include:

- larger circles
- advanced scheduling
- automated reminders
- multi-admin operations
- richer reporting
- export tools
- community management
- premium support
- advanced organization features

### 3. Enterprise and white-label

IWA may provide infrastructure to:

- cooperatives
- microfinance institutions
- fintechs
- NGOs
- employers
- community organizations
- credit unions
- savings platforms

Possible revenue:

- setup fees
- platform subscriptions
- usage fees
- integration contracts

### 4. Optional protocol and partner revenue

Later, IWA may use:

- small transparent protocol fees
- partner integrations
- referral revenue
- revenue sharing

These must not undermine adoption or user privacy.

## Initial assets

The first Starknet release supports:

- USDC
- STRK

Arbitrary-token support is out of scope for the first release.

Additional assets should later be introduced behind explicit allowlisting and reviewed token configuration.

## Security position

IWA is being treated as a real financial product.

Security is a release gate.

Required work includes:

- threat modeling
- access-control review
- accounting-invariant review
- state-machine review
- STRK20 integration review
- privacy leakage review
- replay protection
- double-contribution prevention
- double-payout prevention
- token validation
- admin-boundary testing
- fuzz testing
- invariant testing
- integration testing
- deployment verification
- manual audit

No component should be described as secure merely because tests pass.

Claims must describe concrete properties verified.

## Business priority

IWA should first become a trustworthy savings and verification product.

Hackathons, grants, and ecosystem integrations should reuse the same IWA Core rather than forcing complete product rewrites.

The long-term product is more important than any single chain or hackathon.

## STRK20 sprint priorities

Priority order:

1. deep STRK20 integration
2. working Starknet Mainnet product
3. strong security and audit evidence
4. clear private savings use case
5. Portable Trust Credential
6. admin and operational credibility
7. business/revenue story
8. presentation polish

If time becomes constrained:

STRK20 integration, mainnet correctness, and security take priority over optional features and decorative polish.

## Non-goals for the first Starknet release

Do not build these prematurely:

- arbitrary tokens
- every chain at once
- giant enterprise backend
- custodial accounts
- unrestricted admin privileges
- universal credit scoring
- complex lending marketplace
- unnecessary second ZK system
- cross-chain bridge infrastructure
- production-grade fiat/mobile-money integration

Keep clean interfaces for future additions.

## Product identity

Lead brand phrase:

**Your good name, proven and private.**

Lead credential term:

**Portable Trust Credential**

Avoid:

- credit score
- public financial profile
- surveillance-style reputation scoring

IWA should feel human, calm, trustworthy, private, and useful.
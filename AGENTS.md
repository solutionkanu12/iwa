# IWA — Agent Instructions

## Purpose

This file defines the operating rules for every coding agent working on IWA.

These rules apply to:

- Claude Code
- Codex
- OpenCode
- any other coding agent or subagent

If an agent-specific file exists, this file remains the shared source of truth unless an explicit project decision says otherwise.

## Read before coding

Before making changes, read:

1. `PROJECT.md`
2. `STATUS.md`
3. `ARCHITECTURE.md`
4. `DESIGN.md`
5. `SECURITY.md`
6. this file

For STRK20 work, also read the installed relevant STRK20 skill and its bundled references before implementation.

Never implement STRK20 behavior from memory.

## Current project status

IWA is an existing working product being migrated from a Stellar/Soroban implementation to a Starknet/STRK20 implementation.

This is not a greenfield redesign.

The existing frontend already works and must be preserved unless a specific visual change is explicitly approved.

## Core product rule

IWA is private community savings and portable financial trust infrastructure.

The saver is the primary user.

Do not transform IWA into:

- a generic DeFi dashboard
- a lender-first product
- a protocol console
- a credit-score product
- a generic hackathon template

## Frontend preservation rule

Do not redesign `iwa-web/`.

Preserve:

- current colors
- layouts
- spacing
- typography
- visual identity
- cowrie branding
- interactions
- animations
- responsive behavior
- page structure

Frontend changes during migration should focus on:

- removing Stellar/Soroban coupling
- adding Starknet/STRK20 integration
- replacing obsolete chain-specific copy
- correcting technically inaccurate text
- professionalizing copy where useful

Large unexplained visual diffs are a warning sign.

If unsure whether to redesign something:

**do not redesign it.**

## Chain architecture rule

IWA Core must remain chain-neutral.

Do not place Starknet-specific types, RPC logic, wallet logic or STRK20 internals inside the core domain layer.

Use:

```text
IWA Core
→ Chain Interface
→ Starknet Adapter
→ Cairo / STRK20
```

Future chains should be able to implement the same domain interface natively.

## Current chain target

Current implementation target:

- Starknet Mainnet
- Cairo
- STRK20
- USDC
- STRK

Starknet is the first native chain implementation, not the permanent canonical chain for IWA.

## STRK20 rule

Installed STRK20 skills include:

- `strk20-privacy`
- `strk20-wallet-api`
- `strk20-anonymizer-contracts`
- `strk20-privacy-sdk`

Before any STRK20 implementation:

1. open the relevant skill
2. read its references
3. verify current protocol behavior
4. verify current mainnet addresses
5. verify required ordering and authorization rules
6. then implement

Do not guess protocol behavior.

## Legacy code rule

Do not delete legacy code until its replacement is verified.

Current important legacy areas:

- `iwa-savings/`
- `iwa-circuit/`
- `iwa-prover/`
- `iwa-verifier/`
- `toolchain-test/`

`iwa-savings/` contains useful business behavior and tests.

Extract important:

- state transitions
- payout rules
- contribution rules
- edge cases
- invariants

before removing the Soroban implementation.

`iwa-circuit/` and `iwa-prover/` must remain until STRK20 research determines whether a separate ZK credential system is still required.

## Do not mechanically port

Do not perform blind translations such as:

```text
Soroban → Cairo
```

or:

```text
old verifier → new verifier
```

Understand the business requirement first, then implement the smallest correct native architecture.

## Circle rules

Current locked behavior:

- private/invite-based circles first
- payout rotation fixed before contributions begin
- payout order immutable once active
- grace window for missed contribution
- reliability states:
  - `ON_TIME`
  - `LATE_WITHIN_GRACE`
  - `MISSED_DEFAULT`
- unresolved deficit may lock scheduled payout
- fallback must be deterministic
- admin cannot choose recipients arbitrarily
- completed financial history is immutable

Do not silently change these rules.

## Admin model

Admin is operational, not custodial.

Allowed areas may include:

- public platform metrics
- contract health
- transaction health
- operational alerts
- support tooling
- audit logs
- verification usage
- revenue/subscription metrics
- narrowly scoped maintenance controls
- narrow emergency pause

Admin must never be able to:

- seize user funds
- move user funds
- redirect payouts
- change locked payout order
- erase defaults
- rewrite contribution history
- forge credentials
- reveal viewing keys
- expose private financial activity

## Emergency pause

Pause must be narrow.

Preferred targets:

- new joins
- new contributions
- newly initiated risky actions where needed

Do not create a powerful global admin freeze unless a separately approved security design requires it.

Safe user recovery paths should remain available where technically possible.

## Backend/indexer boundary

A small chain-neutral backend/indexer is allowed.

Allowed responsibilities include:

- public event indexing
- notifications
- public metadata
- analytics
- contract health
- admin reporting
- verification usage
- business metrics

It must not store:

- wallet private keys
- wallet seeds
- viewing keys
- signing secrets
- private contribution graph
- raw private financial history
- raw credential evidence

Contracts remain authoritative for financial protocol state.

## Revenue model

Preserve these current business rails:

1. B2B credential verification
2. IWA Pro circles
3. enterprise / white-label infrastructure
4. optional protocol / partner revenue

Core principle:

**IWA monetizes verification and infrastructure, not private financial data.**

## Portable Trust Credential

Do not create a universal numerical credit score.

Credentials should expose scoped claims only.

Example:

> completed at least 3 savings cycles with no defaults

The verifier should not automatically receive raw savings history.

Use STRK20-native privacy/disclosure capabilities first.

Only add a separate proof system if it provides a required capability STRK20 cannot provide cleanly.

## Security requirements

`SECURITY.md` is mandatory reading for security-critical work.

General rules:

- fail closed
- validate caller
- validate network
- validate token
- validate contract addresses
- prevent replay
- prevent duplicate contribution
- prevent duplicate payout
- preserve payout-order immutability
- preserve historical immutability
- minimize external calls
- never add arbitrary-call functionality without separate approval
- use least privilege
- test invariants
- review privacy leakage

Never claim something is secure without concrete verification.

## Secrets

Never print, commit or expose:

- private keys
- wallet seeds
- API keys
- database passwords
- auth secrets
- viewing keys
- deployment signing material

Before committing:

```bash
git diff --cached
```

Review the entire staged diff.

If a secret is exposed, treat it as compromised.

## Environment files

Do not commit real `.env` files.

Use sanitized `.env.example` files where necessary.

## Testing workflow

For implementation work, prefer:

1. identify required behavior/invariant
2. write or identify failing test
3. run and confirm failure
4. implement minimal change
5. rerun focused test
6. run related regression tests
7. review diff
8. run security-specific checks where relevant
9. commit only verified work

Do not skip verification just to move faster.

## Commit policy

Commits should be:

- focused
- reviewable
- limited to one meaningful change
- free of unrelated formatting churn
- free of agent branding

Do not add:

- “Generated by Claude”
- “Co-authored-by: Claude”
- “Co-authored-by: Codex”
- agent logos
- bot attribution

The repository should reflect the project owner/team as authors, not the coding agent.

Review identity/config before commits where needed.

## Push policy

Before push:

- inspect `git status`
- inspect staged diff
- verify tests
- verify no secrets
- verify no unrelated files
- verify documentation status if the phase changed

Do not push broken work merely to preserve progress.

## STATUS.md rule

`STATUS.md` is the live project handoff.

After every meaningful phase or major verified change, update it with:

- current phase
- what changed
- what passed
- what failed
- current blockers
- deployment/address state
- exact next step

Do not let `STATUS.md` drift far behind the repository.

## Documentation rule

When architecture intentionally changes:

- update `ARCHITECTURE.md`

When product/business scope changes:

- update `PROJECT.md`

When visual rules change:

- update `DESIGN.md`

When security assumptions/invariants change:

- update `SECURITY.md`

Do not silently change implementation direction without updating the relevant source-of-truth document.

## No hallucination rule

Never state that something:

- passed
- deployed
- works
- is mainnet verified
- is secure
- was audited
- is supported by STRK20
- is present in the repository

unless it has actually been verified.

Distinguish clearly between:

- verified
- observed
- planned
- assumed
- blocked

If uncertain, inspect the source instead of guessing.

## Scope rule

Prefer the smallest implementation that satisfies the approved architecture.

Do not add speculative features during security-critical phases.

When time is constrained, priority is:

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

## Current implementation order

Follow the approved sequence:

### Phase 0
Preservation and control.

### Phase 1
STRK20 protocol research.

### Phase 2
Chain-neutral IWA Core.

### Phase 3
Cairo circle implementation.

### Phase 4
STRK20 helper/private integration.

### Phase 5
Starknet frontend adapter.

### Phase 6
Backend/indexer + admin MVP.

### Phase 7
Portable Trust Credential.

### Phase 8
Full security review.

### Phase 9
Mainnet verification/deployment.

### Phase 10
Demo/submission polish.

Do not jump to a later phase merely because it looks more interesting.

## Final operating rule

When unsure:

1. read the project docs
2. inspect the actual repository
3. inspect the relevant protocol documentation
4. preserve existing working behavior
5. choose the smallest secure change
6. verify it
7. document the result

Do not improvise architecture from memory.
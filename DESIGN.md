# IWA — Design

## Design status

The existing IWA frontend and UI/UX are already established and working.

The current rebuild is **not a frontend redesign**.

The objective is to preserve the existing IWA experience while replacing obsolete Stellar-specific product and technical references with the new multichain architecture and current Starknet/STRK20 implementation.

## Primary design rule

**Preserve the existing IWA frontend unless a specific change is deliberately approved.**

Do not redesign the application merely because the blockchain implementation is changing.

A chain migration is not permission to replace the product identity.

## What must remain

Unless explicitly approved later, preserve:

- existing color palette
- existing layout system
- existing page structures
- existing spacing
- existing typography
- existing visual hierarchy
- existing cards
- existing buttons
- existing brand identity
- existing cowrie visual language
- existing illustrations/assets
- existing animations
- existing transitions
- existing responsive behavior
- existing mobile-first behavior
- existing interaction patterns
- existing navigation structure
- existing credential presentation
- existing circle experience
- existing overall visual character

Do not replace working UI with a generic new dashboard or hackathon template.

## Migration scope

Frontend changes during the Starknet migration should primarily affect:

- blockchain integration
- wallet integration
- transaction handling
- chain-specific links
- chain-specific status information
- network names
- token handling
- outdated Stellar copy
- obsolete Soroban terminology
- technically inaccurate product text

The goal is:

```text
Existing IWA Product
        +
new Starknet / STRK20 implementation
        +
professionalized chain-neutral copy
```

not:

```text
new blockchain
        =
new visual product
```

## Visual identity

The established IWA palette remains authoritative.

Known design colors include:

```text
Mist        #F6F4FC
Cloud       #FBFAFE
Ink         #2A2140
Ink Black   #1B1430
Muted       #5B5478
Lavender    #B6A6F2
Iris        #6D4DF2
Iris Dark   #5D3EEA
Mint        #4FD9C0
Mint Dark   #0F6E56
Border      #E7E3F6
```

Do not replace these simply to make the Starknet version look different.

## Typography

Preserve the existing typography system where it is already implemented correctly.

Existing design direction includes:

- Bricolage Grotesque
- Inter
- Space Mono

Do not introduce new font families during the chain migration without a deliberate design reason.

## Brand identity

The cowrie-based identity remains part of IWA.

Do not replace it with:

- Starknet branding
- generic blockchain imagery
- cyberpunk imagery
- futuristic protocol graphics
- random shield/lock icons as the main brand
- new hackathon-specific branding

Starknet and STRK20 are infrastructure powering IWA.

They are not the IWA brand.

## Product positioning

Lead product phrase:

**Your good name, proven and private.**

Primary credential terminology:

**Portable Trust Credential**

Supporting language may include:

- Private Proof of Reliability
- Private Financial Reputation
- Verifiable Savings Reputation

Avoid presenting IWA primarily as a:

- credit score
- lending dashboard
- crypto wallet
- DeFi dashboard
- blockchain protocol console

The product is about private community savings and portable reliability.

## Existing UX hierarchy

The saver remains the primary user.

The product should continue feeling like an approachable savings product rather than a technical blockchain application.

The blockchain should disappear behind the user experience wherever possible.

Users should think in terms of:

- circles
- contributions
- payout turns
- savings
- reliability
- credentials

not:

- calldata
- class hashes
- RPCs
- proof internals
- contract storage
- note commitments

Technical details may be shown where useful, but they are secondary.

## Chain-neutral copy

Where existing UI says or implies:

- Stellar
- Soroban
- Stellar testnet
- Stellar wallet
- Stellar transaction
- Stellar explorer
- Stellar-specific proving architecture

replace it only where necessary.

Prefer chain-neutral product copy in normal user flows.

Examples:

Instead of:

> Pay privately on Stellar

prefer:

> Contribute privately

Instead of:

> Connect Stellar wallet

prefer:

> Connect wallet

where no chain distinction is necessary.

Instead of:

> Stellar transaction confirmed

prefer:

> Contribution confirmed

Technical details can still identify Starknet in transaction detail surfaces.

## Starknet visibility

Starknet and STRK20 should be visible where they provide useful confidence or technical context.

Appropriate locations include:

- wallet connection
- network indicator
- transaction details
- privacy explanation
- proof/details surfaces
- developer/about documentation
- demo/submission material

They should not dominate every product screen.

## Asset terminology

The initial Starknet version supports:

- USDC
- STRK

Use their actual asset names where relevant.

Do not hard-code copy implying those are the only assets IWA can ever support.

For example:

Prefer:

> Choose contribution asset

with USDC and STRK available.

Avoid:

> IWA is a USDC savings app

unless describing a specific circle.

## Privacy UX

Privacy must be understandable without forcing users to understand ZK cryptography.

Good language:

- private contribution
- private payout
- protected savings activity
- share only what you choose
- prove reliability without sharing your history

Avoid relying on technical jargon such as:

- zero-knowledge circuit
- commitments
- nullifiers
- encrypted note graph
- proof witness

unless the user deliberately opens technical details.

## Portable Trust Credential UX

The credential should remain an important visual moment.

It should communicate:

- what is being proven
- whether it is valid
- who controls disclosure
- what is not being shared

Example:

```text
Portable Trust Credential

Completed at least 3 savings cycles
No defaults

Verified

Your contribution amounts, circle members,
balances and savings history remain private.
```

The presentation should remain human and trustworthy rather than looking like an analytics scorecard.

## Admin dashboard design

The admin dashboard is an extension of the IWA visual system.

It must not become a completely different cyber/enterprise product.

Use the same:

- color family
- typography
- spacing language
- card system
- interaction quality
- visual restraint

The dashboard can be more information-dense than the saver experience, but it should still visibly belong to IWA.

Possible admin surfaces include:

- platform overview
- contract health
- circle activity
- transaction health
- operational alerts
- audit logs
- credential-verification usage
- revenue metrics
- subscription metrics

Private financial information must not be surfaced merely because the user is an admin.

## Existing static pages

Existing pages such as:

- landing page
- litepaper
- roadmap
- application screens

should be adapted rather than recreated when possible.

Review copy for obsolete Stellar-specific claims.

Preserve the visual implementation unless there is a concrete problem.

## Professionalization pass

The migration may include a controlled copy-quality pass.

Improve:

- grammar
- clarity
- confidence
- consistency
- terminology
- technical accuracy
- product maturity

Do not change the underlying personality of IWA.

Avoid exaggerated claims such as:

- perfectly private
- completely anonymous
- unhackable
- bank-grade security
- guaranteed trust

Security and privacy claims must match verified behavior.

## Existing design constraints

Continue respecting established IWA preferences.

Avoid:

- gradient text
- emojis in core product UI
- excessive exclamation marks
- pure-white visual overload
- unnecessary scaling hover effects
- generic three-column feature grids
- generic AI-generated SaaS layouts
- overly technical Web3 aesthetics
- noisy blockchain visuals
- unnecessary redesigns

## Responsive behavior

The current mobile-first approach remains.

Any chain integration added to the frontend must work within the existing responsive system.

Do not fix blockchain integration by introducing desktop-only UX.

Wallet flows, contribution flows and credential sharing must remain usable on narrow screens.

## Frontend migration rule

When modifying `iwa-web/`:

1. identify exactly what is Stellar-specific
2. modify only the required integration/copy surface
3. preserve surrounding component behavior
4. run the existing frontend
5. compare with the previous version
6. verify no unintended visual regressions
7. only then accept the change

Large visual diffs during a chain-integration task should be treated as suspicious.

## Visual regression principle

The desired migration outcome should look recognizably like the IWA that existed before the migration.

A user familiar with IWA should think:

> IWA now works with this new private infrastructure.

not:

> They replaced IWA with another website.

## Final polish phase

Minor design changes may be considered near the final build phase.

These are optional and require deliberate approval.

Potential examples:

- remove a disliked element
- adjust specific copy
- refine a weak component
- fix inconsistent spacing
- improve a particular interaction
- improve responsiveness
- clean up an outdated visual detail

The existence of a final polish phase does not authorize a general redesign.

If no specific visual changes are approved, the existing design remains.

## Design source of truth

Until intentionally changed, the existing working `iwa-web/` implementation is the strongest source of truth for the visual product.

This document defines the preservation rules around it.

When an agent is uncertain whether to redesign something:

**Do not redesign it. Preserve the existing behavior and ask only if a real decision is required.**
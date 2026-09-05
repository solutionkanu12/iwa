# IWA — Decisions

Recorded decisions for the Zama Prize Savings bounty track
(branch `feature/zama-prize-savings`). These are decisions, not status; status
lives in `STATUS.md` and the live handoff in `handoff.md`.

## Zama bounty decisions

- **Accept ERC-7984 all-or-nothing shortfall behavior for the bounty MVP.**
  With pinned `@openzeppelin/confidential-contracts` 0.5.3, a confidential
  transfer moves either the full requested amount or 0 (`FHE.select(balance >=
  amount, amount, 0)`). This deviates from spec §2's "min(amount, balance)"
  claim, which was inaccurate for the pinned package. Accepted because the
  security invariant (credit only the actual returned amount) is preserved and
  a shortfall simply transfers and credits 0.
- **Do not implement a bespoke partial-pull confidential token.** No custom
  ERC-7984 subclass, no rewritten `_update`, no min-clamping workaround.
- **After a 0-transfer shortfall, the user retries with a valid amount.** The
  pool never invents credit from the requested amount.
- **Keep the `@fhevm/solidity` 0.11.1 toolchain for this bounty.**
  `@openzeppelin/confidential-contracts` 0.5.3 peers exactly on 0.11.1, so no
  Zama package upgrade is required or allowed.
- **Participant registration: once per wallet, on first deposit request**
  (spec §6.6, option B). A wallet occupies at most one slot regardless of how
  many zero-transfer attempts it makes; the cap is enforced in plaintext
  (`participants.length < MAX_PARTICIPANTS`); zero-weight participants are
  harmless to the draw (S2-verified: a zero-weight participant can never be
  selected). Registration on positive actual transfer is impossible without
  branching on encrypted data or publicly decrypting the amount, both rejected.
- **The standalone Zama app remains isolated from the main Iwa frontend.**
  No `iwa-web` integration; minimal dapp lives inside `zama-prize-savings/`.
- **Ethereum Sepolia is the bounty deployment target.** Testnet only, dedicated
  key, never production material.
- **Over-withdrawal clamps with `FHE.min` (spec §10), never underflows.**
  Requesting more than the credited balance sends exactly the balance; the
  withdrawal of an emptied balance is a no-op.
- **`MAX_POOL_TOTAL = 1024` (2^10).** The spec pins "plaintext power of two"
  but no number; 1024 is the S2-measured bound used throughout the spike
  track. Immutable per deployment, tunable before P7 deployment. Participant
  deposit weight is clamped to it; the prize reserve is exempt from it.
- **Prize funding authority: owner-only, while Open.** Per plan P2 ("only
  owner funds"; "funding after Locked reverts"). The owner gains exactly one
  power - funding - and can never recover, sweep, redirect, or reduce the
  funded prize, and cannot decrypt the reserve.
- **The prize reserve is excluded from participant draw weight.**
  `confidentialTotal` (draw weight) and `prizeReserve` are separate encrypted
  values that are never merged; funding consumes no headroom.
- **`DRAW_TIMEOUT` is UNPINNED - blocking P3.** The approved spec (§7.6, C6)
  and plan name `lockTimestamp + DRAW_TIMEOUT` but never assign a number. The
  P3 task instruction requires the value from the approved docs or a stop.
  Decision needed from the reviewer: exact `DRAW_TIMEOUT` in seconds. Context
  for the choice: the bounty demo is ~3 minutes and the deadline is
  2026-09-05 23:59 AOE; the timeout must be long enough that the owner's
  timely-draw window is real and short enough that a silent owner cannot
  strand the prize for the demo.
- **`DRAW_TIMEOUT = 900` seconds (15 minutes), APPROVED 2026-09-05.** Sepolia
  bounty-MVP value only, NOT a permanent production policy:
  - the owner may draw immediately after `lockRound()`
  - at `lockTimestamp + 900` draw becomes permissionless (anti-stranding, C6)
  - rationale: long enough for a real owner window, short enough for the
    judging/demo window and for a silent owner not to strand a funded prize
  - MUST be reviewed before any production deployment
- **Winner index is `euint16`, encrypted.** `NO_WINNER` sentinel = 65535
  (`type(uint16).max`), which can never collide with valid indices 0-15.
- **The draw ticket stays confidential for the bounty MVP.** No
  `makePubliclyDecryptable`, no public ticket disclosure (C4: never publish
  both ticket and winner identity).
- **Claim accounting rule (option A):** when a winner claims, `confidentialTotal`
  increases by exactly the encrypted payout, so `total == sum(credited)` is
  preserved at every step (consistent with spec §10's withdraw, which debits
  the total by the actual transfer unconditionally - the only self-consistent
  bookkeeping once prize money flows through balances). Claim is only
  reachable after `Drawn`, so a prize credit can never retroactively affect
  the completed draw. Consequence, documented: after claims the total may
  exceed `MAX_POOL_TOTAL` (prize credits are not principal); the cap's purpose
  - bounded draw randomness - is already discharged post-draw.
- **Claim state-transition decision:** `claim()` runs in `Drawn` or
  `Claimable`; the FIRST claim performs the one-time `Drawn -> Claimable`
  transition. The spec §9 requires claim in `Claimable`, `draw()` ends in
  `Drawn` (P3), the spec lists no separate transition function, and the demo
  (§15) calls claim() directly after draw.
- **NO_WINNER rollover claim behavior:** in a NO_WINNER round every claim
  credits encrypted zero, consumes the caller's per-user claim, and leaves
  the prize reserve fully intact for rollover/future rounds.
- **F1 zero-transfer slot DoS: ACCEPTED FOR THE ZAMA SEPOLIA BOUNTY MVP ONLY
  (approved 2026-09-05).** The 16-wallet zero-transfer attack permanently
  fills the participant cap. Accepted because: no fund theft, no insolvency,
  no winner manipulation, existing participants remain functional, and the
  exploit requires 16 distinct wallets plus multiple transactions; the safe
  mitigations all require an architecture change that is out of scope for the
  bounty deadline. **This issue BLOCKS any production/mainnet deployment.**
  Before production, participant admission must be redesigned so zero-transfer
  wallets cannot permanently consume draw slots without requiring decryption
  of confidential amounts. Future mitigations to research:
  - explicit participant registration with a small economic stake
  - invite/allowlist-based pool membership
  - replaceable/expiring participant slots
  - a confidential membership proof that proves positive participation
    without exposing the balance
- **Iwa Prize Savings is ONE IWA PRODUCT (2026-09-05).** No standalone Zama
  dapp and no separate brand: the feature lives at `/app/prize-savings`
  inside the existing Iwa app, using the AppShell, the Iwa lavender design
  system, and Iwa navigation (sidebar + account control; kept off the 4-tab
  phone bar per the existing mobile rule). Zama is acknowledged only as the
  confidentiality layer in subtle technical copy.
- **Frontend Ethereum seam is separate from the Starknet wallet.** The Iwa
  Prize Savings feature uses its own EIP-1193 (window.ethereum) connection on
  Ethereum Sepolia; it never touches the Starknet session used by circles.
- **Testnet demo wallets must be freshly generated.** Publicly-known test
  mnemonic addresses are swept/drained on public testnets (observed on
  Sepolia); the demo must never use published test keys.

## Legacy / Starknet track decisions

See the historical sections of `ARCHITECTURE.md`, `SECURITY.md` and the
STRK20 design docs. Nothing in this file overrides the Starknet track.

Zama bounty MVP DRAW_TIMEOUT = 900 seconds (15 minutes).

Reason:
The owner may draw immediately after lock. If the owner does not act, draw becomes permissionless after 15 minutes to prevent prize stranding.

This value is specific to the Sepolia bounty MVP and must be reviewed before any production deployment.
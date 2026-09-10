# IWA — Decisions

Recorded product and architecture decisions. These are decisions, not status;
status lives in `STATUS.md` and the live handoff in `handoff.md`.

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

## Iwa multichain wallet manager (2026-09-05)

- **One Iwa-level wallet manager, two independent slots.** A single wallet
  manager (`lib/evmWallet.ts` + `app/WalletProvider.tsx`) owns the Starknet
  connection and the EVM connection side by side. Connecting or disconnecting
  one never touches the other; each slot keeps its own address, chain and
  state.
- **No forced dual connection.** The Connect to Iwa chooser offers Starknet
  and EVM as separate choices. A visitor may connect either, both, or neither;
  nothing requires both wallets to be connected at once.
- **Feature-specific chain gating.** Savings circles and standing need the
  Starknet wallet; Prize Savings needs the EVM wallet. The gate for Prize
  Savings asks for the EVM wallet without disturbing a connected Starknet
  wallet, and an EVM wallet on the wrong network is told exactly which action
  fixes it (switch to Sepolia).
- **Connection does not authorize transactions.** The wallet manager only
  tracks which wallet is connected. Every money-moving action still requires
  its own explicit signature/authorization from the connected wallet; a
  connection is never an authorization.
- **Prize Savings uses EVM; circles/standing use Starknet.** The chain a
  feature runs on is the chain its gate asks for. An EVM-only user can use
  Prize Savings without ever connecting Starknet, and Starknet-only features
  ask for the Starknet wallet only when they are used.
- **EVM connection is reused, not re-prompted.** `eth_requestAccounts` is
  called only by the explicit connect/switch actions in the Ethereum adapter;
  ordinary Prize Savings actions reuse the connection already held, and
  `accountsChanged`/`chainChanged` events keep the shared slot current.
- **Extension events do not auto-connect.** A disconnected EVM slot stays
  disconnected until the visitor asks Iwa to connect it. Wallet events may
  update or drop an already-connected slot; they may not create one.

## Legacy / Starknet track decisions

See the historical sections of `ARCHITECTURE.md`, `SECURITY.md` and the
STRK20 design docs. Nothing in this file overrides the Starknet track.

## Iwa V2 decisions (2026-09-07, updated 2026-09-10)

- **Private Starknet payout is a hard invariant.** A public ERC20 transfer from
  the helper to the member, including one followed by optional re-shielding, is
  rejected as the V2 payout or recovery design.
- **Architectural rule (2026-09-10).** One Iwa protocol, multiple chain
  implementations. Chain-specific privacy and settlement primitives must never
  leak into the core domain. The Portable Trust Credential and private pot
  collection are defined at the protocol level; the Starknet implementation
  (Cairo + STRK20 + Ready X, via a Starknet adapter) and future EVM / Solana
  implementations satisfy the same spec behind their own payment/privacy
  adapters. No cross-chain fund bridge is required for the first multichain
  phase.
- **Shadow-account path SUPERSEDED / infrastructure-blocked (2026-09-10,
  blocker V2-02).** Iwa's installed Wallet API types are `0.10.3` and expose no
  shadow-account methods; no shipping browser wallet provides them on the target
  network; there is no verified anonymizer deployment / governance. The route is
  abandoned. Its RED tests are kept for security history and ignored/skipped in
  CI (`test_private_destination_capability_v2.cairo` all `#[ignore]`;
  `privateDestinationCapability.test.ts` six `it.skip`).
- **Candidate P is the selected V2 private-payout path (2026-09-10).** The
  scheduled member pre-registers a private destination note (amount from circle
  state, destination bound by a member-auth-key signature, monotonic destination
  epoch) before the STRK20 transaction is assembled; the V2 helper settles the
  state-derived transfer into that note. No inline settlement signature, no
  caller-supplied amount, no admin path, no assembly-time open-note ID to sign.
  Production security matrix: `test_payout_settlement_v2.cairo`; real-pool
  capability proof: `test_precommitted_note_payout_v2.cairo`.
- **A1 confirmed (2026-09-10).** Ready X supports `wallet_addDeclareTransaction`
  on Starknet mainnet — verified by a real request reaching the approval prompt.
  The V2 mainnet declare/deploy will be done from the Ready X wallet (the
  standard `sncast` deployer is blocked by an Argent guardian). No tx sent.
- **V2 implementation status (2026-09-10).** V2 contracts (A2), the Cairo
  security matrix (A3), the frontend payout path, and the Portable Trust
  Credential are all implemented and tested. Not committed, not pushed, not
  deployed. Pending: the declare/deploy, a real minimal-value mainnet proof,
  rotation / private recovery hardening, external audit.
- **Iwa Core is chain-neutral.** Core concepts are Circle, Member,
  Contribution, Obligation, Payout, Standing, Credential, and Identity.
  Implementations use `ChainAdapter`, `PaymentAdapter`, `PrivacyAdapter`, and
  `CredentialVerifier` boundaries.
- **Recovery stays member controlled and private.** Auth and destination epochs
  are monotonic; only member identity proof rotates them; a fallback destination
  is privately committed by the member and time locked; fresh member
  authorization resets the timer. No organizer or admin recovery exists.
- **Credentials remain owner bound.** Good Standing never launders a cured
  `MissedDefault`. Circle Completion requires terminal accounting, membership in
  the payout order, and the member's own verified successful private payout
  (`PrivatelyPaid`) or private recovery (`PrivatelyRecovered`); `Scheduled`,
  authorized, pending, public-payout, and `NoFundedRecovery` states never
  qualify. Artifact integrity **and** a fresh, versioned, verifier-bound
  proof-of-possession are both required; a copied JSON artifact is never
  sufficient. Verification is fail-closed (Verified / Invalid / Unable to
  verify); "Unable to verify" is never treated as valid. Good Standing must not
  reveal raw contributions, balances, the member graph, the payout amount,
  viewing keys, or full financial history.
- **V1 and V2 remain separate.** Resource identity is `(contract address,
  circle id)`, indexed models carry `protocol_version`, the config-pinned
  registry is primary, and there is no migration, bridge, or V1 rewrite.
- **Future chains use adapters.** Zama Prize Savings is a current EVM product
  implementation. Celo, Nimiq, Base, and other integrations remain planned,
  not shipped.

Zama bounty MVP DRAW_TIMEOUT = 900 seconds (15 minutes).

Reason:
The owner may draw immediately after lock. If the owner does not act, draw becomes permissionless after 15 minutes to prevent prize stranding.

This value is specific to the Sepolia bounty MVP and must be reviewed before any production deployment.

# IWA — Status

What works today, what does not, and where the line between them sits. Written
against verified behaviour: contract reads, deployed code and passing tests, not
intent.

Last reviewed against the working tree during the reconnect work.

## Zama Prize Savings bounty (active work)

Branch `feature/zama-prize-savings`. Standalone spike-to-bounty track inside
`zama-prize-savings/`; nothing in it touches the Starknet track or `iwa-web`.

- S1 toolchain/round-trip spike: LOCAL PASS (Sepolia pending credentials)
- S2 weighted-draw GO/NO-GO spike: LOCAL PASS. `MAX_PARTICIPANTS = 16`
  (measured N=16: global 8.62M < 20M HCU, depth 2.82M < 5M HCU)
- S3 ERC-7984 wrapper + actual-returned accounting spike: LOCAL PASS
  (13 tests; pinned `@openzeppelin/confidential-contracts` 0.5.3,
  peer-compatible with `@fhevm/solidity` 0.11.1)
- P1 pool core (`IwaPrizeSavings`): LOCAL PASS (14 deposit + 8 withdraw tests)
  - state machine `Open/Locked/Drawn/Claimable` (Open + locking implemented)
  - confidential deposit crediting only the actual returned transfer
  - requested withdraw with `FHE.min` clamping and `withdrawAll()` liveness hatch
  - participant cap 16, once-per-wallet registration, anti-grief verified
  - no sweep/rescue ABI, no plaintext amounts, no draw/claim code
- P2 prize funding + pool cap: LOCAL PASS (13 prize + 5 cap tests)
  - `fundPrize` owner-only while Open, crediting only the actual returned amount
  - prize reserve encrypted, irrevocable, separate from participant draw weight
  - `MAX_POOL_TOTAL = 1024` (2^10, S2-measured bound); deposit headroom clamp
    via encrypted `FHE.min` - no plaintext branch, no decryption
  - solvency: sum(credited) + prizeReserve == pool token holdings at every step
- **Unresolved release risk (carried, do not redesign in this bounty):** 16
  distinct zero-transfer wallets can still consume all participant slots. Each
  wallet is capped at one slot, and zero-weight participants cannot be
  selected in the draw, but a testnet attacker with 16 wallets can fill the
  pool. Accepted for the bounty MVP; a real fix (e.g. registration fee or
  plaintext stake) is out of scope.
- **P3 (draw): BLOCKED - DRAW_TIMEOUT is not pinned.** The approved spec and
  plan reference `lockTimestamp + DRAW_TIMEOUT` (C6) by name only and never
  assign a number. Per the P3 task instruction, the value must come from the
  approved docs or P3 stops. The reviewer must pin an exact
  `DRAW_TIMEOUT` (seconds, plaintext constant) before P3 can proceed. All
  other P3 inputs (S2-proven walk, euint16 winner, NO_WINNER sentinel 65535,
  confidential ticket, N=16 bound) are ready.
- P3 draw: LOCAL PASS (25 tests). DRAW_TIMEOUT = 900s approved 2026-09-05.
  - `draw()`: owner immediately after lock; permissionless at
    `lockTimestamp + 900` (C6 anti-stranding); once per round
  - S2-proven encrypted weighted walk over LIVE balances; `euint16` winner
    index; NO_WINNER sentinel 65535; rollover on `ticket >= total`
  - ticket and winner stay confidential (no public decryption); prize reserve
    and all balances untouched by the draw
  - production N=16 measured: global 8.62M HCU < 20M, depth 2.82M < 5M,
    gas 1.33M (FHE cost identical to S2's N=16 measurement)
- P4 claim: LOCAL PASS (25 tests)
  - `claim()`: pull action, Drawn/Claimable, first claim performs the one-time
    Drawn -> Claimable transition (spec requires claim in Claimable and lists
    no separate transition function)
  - `FHE.eq` scalar winner check, `FHE.select` payout credit - non-winners
    credit encrypted zero, never revert, never distinguished
  - per-user `hasClaimed` replay protection; winner identity never revealed
  - accounting option A (decision.md): `confidentialTotal` increases by the
    payout so `total == sum(credited)` always; post-draw changes cannot
    retroactively affect the completed draw
  - winner withdraws the prize later through the normal confidential
    withdrawal; solvency holds before/after claims; NO_WINNER rounds credit
    zero and leave the reserve fully intact
- P5 full lifecycle: LOCAL PASS (4 tests, NO production changes - the P1-P4
  contract already supports the complete flow)
  - winner cycle: Alice 60 / Bob 40 / prize 20, every step its own
    transaction; Alice wins, claims 20, withdraws principal+prize; Bob claims
    zero, withdraws principal; final holdings 0 == liabilities 0; no user
    loses principal
  - rollover cycle: ticket >= total -> NO_WINNER, zero claims, reserve 20
    rolls over fully backed (liabilities 0, holdings 20)
  - solvency asserted at every checkpoint; claim replay enforced; full-cycle
    logs leak no amounts, balances, winner or payout
- P6 red team: 29 adversarial tests, all GREEN - **BUT the release gate is
  BLOCKED by one HIGH finding** (see below and SECURITY.md findings table).
  All accounting/solvency, claim, draw, ACL/privacy, authority, ERC-7984 and
  state-machine attacks were repelled; no new bugs found in the contract.
- **RELEASE BLOCKER - HIGH: zero-transfer slot DoS.** 16 distinct wallets can
  permanently fill the participant cap with zero-value deposit attempts
  (each wallet one slot, but 16 wallets fill the pool for free). Real users
  can never join that deployment; no removal function and no owner recovery
  exist. Funds, the draw and existing participants are unaffected. No small
  safe mitigation exists within the approved architecture (detecting a
  positive encrypted transfer would require an ebool branch or public
  decryption; a registration stake would be an architecture change).
  **DECISION (approved 2026-09-05): ACCEPTED FOR THE SEPOLIA BOUNTY MVP ONLY.
  BLOCKS ANY PRODUCTION/MAINNET DEPLOYMENT.** Before production, participant
  admission must be redesigned (registration stake / allowlist / expiring
  slots / confidential positive-participation proof - see decision.md).
- **P7 REAL SEPOLIA VERIFICATION: PASS (all 8 items, real network).**
  - S1 encrypted round-trip incl. cross-tx ACL and wallet-B rejection: PASS
  - ERC-7984 operator path + allowTransient handoff (deposit 40 then 20): PASS
  - wrong-contract input binding: REJECTED by the real verifier (InvalidSigner)
  - wrong-sender input binding: REJECTED (InvalidSigner)
  - no-prize claim: credits zero, full exit works - no stuck state
  - real Sepolia logs: no plaintext amounts/balances/prize/winner
  - F2 first-funding ACL: confirmed on the real ACL - funder sees only their
    own first funding; a rewritten reserve handle removes access
  - N=16 production draw on Sepolia: PASS, gas 1,705,385; real HCU measured
    identical to local (global 8,616,576 < 20M, depth 2,818,032 < 5M)
  - real-network deviation noted: publicly-known test-mnemonic addresses get
    drained/swept on public testnets - random fresh wallets used instead
- **P7 DEPLOYMENT (official, Sepolia):** MockUSD, CMockUSD, IwaPrizeSavings
  deployed and recorded in `zama-prize-savings/deployments/sepolia.json`.
  Pool: 0x2d1b97F7e1E4845260aBd23017686fBa38006037; wrapper
  0xB87CE72B9083488977372507efD4127e157510c2; MockUSD
  0x0041A7b8Bb29cA5D6b1Cb6eFBcaBAc8519075392. Constants verified on chain
  (MAX_PARTICIPANTS 16, MAX_POOL_TOTAL 1024, DRAW_TIMEOUT 900).
- **P7 FRONTEND: Iwa Prize Savings integrated into the main Iwa app** at
  `/app/prize-savings` - one Iwa product, not a standalone dapp. Inside
  AppShell, Iwa lavender design system, sidebar + account-nav entry (kept off
  the 4-tab phone bar per the existing mobile rule), Ethereum-Sepolia wallet
  seam (EIP-1193, separate from the Starknet wallet), Zama SDK wrapper for
  encrypted inputs and EIP-712 user decryption, full flow (mint -> wrap ->
  operator -> deposit -> balance reveal -> owner fund/lock/draw -> claim ->
  withdraw/withdrawAll) with wrong-network, rejection, relayer-failure and
  claim-replay handling. Frontend: 589 tests pass, build clean, typecheck
  clean; existing routes untouched.
- Sepolia verification: pending credentials. Sepolia-only items listed in
  SECURITY.md (mock does not enforce operation-level ACL or input binding).
- Release gate: **CLEARED for the Sepolia bounty** (F1 accepted for MVP).
- P8 packaging: READY - README section + module README (confidentiality and
  leakage analysis), submission package (demo script, X thread, form answers,
  release checklist) in `zama-prize-savings/SUBMISSION.md`. Live-site check:
  `/app/prize-savings` rewrites correctly on useiwa.xyz but the new build is
  not yet deployed (final push is a human action). Local build verified.
- Current task: human final actions (see SUBMISSION.md checklist). Next:
  final commit/push/deploy + demo + X thread + form
- Deadline: 2026-09-05 23:59 AOE

## Deployment

| | |
|---|---|
| Frontend | Vercel, live at `useiwa.xyz` |
| Coordination service | Railway |
| Database | Supabase Postgres. Row level security is applied out of band, not by a migration |
| Chain | Starknet mainnet |
| Privacy settlement | STRK20 pool |

Iwa is a multichain product. Starknet is the current integration, not the
boundary of the design.

## Contracts

Both deployed to Starknet mainnet, both immutable.

| Contract | Address |
|---|---|
| `IwaCircle` | `0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be` |
| `IwaStrk20Helper` | `0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb` |

Neither has an owner, a pause switch, a setter or a class-hash replacement. The
one-time deployment wiring burned its own authority: the deployed circle
contract reports a setup authority of zero, which can be read from chain.

`IwaCircle` makes no external contract calls at all and moves no tokens. All
token movement is confined to the helper, which accepts calls only from the
privacy pool.

## What works

**Circles.** Creating a circle through the invite flow, on mainnet. Each place
is reserved for one person at creation, and the payout order is fixed from then
on with no callable mutation path.

**Invitations.** One link per place. Accepting reserves the place and records
the accepting wallet, so an accepted invitation is recoverable later from the
wallet alone, with no link and nothing stored on the device.

**Joining.** An invited member joins by proving their invite secret against the
commitment already in the payout order. Membership is the contract's answer, not
the coordination service's.

**Contributions.** Settled privately through the STRK20 pool: one transaction
that withdraws the exact obligation to the helper and invokes it, atomically.
Amounts and payment relationships stay private; the obligation that was settled
is recorded publicly against a commitment.

**Accounting.** Obligations, grace windows, late and default transitions, cure
state and payout accounting, all on chain and immutable. A default cannot be
erased, including by the organizer.

**Standing.** A member's own record in a circle, counted from the obligations
the contract holds: rounds completed, paid on time, paid late, defaulted.
Private to them.

**Application.** Routed, deep-linkable and readable without a wallet. Public
circle terms, seats and rounds are visible to anyone; a wallet is asked for by
the action that needs one.

## Phase 7B: organizer command center

Complete, and verified against mainnet with read-only calls.

The circle screen now carries an operational section for the wallet the
deployed contract records as that circle's organizer. It is read only. It
reports state and offers no control, because the contracts hold no organizer
power for it to offer: no fund movement, no payout override, no contributing or
collecting on somebody's behalf, no waiving a default.

What it establishes, and from what:

- Organizer identity is `organizer` on the deployed circle contract, compared
  against the connected wallet. Not a role from the coordination service, and
  not a claim from the browser. It fails closed.
- Accepted places and joined places are shown separately and never collapse
  into one figure. A place accepted but not joined is surfaced in its own words.
- The current round's paid, due, grace, past grace and missed counts are
  derived from each place's obligation on chain. A grace window that has closed
  without the contract recording a default is reported as past grace, not as a
  default.
- No private member identifier reaches the screen. Places are positions, shown
  as Place 1 and Place 2: no wallet address, member reference, invitation
  token, auth key, or savings history from anywhere else.
- Reading it costs no wallet signature. Every call behind it is a public view
  call, and opening Home still asks for nothing by itself.

No database migration, no contract change, no new signing flow, no mainnet
write.

Frontend: 471 tests pass, `tsc -b` clean, production build clean. Backend: 193
pass and 12 skipped, typecheck clean, with no backend source changed.

### Circle 1, read live

Round 1 of 2. Contribution 1.000000 USDC per member. Two members, both joined,
both obligations `OnTime`. Round outstanding liability 2.000000 USDC.
`get_payout_state(1, 1)` reverts with `IWA: payout locked`, which is the
contract saying it holds no payout record for that round yet. The derived
operational state is `accountingReady`: the round is waiting at
`finalize_round_payout_accounting`.

That is an earlier point in a round than finding H-2 below. H-2 is about a
payout that has already been prepared and then waits on its recipient's own
authorization. Round 1 has not reached that step, so the 2.000000 USDC held
against it is not evidence of a stranded payout, and nothing here says it is.
Preparing the accounting moves no money and is not an organizer power; the
application does not call it.

## Phase 7C: platform admin dashboard

Complete, and working in production: an allowlisted wallet signs in at `/admin`
and the dashboard loads.

Operators reach `/admin`. It reports and does nothing else: there is no admin
mutation in the service and no administrative power in the contracts for one to
reach.

**Access.** A wallet signature, bound to the exact action, method, path and body
as SNIP-12 typed data, verified against the account contract on chain, and then
checked against an allowlist. Enforcement is server side, in the route, against
the address the signature proved. The path is not the protection: `/admin`
renders nothing until the API answers, and a caller who skips the screen meets
the same check.

**The allowlist** is the `ADMIN_ADDRESSES` environment variable of the
coordination service: comma separated Starknet addresses, validated at boot.
Unset or empty denies everybody, so a deployment nobody has configured for
operations has no admin surface rather than an open one. It lives in the
environment and not in Postgres, so write access to the database does not make
anybody an operator.

**A read-only session cannot reach it.** Admin reads take the full per-request
signature and refuse a bearer token, so a captured session never becomes
operator access. That is asserted directly: an operator's own valid session
works on an ordinary private read and is refused here.

**What it shows.** Aggregate coordination counts, live chain health, and this
deployment's configuration, each row labelled with which of the three it came
from. No wallet address, member reference, invitation token, draft id or circle
membership is in the response to be shown. No money movement, no payout or
settlement action, no reconciliation on an organizer's behalf, and no control
of any kind.

No contract change, no database migration, no mainnet write. The counts are
COUNT, SUM and MIN over columns that already existed.

Frontend: 526 tests pass, `tsc -b` clean, production build clean. Backend: 224
pass and 12 skipped, typecheck clean.

### The first sign in, and why it failed

The first attempt returned "Your wallet signature could not be verified". The
cause was the nominated operator account: it had not been deployed on Starknet
mainnet, so `is_valid_signature` could not be called on it at all, and the
verifier correctly read an uncallable account as a failed signature. Once the
account was deployed, SNIP-12 admin authentication succeeded and the dashboard
loaded.

Nothing was wrong with the authorization binding, the allowlist or the route.
Worth remembering because the failure looks like a signing bug and is not one: a
wallet nominated for an operational role has to be a deployed account before it
can prove anything on chain.

### The operator area has its own shell

`/admin` renders in a dedicated AdminShell: a compact header with the brand, the
section anchors and the connected wallet, over a single column. The saver
navigation does not appear there. Home, Explore, My circles, Invitations, My
standing and Start a circle belong to the saver product, and so does the mobile
tab bar; none of them renders on an operations page. Every other route keeps the
existing AppShell unchanged, including an unrecognised path under `/admin`,
which is a mistyped URL rather than an operator page and gets the ordinary not
found.

The shell is layout and holds no authority. It carries no allowlist, no role and
no gate, signs nothing and calls no API, so rendering it grants nothing. What an
operator may see is still decided by the service, against a wallet signature and
the environment allowlist, unchanged by this correction.

That correction touched the frontend only: no backend change, no database
migration, no contract change, and no mainnet write. Frontend: 549 tests pass,
`tsc -b` clean, production build clean.

### What the metrics are, and are not

They are coordination, chain and health aggregates: drafts by state, places
accepted, circles recorded as created, circles the indexer has seen, node
reachability, contract reachability, store modes and live counts.

They are not user or growth analytics, and nothing in the dashboard claims to
be. Durable signup and user-growth figures are deferred: there is no first-seen
record and no user event source in this system to derive them from, and
inventing them from coordination rows would produce numbers nobody could trace.
Adding them needs a new event source and a schema change, neither of which this
phase made.

## What does not work yet

**Collecting the pot.** The settlement path exists and is covered by the
contract tests. Authorising it from a browser wallet is what is missing: the
authorisation has to commit to an identifier that only exists once the wallet
has already assembled the transaction, so the signature cannot be produced in
time. The control is closed and says so rather than failing when pressed.

**Proving a Portable Trust Credential.** The claim model and the proving that
runs on the member's own device both exist, preserved from the earlier
implementation. Nothing on the current network can check a proof, so a proof
would be produced and shown to nobody. The entry point is closed and explains
itself before any proving work is done.

**Standing across circles.** A record exists per circle. There is no aggregate
across circles, and none is displayed.

**Public circles.** Circles are invite gated in the contract by design, and the
directory says so. Joining without a reserved place is not possible and is not
offered.

## Known limitations accepted for this release

**Payout liveness if a member loses their key (finding H-2).** A round's pot can
only settle when the member scheduled to receive it authorizes the settlement
with the key they derived when they joined. That key has no setter, and the
contracts have no owner, no pause and no upgrade path. So if that member
permanently loses access to their wallet, or refuses to sign, the round's pot
stays where it is and the circle cannot be finalized either, because
`prepare_final_settlement` will not convert a scheduled payout into anything
else.

What this is not: nobody can steal or redirect those funds. Every settlement
signature binds the circle, the round, the member, the amount and the exact
destination, so there is no substitution path. The organizer cannot recover
them, Iwa cannot recover them, and no administrative override exists to be
misused. The helper's `normalize_surplus` cannot reach them either, because a
stranded pot is accounted liability rather than surplus.

Status: accepted for this deployment, knowingly. There is no rushed patch, and
there cannot be one, because the deployed contracts are immutable. A real fix
needs a new contract version. The options and the invariants any fix has to
preserve are written up in `SECURITY.md`. Existing circles would stay on the
current contracts; nothing would be force migrated.

Scope: this affects a circle only when its scheduled recipient becomes unable or
unwilling to authorize their own payout. It is a liveness tradeoff in an
immutable non-custodial design, not an exploit and not a general risk to funds.

Live example, read from mainnet with read-only calls and no transaction sent.
`IwaStrk20Helper` holds 2.000000 USDC. Its accounted token liability for USDC is
also 2.000000 USDC, and its surplus is 0. Those three figures together are the
proof that the amount is a real round obligation rather than stray value, and
that `normalize_surplus` cannot move it: that function refuses when surplus is
zero. The round level payout status behind this balance has since been read
directly, in Phase 7B above: `get_payout_state` is a plain view call, and for
circle 1 round 1 it reverts with `IWA: payout locked`, so no payout record
exists for that round yet. No member commitment, wallet
address or invitation identifier is recorded here, and none is needed: these are
aggregate contract totals that anybody can read.

## Security constraints

- Non-custodial. The coordination service holds no funds, signs nothing, and has
  no column for key material.
- Member signing keys are derived in the browser from one wallet signature, and
  are never persisted, logged or transmitted.
- Organizer actions require a single-use expiring challenge signed by the wallet
  and verified against the account contract on chain. An address alone is never
  a credential.
- Recording that a circle was created is verified against the chain: the payout
  order and terms must match the draft. A client cannot assert it.
- Every authenticated settlement path consumes a single-use nonce in its own
  namespace, checked and written atomically.
- The database is reached only by the coordination service, which connects as
  owner. Row level security with no policies was applied to the Supabase project
  by hand, so the anon and authenticated roles reach nothing there. That state is
  not in `backend/migrations/`, which means it is real on this deployment but is
  not reproduced by deploying this repository somewhere new. A fresh database
  would need it applied again, by hand or by a migration nobody has written yet.

Iwa has not been through an external security audit. The invariants the
contracts are expected to hold are in `SECURITY.md`.

## Mainnet evidence

`strk20.json` records the verified pool transactions and the deployed contract
addresses. Each transaction succeeded and touched the STRK20 pool.

## What remains

1. Collecting the pot from inside the application.
2. A way to check a Portable Trust Credential, and a flow for whoever receives
   one.
3. Standing that aggregates across more than one circle.
4. A second chain implementation behind the existing chain interface.

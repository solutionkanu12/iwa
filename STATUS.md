# IWA — Status

What works today, what does not, and where the line between them sits. Written
against verified behaviour: contract reads, deployed code and passing tests, not
intent.

Last reviewed against the working tree during the reconnect work.

## Deployment

| | |
|---|---|
| Frontend | Vercel, live at `useiwa.xyz` |
| Coordination service | Railway |
| Database | Supabase Postgres, row level security enabled with no policies |
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
zero. The round level payout status behind this balance is carried from the
Phase 6 audit rather than re-read, because the payout accessors are declared
`ref self` and are not callable as plain reads. No member commitment, wallet
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
- The database runs with row level security enabled and no policies, so the anon
  and authenticated roles reach nothing while the service connects as owner.

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

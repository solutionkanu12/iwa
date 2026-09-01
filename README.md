# Iwa

**Savings circles that keep your money private and make your reliability portable.**

Iwa is savings and financial reputation infrastructure. People save together in
rotating circles, the way ajo, esusu, tandas and chit funds have always worked,
and the reliability they build there becomes something they can prove to a
lender, a landlord or an employer without opening up their finances.

Two things are normally bundled together that should not be: the money and the
record. Iwa keeps the money private and makes the record verifiable.

## The problem

Billions of people build real financial reliability outside formal banking. They
contribute to a circle every week, they pay on time for years, and they cover for
each other. That reliability is real. It is also unusable, because nothing
carries it anywhere.

The mainstream fix asks people to surrender everything first. Hand over a full
transaction history, contacts and identity, and receive a rating back. So the
choice is to stay private and stay invisible, or to become visible by becoming
exposed.

Neither is acceptable for the people who need credit most.

## What Iwa does

A group agrees an amount and a turn order. Every round each member contributes,
and one member collects the whole pot. When the rotation completes, everyone has
taken out what they put in, and everyone now has a record of how they behaved.

Iwa runs that on chain with contributions settled privately, so amounts and the
payment graph stay hidden, while the accounting the group actually depends on
stays verifiable: who owes what this round, who paid on time, who is late but
inside the grace window, who defaulted, and whose turn is next.

The reliability that comes out of it is designed to travel. A member can later
prove a scoped statement, for example that they completed three cycles with no
defaults, without handing over the history behind it. Iwa calls this a Portable
Trust Credential. It is deliberately not a numeric credit score, and it is not a
file anyone else gets to keep.

## How a circle works

1. An organizer sets the terms: contribution amount, cadence, grace period and
   the number of places.
2. Each place is invited individually. A member accepts with a private invite
   secret and registers a commitment, not an address.
3. The payout order is fixed when the circle is created and has no mutation path
   afterwards. Nobody can be moved up or down the queue later.
4. Each round every member owes one contribution, settled privately.
5. Paying after the deadline but inside the grace window is recorded as late,
   not as a default. Missing it entirely is recorded as a default, and cannot be
   erased.
6. When the round is complete, the scheduled member collects the pot.

A member who reaches their turn while carrying an unresolved deficit does not
simply lose the pot. The contract holds it under defined rules and provides a
cure path, so a bad month is recoverable and the outcome is not left to an
administrator's discretion.

## Privacy model

Privacy here is structural, not a setting.

Hidden:

- the link between a wallet and a member of a circle
- the source of the funds a contribution is paid from
- shielded balances, and the transfer graph between participants
- a member's wider history when they disclose one scoped claim

Public, because the group depends on it:

- that a circle exists, and its cadence, asset and size
- that a given commitment met, or missed, its obligation for a round
- the aggregate accounting that proves the pot is fully funded

Members are Poseidon commitments throughout the accounting contract. No wallet
address is ever written as a member, so membership cannot be recovered by
looking at who transacted.

Key material stays with the person. Member signing keys are derived in the
browser from a single wallet signature and are never persisted, never logged and
never transmitted. The coordination service has no field to store them in.

## Multichain architecture

Iwa is designed as a multichain product, and the boundary is enforced in the
codebase rather than asserted in a document.

```text
Product and domain layer     circles, rounds, obligations, grace and default
                             rules, payout rotation, credential semantics
        |
Chain interface              a capability contract with no chain types in it
        |
Chain implementation         wallet, RPC, transaction construction, settlement
```

What is true today:

- `iwa-web/src/core/domain` holds the chain-neutral rules. It contains no
  addresses, no RPC and no chain-specific types.
- `iwa-web/src/chains/types.ts` defines the `ChainAdapter` capability contract.
  It is currently a specification with one implementation path behind it, not a
  finished plug-in system.
- The application reaches the chain through a single seam module. That seam has
  already been swapped once, from the earlier Soroban implementation to the
  current one, with identical exports and no changes to the product screens.
  That is the practical evidence that the boundary holds.
- The same split exists on the contract side. `IwaCircle` owns the accounting,
  holds no tokens and makes no token calls at all. Token movement is confined to
  a separate settlement contract.

What is not true yet: there is no second live chain, and the adapter interface
is not yet implemented as a swappable module. Further integrations are part of
the architecture, not a claim about the present.

## Current integrations

**Starknet, using the STRK20 privacy pool.** This is the environment where Iwa's
private settlement currently runs. Contributions are paid out of shielded
balances, so amounts and payment relationships stay private while the obligation
they satisfy is recorded publicly against a commitment.

Chain-specific execution is kept separate from Iwa's savings, reliability and
credential model, so the product can extend to other networks without a rewrite.
Starknet is a current integration path, not the product boundary.

Live on Starknet mainnet:

| Contract | Address |
|---|---|
| `IwaCircle`, accounting | [`0x01f81497…6f81be`](https://voyager.online/contract/0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be) |
| `IwaStrk20Helper`, settlement | [`0x04cac02d…fafbbb`](https://voyager.online/contract/0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb) |

## Security model

Iwa is non-custodial by construction.

- **The accounting contract never holds or moves tokens.** It contains no ERC-20
  calls at all. Settlement is confined to the helper contract, which accepts
  calls only from the privacy pool.
- **No admin, no upgrade path.** Neither contract has an owner, a pause switch, a
  setter or a class-hash replacement. The one-time deployment wiring burns its
  own authority: the deployed accounting contract reports a setup authority of
  zero, readable from chain.
- **Immutable history.** A default cannot be erased and the payout order cannot
  be rewritten, including by the organizer.
- **Replay protection.** Every authenticated settlement path consumes a
  single-use nonce in its own namespace, checked and written atomically.
- **The signer is pinned to the verifier.** Contributions are authorized with
  Stark-curve signatures over domain-separated Poseidon hashes. Fixed parity
  vectors in the Cairo test suite lock the browser signer to the deployed
  verifier, so a signature the chain would reject cannot be produced.
- **The backend holds nothing.** It coordinates drafts and invitations and
  indexes public chain data. It takes no custody, signs nothing, and has no
  column for key material. Organizer actions require a single-use expiring
  challenge, signed by the wallet and verified against the account contract on
  chain, so an address by itself is never a credential. The database runs with
  row level security enabled and no policies.

Iwa has not been through an external security audit. The invariants the
contracts are expected to hold are documented in [SECURITY.md](SECURITY.md).

## Technical implementation

- **Contracts.** Cairo. `IwaCircle` holds circle state, obligations, grace and
  default transitions, cure state and payout accounting. `IwaStrk20Helper` is the
  settlement adapter the privacy pool calls. 190 test functions across 15 Cairo
  test files, including the parity suite that pins the browser signer to the
  on-chain verifier.
- **Frontend.** React and TypeScript, mobile first. Members connect a
  privacy-enabled wallet, and the wallet keeps the viewing key, discovers notes,
  proves and submits. The application never sees private state.
- **Backend.** Node and TypeScript over Postgres. Coordination and public event
  indexing only.
- **Verification tooling.** Read-only preflight scripts that check deployed class
  hashes, settlement wiring and funding requirements against the live chain
  before anything is sent.

## Status

Working today:

- creating a circle through the invite flow, on mainnet
- accepting an invitation and reserving a place
- private contributions settled through the pool
- obligation, grace, late and default accounting
- a member's own standing, read from chain and visible only to them

Not yet available:

- collecting the pot from inside the application. The authorizing signature has
  to bind an identifier that exists only once the wallet has assembled the
  transaction, so it is left unavailable rather than half working. The settlement
  path itself is implemented and covered by contract tests.
- on-chain verification of a Portable Trust Credential. The claim model and
  browser proof generation exist from the earlier implementation and are
  preserved here, but no verifier is deployed for the current chain, and nothing
  in the product claims otherwise.

## Links

- Product: [iwa-psi.vercel.app](https://iwa-psi.vercel.app)

## Repository

```text
contracts/starknet     Cairo contracts and test suite
iwa-web                frontend, chain-neutral domain layer, chain adapters
backend                coordination service, indexer, migrations
scripts/demo           read-only verification and settlement tooling
docs                   domain invariants and integration research
iwa-circuit            earlier ZK circuit, preserved
iwa-prover             earlier proving service, preserved
iwa-savings            earlier savings contract, preserved
iwa-verifier           earlier on-chain verifier, preserved
```

The four preserved directories are the previous implementation. They are kept
deliberately, because the credential layer will be rebuilt from that work rather
than from scratch.

## Running it locally

Requires Node 20 or later.

```bash
# frontend
cd iwa-web
npm install
npm run dev

# backend, in memory, no database required
cd backend
npm install
npm run dev:memory
```

Configuration is by environment variable. Copy the `.env.example` in `iwa-web`,
`backend` and `scripts/demo`, then fill in local values. No credential belongs in
the repository.

Tests:

```bash
cd iwa-web && npm test      # frontend and domain rules
cd backend && npm test      # API, auth and store
cd contracts/starknet && scarb test
```

The backend also has a Postgres integration suite, skipped unless
`TEST_DATABASE_URL` is set.

## Roadmap

Grounded in what is already built, in order:

1. Pot collection inside the application, closing the last gap in the round.
2. A deployed verifier, so a Portable Trust Credential can be checked on chain,
   and a verifier-facing flow for the institution receiving it.
3. Reliability that aggregates across more than one circle.
4. A second chain implementation behind the existing chain interface, which is
   also what finishes turning that interface from a specification into a
   swappable module.

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

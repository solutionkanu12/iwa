# Iwa

Your good name, proven and private.

Iwa is private community savings and portable financial trust infrastructure.
People save together in rotating circles, the way ajo, esusu, tandas and chit
funds have always worked, and the reliability they build there becomes
something they can prove to a lender, a landlord or an employer without opening
up their finances.

Two things are normally bundled together that should not be: the money and the
record. Iwa keeps the money private and makes the record verifiable.

Live product: [useiwa.xyz](https://useiwa.xyz)

## Why Iwa

Billions of people build real financial reliability outside formal banking.
They contribute to a circle every week, they pay on time for years, and they
cover for each other. That reliability is real. It is also unusable, because
nothing carries it anywhere.

The mainstream fix asks people to surrender everything first. Hand over a full
transaction history, contacts and identity, and receive a rating back. So the
choice is to stay private and stay invisible, or to become visible by becoming
exposed.

Neither is acceptable for the people who need credit most.

Iwa's answer is to separate the two: private money, verifiable record. A saver
keeps control of their financial history and can still prove, on demand, that
they are someone who shows up.

## How it works

The saver journey is a circle:

Create or join a circle, contribute each round, receive the payout when the
rotation reaches you. Iwa records the verifiable outcome of every round, and
good standing built up over time can later support a private trust credential.

Circles are invite based. The contribution amount, cadence, grace period and
payout order are fixed before contributions begin, and the payout order has no
mutation path afterwards.

1. An organizer sets the terms: contribution amount, cadence, grace period and
   the number of places.
2. Each place is invited individually. A member accepts with a private invite
   secret and registers a commitment, not an address.
3. The payout order is fixed when the circle is created and cannot be changed
   afterwards. Nobody can be moved up or down the queue later.
4. Each round every member owes one contribution, settled privately.
5. Paying after the deadline but inside the grace window is recorded as late,
   not as a default. Missing it entirely is recorded as a default, and cannot
   be erased.
6. When the round is complete, the scheduled member collects the pot by
   authorizing the settlement themselves. Nobody else can authorize it for
   them, and nobody else can send it anywhere else.

A member who reaches their turn while carrying an unresolved deficit does not
simply lose the pot. The contract holds it under defined rules and provides a
cure path, so a bad month is recoverable and the outcome is not left to an
administrator's discretion.

The current release runs on Starknet mainnet, and contributions are settled
through the STRK20 privacy pool: amounts and payment relationships stay
private, while the obligation they satisfy is recorded publicly against a
commitment.

## What you can do today

The application is live. Home acts as the Action Center, raising what is due
and what needs attention, and the saver product includes Explore, My Circles,
Invitations, the circle timeline, the Organizer Command Center and My Standing.
The platform admin area is a separate, read-only operations surface.

Working today:

- create a circle through the invite flow, on mainnet
- receive and accept an invitation, one per place
- join a circle and register a member commitment
- contribute each round, settled privately through the STRK20 pool
- follow the current round and your obligation on the circle timeline
- act on what is due from the Action Center
- run the organizer command center, which reports state and offers no control
- read your own standing, counted from your obligations on chain and visible
  only to you
- operate the platform admin dashboard, read only and allowlisted
- browse public circle terms without a wallet

Capability gated in this version:

- collecting the pot from inside the product. The settlement path exists and is
  covered by contract tests; authorizing it from a browser wallet is the part
  that is not open yet.
- Portable Trust Credential generation and verification. The claim model and
  device-side proving exist; nothing on the current network can check a proof,
  so the entry point stays closed rather than half working.

## Iwa Prize Savings

One product, one more way to save.

Iwa Prize Savings is an Iwa feature, not a separate product: inside the app at
`/app/prize-savings`, a saver deposits into a shared pool, keeps their
principal withdrawable at any time, and earns a chance at a shared reward
through a confidential weighted draw.

**"Save privately. Keep your principal. Earn a chance at shared rewards."**

The current implementation runs on Ethereum Sepolia and uses Zama's fhEVM as
its confidentiality layer.

How the confidentiality works:

- **One public step, then encrypted.** A saver wraps plaintext MockUSD into a
  confidential ERC-7984 token (cMockUSD). That one wrap is public, because the
  underlying ERC-20 transfer is public; it is also the only amount the saver
  ever reveals. After wrapping, everything is encrypted.
- **Encrypted deposits.** Deposit amounts move as confidential ERC-7984
  transfers - no plaintext amount ever appears on chain.
- **Encrypted balances.** Every participant balance is a ciphertext, usable by
  the pool contract but decryptable only by its owner, through an
  EIP-712-authorized user decryption the saver's own wallet signs.
- **Confidential weighted draw.** A plaintext power-of-two bound, an encrypted
  random ticket, and a cumulative encrypted walk over live balances select a
  winner without decrypting a single balance.
- **Encrypted winner.** The winner is an encrypted index, never an address in
  the clear. Claiming is a pull: every participant's claim looks identical on
  chain, and only the winner's own balance grows by the reward.
- **Encrypted claim, confidential withdrawal.** The reward is credited as an
  encrypted balance adjustment, and principal plus reward withdraw through the
  normal confidential withdrawal. Principal is never locked: withdrawals are
  available in every round state, including a full `withdrawAll` that needs no
  encrypted input at all.
- **No plaintext exposure.** No deposit amount, balance, prize, ticket or
  winner index is ever written in the clear.

What stays public, by design: membership and participant indices, transaction
timing, contract addresses, the one-time wrap amount, and the round state.

Known limitation, accepted for the Sepolia version only: sixteen distinct
wallets can fill the participant cap with zero-value deposit attempts. That
acceptance does not carry to production; any production deployment requires a
redesigned participant admission (see `SECURITY.md`).

Deployed addresses and the full confidentiality and leakage analysis are in
[`zama-prize-savings/README.md`](zama-prize-savings/README.md).

## Privacy

Privacy here is structural, not a setting.

Iwa is designed not to expose or store private keys, seed phrases, viewing
keys, the private financial graph between participants, raw private savings
history, or a cross-circle private identity. Key material stays with the
person: member signing keys are derived in the browser from a single wallet
signature and are never persisted, logged or transmitted, and the coordination
service has no field to store them in.

Hidden:

- the source of the funds a contribution is paid from
- shielded balances, and the transfer graph between participants
- a member's wider history when they disclose one scoped claim

Public, because the group depends on it:

- that a circle exists, and its cadence, asset and size
- that a given commitment met, or missed, its obligation for a round
- the aggregate accounting that proves the pot is fully funded

One boundary must be stated plainly: V1 membership is not anonymous by
construction. Members are commitments throughout the accounting contract and
no wallet address is written as a member, but the join transaction itself is
sent from a wallet and that sender is public. STRK20 protects the privacy of
settlement transfers, not the privacy of membership. Deposit and withdrawal
edges at the pool, transaction timing and open note amounts remain public.

A V2 identity architecture is planned to improve cross-circle unlinkability and
recovery, and is described in the multichain roadmap.

## Portable Trust Credential

The Portable Trust Credential is a scoped proof of reliability. A member can
prove a statement such as "completed at least three savings cycles with no
defaults" without handing over the history behind it. It is deliberately not a
numeric credit score, and it is not a file anyone else gets to keep.

The verifier sees only the requested claim and its proof metadata, not raw
savings history. That is also the business boundary: Iwa monetizes verification
and infrastructure, not private financial data.

The concept is part of the product, and its claim model is built and preserved.
Generation and verification are currently capability gated, because nothing on
the current network can check a proof. Sharing will open with the work
described in the roadmap.

## Security

Iwa is non-custodial by construction.

- The accounting contract never holds or moves tokens. Settlement is confined
  to the helper contract, which accepts calls only from the privacy pool.
- No owner, no pause, no upgrade path. Neither contract has an owner, a pause
  switch, a setter or a class-hash replacement. The one-time deployment wiring
  burned its own authority: the deployed circle contract reports a setup
  authority of zero, readable from chain.
- The payout order is fixed at creation and cannot be rewritten, including by
  the organizer.
- Immutable history. A default cannot be erased, and a completed contribution
  or payout cannot be replayed or rewritten.
- The signer is pinned to the verifier. Contributions are authorized with
  Stark-curve signatures over domain-separated Poseidon hashes, and fixed
  parity vectors in the Cairo test suite lock the browser signer to the
  deployed verifier.
- The backend does not hold user private keys, seed phrases, viewing keys, or
  custody of user funds. It does hold coordination data: drafts, invitations,
  associations and operational and session state. It signs nothing and has no
  column for key material. Organizer and admin actions require a single-use
  expiring challenge signed by the wallet and verified against the account
  contract on chain, so an address by itself is never a credential.
- Admin is operational, not custodial. The admin dashboard is read only, admin
  reads refuse session tokens and take the full per-request SNIP-12 signature,
  and the backend has no mutation route an administrator could reach.
- Untrusted outputs are validated deterministically. The helper accepts calls
  only from the verified pool, enforces exact amount accounting per round and
  token, and has no arbitrary-call surface.

Verification status:

- Cairo: 190 test functions across 15 files, including the parity and
  settlement boundary suites
- Frontend: 555 tests pass
- Backend: 257 tests pass, including the Postgres integration suite (12 of
  12) when run against a scratch database
- Production routes and security headers are pinned by tests that read the
  deployed configuration

Iwa has not been through an external security audit. Internal testing and
security review are not the same thing as an independent third-party audit. The
invariants the contracts are expected to hold are documented in
[SECURITY.md](SECURITY.md).

## Architecture

The system is built in layers:

```text
Frontend (React and TypeScript, mobile first)
Coordination backend (Node and TypeScript over Postgres)
Starknet contracts (Cairo: IwaCircle accounting, IwaStrk20Helper settlement)
STRK20 privacy integration (private settlement through the pool)
Postgres (coordination and indexed public data)
Vercel (frontend) and Railway (backend)
```

Iwa is multichain by product direction, and the boundary is enforced in the
codebase rather than asserted in a document. The product and domain layer
(circles, rounds, obligations, grace and default rules, payout rotation,
credential semantics) is chain neutral and contains no addresses, no RPC and no
chain-specific types. A chain interface sits between the domain layer and the
chain implementation, and token movement is confined to the settlement contract
while the accounting contract makes no token calls at all.

Starknet is the current implementation, not the permanent identity of the
product. Future chains are expected to implement the same domain interface
natively. The deep version is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Mainnet deployment

The current release runs on Starknet mainnet.

| Contract | Role | Address |
|---|---|---|
| IwaCircle | circle accounting | `0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be` |
| IwaStrk20Helper | STRK20 settlement | `0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb` |
| STRK20 pool | privacy pool, operated by StarkWare | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |

Both Iwa contracts are immutable, hold no admin authority, and were verified
read-only against mainnet before release. The addresses are pinned in the
frontend and the deployment tooling, and the tooling's preflight checks the
class hash actually running at each address rather than trusting the address
alone.

## Current limitations

**Payout liveness if a member loses access to the wallet they joined with.**

Each round's pot settles only when the member scheduled to receive it
authorizes the settlement with the key they derived when they joined. That key
has no setter, and the deployed contracts have no owner, no pause and no
upgrade path.

The live circle today is not itself stranded: no payout record exists for its
round, so no settlement currently waits on a missing authorization. The
limitation becomes relevant once payout accounting creates a scheduled payout,
and only if the scheduled member's required authorization becomes permanently
unavailable. In that case V1 has no recovery path, by the same design that
stops anyone from redirecting a payout. The funds cannot be stolen or
redirected; they simply cannot be released by anyone except the member.

A proper fix requires a future contract version. The options under
consideration and the invariants any fix must preserve are written up in
[SECURITY.md](SECURITY.md).

## Roadmap

The full plan lives in
[docs/IWA_MULTICHAIN_ROADMAP.md](docs/IWA_MULTICHAIN_ROADMAP.md). The direction,
in brief:

- IwaCircle V2, with recovery and payout liveness addressed in the contract
- Member Identity V2, with per-circle unlinkability and signer recovery
- pot collection inside the product, and an open credential verification flow
- embedded email and passkey accounts
- Base as the first EVM expansion, then Ethereum and BNB where justified
- Solana later, as a separate native implementation
- real product analytics on a proper event source
- Portable Trust Credential expansion across chains

## Development

Requires Node 20 or later.

Frontend:

```bash
cd iwa-web
npm install
npm run dev
```

Backend, in memory, no database required:

```bash
cd backend
npm install
npm run dev:memory
```

Configuration is by environment variable. Copy the `.env.example` in
`iwa-web`, `backend` and `scripts/demo`, then fill in local values. No
credential belongs in the repository.

Tests:

```bash
cd iwa-web && npm test          # frontend and domain rules
cd backend && npm test          # API, auth and store
cd contracts/starknet && scarb test
```

The backend also has a Postgres integration suite, skipped unless
`TEST_DATABASE_URL` is set.

## Repository structure

```text
iwa-web/         frontend, chain-neutral domain layer, chain adapters
backend/         coordination service, indexer, migrations
contracts/       Cairo contracts and test suite
scripts/demo/    read-only deployment verification tooling
docs/            architecture, security and multichain roadmap
```

Earlier implementation work (`iwa-savings`, `iwa-circuit`, `iwa-prover`,
`iwa-verifier`) is preserved deliberately: the credential layer will be rebuilt
from that work rather than from scratch.

## License

MIT. See [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
# Iwa

Your good name, proven and private.

Iwa is private community savings and portable financial trust infrastructure.
It helps people save through community-based products, build a reliable record
from real participation, and eventually share a scoped proof of that record
without handing over their full financial history.

Iwa is one multichain product. Its savings rules and trust model remain
chain-neutral, while each supported network has its own wallet, contract, and
privacy adapter.

Live product: [useiwa.xyz](https://useiwa.xyz)

Prize Savings: [useiwa.xyz/app/prize-savings](https://useiwa.xyz/app/prize-savings)

## What Iwa does

Iwa is built around five connected ideas:

- **Savings circles:** invite-based rotating savings with fixed terms, fixed
  payout order, contribution obligations, grace periods, and immutable
  outcomes.
- **Private financial participation:** supported settlement values and payment
  relationships use the privacy capability of the active chain integration.
- **Standing:** a saver can read the contribution outcomes recorded for them,
  without turning those outcomes into a universal rating.
- **Portable Trust Credentials:** a saver can prove a scoped reliability claim,
  such as completing a number of cycles without default, without disclosing the
  history behind it.
- **Multichain architecture:** Iwa Core defines product rules, and chain-specific
  adapters implement them using the capabilities of each network.

Iwa monetizes verification and infrastructure, not private financial data.

## Current implementations

### Starknet: Iwa Circles

Iwa Circles V1 is live on Starknet mainnet. It provides:

- private, invite-based rotating savings circles
- payout order fixed before contributions begin
- contribution, grace, late, default, cure, and payout accounting
- private contribution settlement through STRK20
- a personal standing record derived from onchain obligations
- ongoing Portable Trust Credential work

Starknet is a current native implementation of Iwa, not the identity or
permanent boundary of the product.

The privacy boundary is specific. STRK20 protects settlement transfers,
including contribution amounts and private payment relationships. Circle
existence, terms, member commitments, obligation outcomes, round progression,
join transaction senders, deposit and withdrawal edges, timing, and open-note
amounts remain public where the current protocol exposes them. V1 membership
is not anonymous.

Circle creation, invitation, joining, contribution, timeline, organizer
reporting, and personal standing are available in the product. Browser-based
pot collection and Portable Trust Credential verification remain capability
gated while their current integration work continues.

### EVM: Iwa Prize Savings with Zama

Iwa Prize Savings is another current Iwa implementation. It runs on Ethereum
Sepolia and uses Zama Fully Homomorphic Encryption, or FHE, as its
confidentiality layer.

A saver deposits a confidential token into a shared pool. Their live encrypted
balance becomes their draw weight, principal remains withdrawable, and a funded
reward is assigned through an encrypted weighted draw.

Ethereum Sepolia is a test environment. The current asset is open-mint
MockUSD wrapped into confidential cMockUSD. It does not represent a production
deployment or real-value asset support.

## Prize Savings flow

1. Connect an EVM-compatible wallet on Ethereum Sepolia.
2. Get test MockUSD from the open testnet mint.
3. Wrap MockUSD into the confidential ERC-7984 token cMockUSD. The ERC-20 wrap
   amount is public.
4. Give the pool time-limited operator permission to move confidential tokens.
5. Deposit a confidential amount. A wallet joins the weighted draw when it
   makes its first deposit request.
6. Keep funds in the pool for encrypted draw weight.
7. Claim after the draw. Winner evaluation and payout credit remain encrypted.
8. Withdraw a chosen amount or use `withdrawAll()` to exit with the full
   credited balance.

Principal is withdrawable in every round state. A winner receives the funded
reward as an encrypted credit to the same balance used for withdrawals.

## How Zama is used

FHE lets the Prize Savings contract compute over encrypted values without first
revealing their plaintext values.

The implementation uses FHE for:

- participant balances
- live weighted selection over participant balances
- the confidential participant total
- the prize reserve
- the random draw ticket
- the winner index
- the claim payout credited to a winner

A saver can request user decryption only for their own permitted balance
handle. Their wallet signs a scoped EIP-712 authorization, and the decrypted
value is returned to the browser for display. Iwa does not send that value to
its backend.

### What remains confidential

After the public ERC-20 wrap step, the current implementation keeps these
values encrypted:

- deposit and withdrawal amounts moved through the confidential token
- participant balances
- the participant total and individual draw weights
- the prize reserve and remaining reserve
- the draw ticket
- the winner index
- the claim payout

### What remains public

Prize Savings does not provide total anonymity. Public information includes:

- wallet participation and wallet addresses
- participant indices
- transaction calls and timing
- operator approvals and claim activity
- round state and lock timestamp
- contract addresses, network, and pool owner
- the initial MockUSD ERC-20 wrap amount

Observers can see that a wallet interacted with the pool even when the amount
is confidential. Timing and later user disclosures can also create correlation
risk. The winner selection result stays encrypted onchain, but a user may still
choose to reveal their own result outside the protocol.

## Verified Sepolia deployment

Network: Ethereum Sepolia, chain ID `11155111`

| Contract | Role | Address |
|---|---|---|
| MockUSD | Open-mint test ERC-20 | `0x0041A7b8Bb29cA5D6b1Cb6eFBcaBAc8519075392` |
| CMockUSD | Confidential ERC-7984 wrapper | `0xB87CE72B9083488977372507efD4127e157510c2` |
| IwaPrizeSavings | Confidential prize pool | `0x2d1b97F7e1E4845260aBd23017686fBa38006037` |

These addresses match both
[`zama-prize-savings/deployments/sepolia.json`](zama-prize-savings/deployments/sepolia.json)
and the frontend configuration. The deployed pool reports a participant cap of
16, a participant-total bound of 1024, and a draw timeout of 900 seconds.

## Security and trust

Iwa is designed to keep custody and administrative authority narrow.

- The backend holds no wallet private keys, seed phrases, viewing keys, or
  deployment signing material.
- Wallet connection is not transaction authorization. Money-moving actions
  require explicit approval from the active wallet.
- Starknet circle payout order is fixed at creation, and completed contribution
  history cannot be rewritten by an administrator.
- The Prize Savings contract has no sweep, rescue, admin withdrawal, proxy, or
  upgrade path.
- Prize Savings credits only the actual confidential token amount returned by a
  transfer, never the requested amount.
- The encrypted participant total is separate from the encrypted prize reserve,
  so prize funding never becomes participant draw weight.
- The draw ticket and winner index remain encrypted. The draw moves no funds.
- The pool owner may draw immediately after locking. If the owner does not act,
  drawing becomes permissionless after the 900-second timeout.
- `withdrawAll()` does not require a new encrypted input, preserving an exit
  path if encrypted-input infrastructure is unavailable.

The Sepolia implementation has an accepted testnet limitation: 16 distinct
wallets can fill the participant cap with zero-transfer deposit attempts. This
blocks any production or mainnet deployment until participant admission is
redesigned. Details and other known limitations are documented in
[SECURITY.md](SECURITY.md).

The repository contains extensive internal tests and records of real Sepolia
verification. Iwa has not received an external security audit. Internal testing
and review are not substitutes for an independent third-party audit.

## Multichain direction

People use Iwa. Iwa uses chain-specific infrastructure behind clear adapters.

```text
Iwa product and chain-neutral domain rules
  -> chain interface
     -> Starknet adapter, Cairo contracts, and STRK20
     -> EVM adapter and Zama Prize Savings
     -> future chain adapters
```

Each savings product belongs to one chain and one asset configuration. Iwa does
not require bridges to call itself multichain, and active circle funds are not
moved between chains by a shared bridge.

Current and planned direction:

| Track | Status |
|---|---|
| Starknet Circles V1 | Live on Starknet mainnet |
| Starknet Circles V2 | Protocol, identity, recovery, and payout-liveness work in progress; not deployed |
| EVM Prize Savings with Zama | Implemented and deployed on Ethereum Sepolia testnet |
| Base | Planned as a future EVM circle implementation after the V2 protocol and security work |
| Celo | Planned future integration; no shipped implementation |
| Nimiq | Planned later integration; no shipped implementation |
| Other EVM networks | Possible only after an EVM contract family is independently audited |
| Solana | Longer-term native implementation; no shipped implementation |

New chain implementations must preserve the Iwa domain rules, pass a
chain-specific security review, and describe their real privacy capabilities
without implying that every chain provides the same guarantees.

The detailed program is maintained in
[docs/IWA_MULTICHAIN_ROADMAP.md](docs/IWA_MULTICHAIN_ROADMAP.md).

## Architecture

The repository follows a layered model:

```text
Frontend
  -> application services and chain-neutral domain logic
     -> chain interface
        -> Starknet adapter and Cairo contracts
        -> EVM adapter and Zama contracts

Backend and indexer
  -> coordination, public metadata, notifications, health, and reporting
```

Contracts remain authoritative for financial protocol state. The backend is a
coordination and indexing service, not a custodian and not the source of truth
for private balances.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architecture and
[PROJECT.md](PROJECT.md) for product scope.

## Current status

- Starknet Circles V1 is live on mainnet.
- Starknet V2 design and protocol work is in progress and is not deployed.
- Prize Savings is implemented in the Iwa frontend and deployed on Ethereum
  Sepolia using Zama FHE.
- Base, Celo, Nimiq, other EVM networks, and Solana remain planned future work.
- Portable Trust Credential generation and verification are not yet open in
  the current product flow.
- Neither the Starknet nor Prize Savings implementation has received an
  external security audit.

Live implementation status, verified behavior, limitations, and next steps are
tracked in [STATUS.md](STATUS.md).

## Development

Requires Node.js 20 or later.

Frontend:

```bash
cd iwa-web
npm install
npm run dev
```

Backend in memory, with no database required:

```bash
cd backend
npm install
npm run dev:memory
```

Prize Savings contracts:

```bash
cd zama-prize-savings
npm install
npm run compile
npm test
```

Starknet contracts:

```bash
cd contracts/starknet
scarb test
```

Configuration is supplied through environment variables. Use the sanitized
`.env.example` files and never commit real credentials.

## Repository structure

```text
iwa-web/                React frontend, product flows, and chain adapters
backend/                Coordination service, indexer, and migrations
contracts/starknet/     Cairo circle and STRK20 helper contracts
zama-prize-savings/     Solidity Prize Savings contracts, tests, and deployments
docs/                   Architecture, security, product, and multichain documents
scripts/demo/           Read-only deployment verification tooling
```

Earlier implementation work in `iwa-savings/`, `iwa-circuit/`, `iwa-prover/`,
and `iwa-verifier/` remains preserved while replacement behavior and credential
requirements are verified.

## License

MIT. See [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

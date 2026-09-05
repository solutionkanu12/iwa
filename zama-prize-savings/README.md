# Iwa Prize Savings

**"Save privately. Keep your principal. Earn a chance at shared rewards."**

Iwa Prize Savings is a feature of [Iwa](../README.md), not a separate product.
Inside the Iwa app at `/app/prize-savings`, a saver deposits confidentially
into a shared pool, keeps their principal withdrawable at any time, and earns
a chance at a shared reward through a confidential weighted draw.

The current implementation targets **Ethereum Sepolia** and uses
**Zama's fhEVM** (Fully Homomorphic Encryption) as its confidentiality layer.
This is the first EVM implementation of an Iwa surface; Iwa remains a
multichain product and the Starknet circle track is untouched by it.

---

## How the money and the privacy flow

```
MockUSD (plaintext ERC-20, testnet)
   └─ wrap() → cMockUSD (ERC-7984 confidential token, wrapped by
                      OpenZeppelin ERC7984ERC20Wrapper over @fhevm/solidity)
          └─ setOperator(pool, expiry)
          └─ deposit: pool pulls confidentialTransferFrom, credits the ACTUAL
                      returned encrypted amount
          └─ draw: encrypted cumulative weighted walk over live balances
          └─ claim: encrypted FHE.select credit from the prize reserve
          └─ withdraw / withdrawAll: confidential, principal never locked
```

### What is encrypted

- deposit and withdrawal **amounts** after wrapping (ERC-7984 confidential
  transfers - no plaintext transfer event carries them)
- every participant **balance** (ciphertext; ACL-gated to owner + pool)
- the **prize reserve** and its remainder
- the **draw ticket**
- the **winner index** (encrypted `euint16`, never an address in the clear)
- the **claim payout** (a winner's claim and a non-winner's claim look
  identical on chain)

### What is public, by design

- membership and participant indices (who is in the pool is public; how much
  they hold is not)
- wallet addresses and transaction timing
- contract addresses and the network
- the round state and the owner/admin address
- **the one-time wrap amount from MockUSD to cMockUSD.** This is the only
  amount a saver ever reveals: the underlying ERC-20 transfer is public, so
  the wrap cannot be confidential. Privacy begins once the saver holds the
  confidential token. Stated plainly, not overclaimed.

### Accounting rules

- Only the **actual returned ERC-7984 transfer amount** is ever credited or
  debited - never the requested amount. The pinned OpenZeppelin
  confidential-contracts implementation is all-or-nothing: a shortfall
  transfers 0 and credits 0, and the saver retries with a valid amount.
- The participant total and the prize reserve are separate encrypted values;
  the prize never counts as draw weight.
- `MAX_POOL_TOTAL = 1024` bounds participant draw weight (plaintext
  power-of-two, enabling bounded encrypted randomness); deposits clamp to
  headroom via encrypted `FHE.min` - no plaintext branch, no decryption.
- `MAX_PARTICIPANTS = 16` bounds the draw loop (measured: N=16 fits the
  coprocessor limits with headroom).
- Solvency invariant, verified at every checkpoint:
  `sum(user balances) + prize reserve <= pool's confidential token holdings`.
- No sweep, rescue, redirect, or admin withdrawal function exists anywhere.
  The prize reserve is irrevocable once funded.

### Round lifecycle

`Open → Locked → Drawn → Claimable` (claim performs the final transition).
`DRAW_TIMEOUT = 900` seconds: the owner may draw immediately after locking;
after that, anyone may draw, so a silent owner cannot strand a funded prize.
A ticket that lands at or above the real total selects nobody (`NO_WINNER`):
every claim credits zero and the prize rolls over, untouched.

### Known limitation - accepted for the Sepolia bounty MVP only

Sixteen distinct wallets can fill the participant cap with zero-value deposit
attempts (one slot per wallet, but sixteen wallets fill the pool for free).
Funds, the draw and existing participants are unaffected, and the pool is
redeployable per round - but this acceptance **does not carry to production**.
Any production/mainnet deployment requires a redesigned participant admission
(economic-stake registration, allowlist membership, expiring slots, or a
confidential positive-participation proof). See
[`../SECURITY.md`](../SECURITY.md).

### Additional honest notes

- **F2 - first-funding handle exposure:** on the first prize funding the
  funder retains ACL on the reserve handle for their own just-funded amount
  (the token's standard sender grant); a later funding or claim rewrites the
  handle and removes that access. Verified on the real Sepolia ACL.
- **Donations** to the pool create surplus that is never backing and cannot
  be withdrawn; the `<=` solvency invariant holds.
- **Testnet wallets:** publicly-known test-mnemonic addresses are swept on
  public testnets (observed on Sepolia). Demo wallets must be freshly
  generated.

---

## Deployed contracts (Sepolia)

Network: **Ethereum Sepolia**, chainId **11155111**

| Contract | Address |
|---|---|
| MockUSD (test ERC-20, 6 decimals, open mint) | `0x0041A7b8Bb29cA5D6b1Cb6eFBcaBAc8519075392` |
| CMockUSD (ERC-7984 confidential wrapper) | `0xB87CE72B9083488977372507efD4127e157510c2` |
| IwaPrizeSavings (the pool) | `0x2d1b97F7e1E4845260aBd23017686fBa38006037` |

Constants, verified on chain: `MAX_PARTICIPANTS = 16`,
`MAX_POOL_TOTAL = 1024`, `DRAW_TIMEOUT = 900`.

Zama Sepolia protocol (pinned toolchain):
`@fhevm/solidity 0.11.1`, `@fhevm/hardhat-plugin 0.4.2`,
`@zama-fhe/relayer-sdk 0.4.1`, `@openzeppelin/confidential-contracts 0.5.3`.

No private key or RPC credential belongs in this repository. A `.env` with
`SEPOLIA_RPC_URL` and `SEPOLIA_PRIVATE_KEY` is git-ignored.

---

## Real-network verification (2026-09-05)

Every load-bearing claim below was exercised on actual Sepolia, not the mock:

- S1 encrypted round-trip: store → cross-transaction ACL → owner decrypts 100;
  a second wallet's decrypt is rejected by the real ACL.
- ERC-7984 operator path and `allowTransient` handoff: deposits of 40 then 20
  in separate transactions, both credited and decryptable.
- Wrong-contract and wrong-sender proof bindings: rejected by the real input
  verifier (`InvalidSigner`).
- Claim with no prize: credits zero, no stuck state, full withdrawal works.
- Real Sepolia logs: no plaintext deposit amount, balance, prize or winner.
- F2 first-funding ACL: confirmed on the real ACL.
- N=16 production draw: executes on Sepolia; real coprocessor HCU measured at
  global 8,616,576 / depth 2,818,032 (limits 20M / 5M).

---

## Development

```bash
cd zama-prize-savings
npm install
npm run compile        # hardhat compile
npm test               # full local suite: S1-S6 (159 tests, mock network)
npm run typecheck
npx hardhat test test/sepolia/verify.sepolia.test.ts --network sepolia  # real network
```

The frontend lives in the main app (`iwa-web`, route `/app/prize-savings`),
which has its own test suite and build.
# Iwa Prize Savings — Zama Season 4 Bounty Design Spec

Status: DRAFT (revision 2 — review corrections B1–B5, C1–C7 applied). Capability spike not yet run. No implementation exists yet.
Branch: `feature/zama-prize-savings`
Baseline: `submission/starknet-v1` / tag `iwa-v1-starknet` (frozen, untouched by this work)

Revision 2 changelog: replaced the plaintext-ERC-20 accounting design with the OpenZeppelin ERC-7984 wrapper path (B1); removed the encrypted-total random bound in favour of a plaintext `MAX_POOL_TOTAL` with rejection/rollover (B2); replaced the revert-based claim with an encrypted `FHE.select` credit (B3); added a hard participant cap and `euint16` winner index (B4); removed the weight snapshot (B5); added actual-returned-amount accounting (C1), confidential prize funding and solvency invariant (C2), mandatory ACL re-grant (C3), ticket-disclosure rule (C4), `withdrawAll()` liveness hatch (C5), permissionless draw timeout (C6), and API-name pinning (C7).

## 0. Critical timeline finding (read first)

- Bounty submission deadline: **2026-09-05, 23:59 AOE** (≈ 2026-09-06 11:59 UTC).
- Today: 2026-09-04.
- Usable window: roughly **24–36 hours** for contract + frontend + live deployment + README + ≤3-minute demo + X thread.

This is observed from the Zama announcement, not assumed. A complete "production-quality" submission is unlikely in this window; a working, honestly-scoped one is achievable **only if the S2 gate (Section 16) passes quickly**. If S2 has not passed within 4 hours of starting, the correct outcome is to stop and submit nothing rather than ship something that fails the release gates or misrepresents its own security. That decision is made deliberately at the S2 checkpoint, not at hour 20.

## 1. Bounty requirements (as sourced)

Sourced from `zama.org/post/zama-developer-program-mainnet-season-4` and `community.zama.org/t/zama-developer-program-mainnet-season-4-is-live/4630`. Items not recoverable from fetched content are marked "not confirmed" — re-check the live page before submitting.

- **Challenge:** confidential PoolTogether. Users deposit into a shared pool, a prize is distributed by periodic draws, principal is withdrawable at any time. Deposits, balances and winnings remain encrypted; winner selection stays verifiable onchain.
- **Chain:** Ethereum Sepolia.
- **Prize:** 5,000 cUSDT total, split among up to 3 winners by quality.
- **Deliverables:** functioning contract + frontend; public live website; deposit test ERC-20; encrypted deposits; confidential balances; deposit-weighted winner selection using FHE randomness; claim winnings; withdraw principal with no loss; EIP-712 user decryption; public open-source GitHub repo; README documenting confidentiality design and information leakage; ≤3-minute real-person demo with **no AI-generated voice or video**; X thread tagging @zama with #ZamaDeveloperProgram.
- **Judging:** "production-quality" over proof-of-concept. Exact rubric weighting **not confirmed**.
- **Open question (unresolved):** `community.zama.org/t/does-claim-time-fhe-winner-evaluation-satisfy-the-confidential-pooltogether-bounty/4641` (2026-08-26) asks whether claim-time winner evaluation satisfies the bounty versus draw-time selection. No Zama reply as fetched. This spec builds draw-time selection (Section 7) with a claim-time credit (Section 9), which arguably satisfies both readings.

## 2. Verified Zama API surface

Verified against `docs.zama.org` on 2026-09-04. **Names marked (PIN IN S1) are inconsistent across doc versions and must be confirmed from the installed package before use — do not guess.**

**Solidity:**
- Config: **`ZamaEthereumConfig`** from `@fhevm/solidity/config/ZamaConfig.sol`. Verified: this covers Ethereum including Sepolia; there is no separate Sepolia-only mixin. (Supersedes revision 1's open `SepoliaConfig` question.)
- Library: `@fhevm/solidity/lib/FHE.sol` — types `ebool`, `euint8`…`euint256`, `eint8`…`eint256`, `eaddress`, all `bytes32` handles.
- Arithmetic: `FHE.add`, `FHE.sub`, `FHE.mul`, `FHE.div`, `FHE.rem`, `FHE.neg`.
  - **Verified constraint:** *"Division (FHE.div) and remainder (FHE.rem) operations are currently supported only with plaintext divisors."* No encrypted-divisor modulo exists. This is load-bearing for Section 7.
- Comparison: `FHE.lt`, `FHE.gt`, `FHE.le`, `FHE.ge`, `FHE.eq`, `FHE.ne`, `FHE.min`, `FHE.max`.
- Branching: `FHE.select(cond, ifTrue, ifFalse)`.
  - **Verified constraint:** encrypted booleans cannot be used in `if` or `require`. *"There is only one way to branch from an encrypted path to a non-encrypted path: it requires an off-chain public decryption"* (`makePubliclyDecryptable` then `checkSignatures`, asynchronous, across two transactions). This is load-bearing for Section 9.
- Input: `FHE.fromExternal(externalEuintNN, inputProof)`, `FHE.asEuint64(plaintext)`.
- ACL: `FHE.allow(handle, address)` (persistent), `FHE.allowThis(handle)` (persistent grant to the contract itself), `FHE.allowTransient(handle, address)`, `FHE.isSenderAllowed(handle)`, `FHE.isAllowed(handle, address)`. **Confirmed in S1 from installed `@fhevm/solidity@0.11.1` source:** `allowThis` is the correct spelling (not `allow(h, address(this))`), and the function for optional public/ticket disclosure is **`FHE.makePubliclyDecryptable(handle)`** — `allowForDecryption` does not exist in this library and must not be used anywhere in this spec (see Section 13's C4 ticket-disclosure rule).
- Randomness: `FHE.randEbool()`, `FHE.randEuint8/16/32/64/128/256()`, bounded `FHE.randEuintNN(upperBound)` where the bound is a **power of two**, yielding `[0, upperBound-1]`. Must run in a state-changing transaction (not `eth_call`); CSPRNG-backed, result encrypted.

**HCU limits (verified — these govern Section 7's participant cap):**
- **20,000,000 HCU per transaction** (global, parallelisable work).
- **5,000,000 HCU per transaction sequential depth** (operations that must run in order). This is the binding limit for a cumulative-sum walk.
- euint64 costs: `FHE.add` non-scalar **162,000** / scalar 133,000; `FHE.lt` non-scalar **146,000**; `FHE.select` **55,000**. `eaddress` is internally euint160 and costs materially more — hence Section 7's `euint16` winner index.

**Confidential token (OpenZeppelin):**
- `ERC7984` — `@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol`.
- `ERC7984ERC20Wrapper` — wraps a plaintext ERC-20 into a confidential ERC-7984 token. `function wrap(address to, uint256 amount) public virtual`, with a corresponding unwrap.
- `confidentialTransferFrom(address from, address to, euint64 amount) returns (euint64)` — **returns the amount actually transferred**, which is `min(amount, balance)`; it does not revert on insufficient balance. This is load-bearing for Section 6/C1.
- `setOperator(address operator, uint256 expirationTimestamp)` — replaces ERC-20 allowances. Operators can move tokens until expiry but **cannot decrypt** balances.

**Frontend SDK (PIN IN S1):** both `@zama-fhe/sdk` (per current docs, `zama-ai/sdk`) and `@zama-fhe/relayer-sdk` (`zama-ai/relayer-sdk`) exist on npm. Encrypted-input pattern is approximately `createEncryptedInput(contract, user)` → `.add64(v)` / `.addUint64(v)` → `.encrypt()` / `.build()` → `{ handles, inputProof }`. User decryption is `userDecrypt` behind an EIP-712 authorization scoped to contract + handle + expiry, threshold-decrypted by the KMS and re-encrypted to an ephemeral user key. **Exact package name and function names must be read off the installed package in S1 before any frontend code is written.**

**Do not import or call anything not confirmed above or pinned in S1.**

## 3. Product scope

### In scope
- One confidential prize pool on Sepolia, single round.
- `MockUSD` test ERC-20 → wrapped to a confidential ERC-7984 token → deposited into the pool with an **encrypted** amount.
- Round lifecycle: `Open -> Locked -> Drawn -> Claimable`.
- Prize from an **operator-funded reserve held in the confidential token** (Section 8). No external yield integration.
- Deposit-weighted winner selection using FHE randomness over live encrypted balances, never decrypting an individual balance.
- Encrypted claim credit (Section 9). Withdraw and `withdrawAll` (Section 10).
- EIP-712 user decryption of one's own balance.
- **Standalone minimal dapp inside `zama-prize-savings/`** — see Section 12.
- README with confidentiality design and leakage analysis; ≤3-minute demo; X thread.

### Non-goals
- Real yield strategy integration (Aave/Compound). Funded reserve instead, disclosed in the README as a known simplification.
- Multiple pools, multiple assets, multi-winner rounds, recurring/automated rounds, keeper infrastructure.
- **Any change to `iwa-web`** — no router edits, no design-system edits, no new screens in the production app (Section 12, scope cut). Governance, fee switches, tokenomics, upgradability/proxies.
- Any change to `iwa-savings/`, `iwa-circuit/`, `iwa-prover/`, `iwa-verifier/`, Circle contracts, or the STRK20/Starknet track.
- Starknet V2, Celo, Nimiq, Portable Trust Credential, analytics, embedded accounts.

### 3.1 Relationship to Iwa Circles
Iwa Prize Savings is a separate product surface and a separate contract. It does not read, write, or depend on Iwa Circle state. Circle payout order remains fixed, immutable and deterministic exactly as `AGENTS.md` requires; this work does not touch that code path. Any future interoperation is a separate, explicitly-approved design.

## 4. Contract architecture

```
MockUSD.sol                     plaintext test ERC-20, open mint (testnet faucet only)
  └─ ERC7984ERC20Wrapper        OpenZeppelin: wrap(to, amount) / unwrap
       └─ cMockUSD              confidential ERC-7984 token

IwaPrizeSavings.sol             is ZamaEthereumConfig, Ownable
  deposit(externalEuint64, bytes inputProof)   pulls via confidentialTransferFrom, credits ACTUAL returned
  withdraw(externalEuint64, bytes inputProof)  FHE.min-clamped, credits/debits ACTUAL returned
  withdrawAll()                                no encrypted input — liveness hatch (C5)
  fundPrize(externalEuint64, bytes)            operator funds prize in cMockUSD (C2)
  lockRound()                                  owner; freezes participation
  draw()                                       owner, OR anyone after lockTime + DRAW_TIMEOUT (C6)
  claim()                                      any participant; encrypted credit, never reverts on loss
  confidentialBalanceOf(address) -> euint64    ACL-gated handle
  roundState() -> enum                         plaintext
  MAX_PARTICIPANTS = 16                        hard cap (B4)
  MAX_POOL_TOTAL   = 2^k plaintext             hard cap enabling bounded randomness (B2)
```

Single `Ownable` admin (not `Ownable2Step` — testnet, single deployer; safe cut). No upgradability, no proxy, **no sweep/rescue function of any kind** (C2). Admin powers are limited to `lockRound()` and *timely* `draw()`; after `DRAW_TIMEOUT` the draw is permissionless so a silent operator cannot strand a funded prize.

## 5. Encrypted state model

Per user:
- `mapping(address => euint64) confidentialBalance` — the user's principal, plus any prize credited by `claim()`. ACL: `allow(handle, user)` and `allowThis(handle)` **re-granted on every write** (C3).
- `mapping(address => uint16) participantIndex` / `address[] participants` — **plaintext** index registry, capped at `MAX_PARTICIPANTS`. Membership is public; balances are not.
- `mapping(uint256 => mapping(address => bool)) claimed` — per-round, **per-user** claim flag (B3).

Pool level:
- `euint64 confidentialTotal` — encrypted sum of all principal, maintained incrementally.
- `euint64 prizeReserve` — encrypted prize held in cMockUSD (C2).
- `euint16 winnerIndex` — encrypted winner, set by `draw()` (B4).
- `euint64 drawTicket` — the round's random ticket.
- Plaintext: `roundId`, `RoundState`, `lockTimestamp`, `MAX_POOL_TOTAL`, `MAX_PARTICIPANTS`, `DRAW_TIMEOUT`, `prizeRolledOver` flag.

**No plaintext per-user balance is ever stored, returned, or emitted.** There is deliberately no `encryptedWeight` snapshot — see Section 7.4.

### 5.1 ACL discipline (C3)
Every FHE operation produces a **new handle**. Any handle written to storage must be re-authorised in the same transaction:

```solidity
confidentialBalance[user] = newHandle;
FHE.allowThis(newHandle);          // (PIN IN S1) contract must reuse it in a LATER tx
FHE.allow(newHandle, user);        // user must user-decrypt it client-side
```

Omitting `allowThis` on any write path means the contract cannot operate on that balance in any subsequent transaction — **the user's principal becomes permanently frozen**. This is a principal-loss vector, not a nuisance, and is why P5 tests the full cycle across *separate transactions* rather than within one.

## 6. Deposit flow (B1, C1)

Encrypted amounts cannot move a plaintext ERC-20 — a contract cannot `transferFrom` an encrypted value, and branching encrypted→plaintext requires asynchronous off-chain decryption (Section 2). The deposit asset is therefore confidential end-to-end:

1. **One-time, off-pool:** user calls `MockUSD.approve(wrapper, amount)` then `wrapper.wrap(user, amount)`. This wrap amount is **public** — it is the only amount the user ever reveals, and it is a one-time funding action, not a per-deposit disclosure.
2. **One-time:** user calls `cMockUSD.setOperator(pool, expiry)`, authorising the pool to move confidential tokens on their behalf. The operator cannot decrypt their balance.
3. **Per deposit:** user builds an encrypted input client-side and calls `deposit(externalEuint64 amount, bytes inputProof)`.
4. Contract clamps against the pool cap so it never exceeds `MAX_POOL_TOTAL` without branching on an encrypted condition:
   ```solidity
   euint64 headroom  = FHE.sub(FHE.asEuint64(MAX_POOL_TOTAL), confidentialTotal);
   euint64 requested = FHE.fromExternal(amount, inputProof);
   euint64 toPull    = FHE.min(requested, headroom);
   ```
5. Contract pulls and **credits the actual returned amount, never the requested amount** (C1):
   ```solidity
   euint64 actual = cMockUSD.confidentialTransferFrom(msg.sender, address(this), toPull);
   confidentialBalance[msg.sender] = FHE.add(confidentialBalance[msg.sender], actual);
   confidentialTotal               = FHE.add(confidentialTotal, actual);
   // + ACL re-grant per 5.1
   ```
   `confidentialTransferFrom` moves `min(amount, balance)` and **does not revert** on insufficient funds. Crediting `toPull` instead of `actual` would let any user request more than they hold and mint themselves unbacked pool shares — a fund-draining exploit. This is mandatory, not defensive.
6. First-time depositors are appended to `participants` if `participants.length < MAX_PARTICIPANTS`; otherwise the deposit reverts in plaintext with a clear "pool full" error (membership is public, so this reveals nothing).

## 7. Draw and randomness (B2, B4)

### 7.1 Bounded ticket without encrypted division
The random ticket cannot be bounded by the encrypted total: `FHE.randEuintNN` takes a **plaintext power-of-two** bound, and `FHE.rem` with an encrypted divisor does not exist (Section 2). Instead:

- `MAX_POOL_TOTAL` is a **plaintext power of two**, enforced as a deposit-time cap (Section 6.4).
- `euint64 drawTicket = FHE.randEuint64(MAX_POOL_TOTAL);` — uniform over `[0, MAX_POOL_TOTAL)`.

### 7.2 Weighted selection by encrypted cumulative walk
For each participant `i` in the plaintext `participants` array, over their **live** confidential balance:

```
running = 0
winnerIndex = 0
found = false
for i in 0..N-1:
    lower   = running
    running = FHE.add(running, confidentialBalance[participants[i]])
    inRange = FHE.and(FHE.le(lower, ticket), FHE.lt(ticket, running))
    winnerIndex = FHE.select(inRange, FHE.asEuint16(i), winnerIndex)
    found       = FHE.or(found, inRange)
```

Selection probability is `balance_i / MAX_POOL_TOTAL` — correctly deposit-weighted among participants, using only `FHE.add/le/lt/and/or/select`. No individual balance is decrypted at any point.

### 7.3 Rejection and rollover
Because the ticket is drawn over `MAX_POOL_TOTAL` rather than the (encrypted) actual total, a ticket landing above the real total selects nobody: `P(no winner) = 1 - total/MAX_POOL_TOTAL`. That case is **not** an error — the prize **rolls over** to the next round, which is a legitimate PoolTogether-shaped behaviour. `found` is encrypted, so no branch is taken on it; `claim()` naturally credits zero to everyone when nobody was selected (Section 9), and the reserve is untouched. Keep `MAX_POOL_TOTAL` tight relative to expected deposits so rollover stays uncommon, and state the rollover probability honestly in the README.

### 7.4 No weight snapshot (B5)
Revision 1 froze an `encryptedWeight` per user at lock time. That is removed: snapshotting N encrypted balances is itself an O(N) FHE loop consuming the same scarce HCU budget, and it buys nothing. The draw reads **live** balances. A user who withdraws before the draw simply has reduced or zero weight — the same model PoolTogether uses, and honest: you withdrew, you are not in the pool. This also removes any interaction between withdrawal and draw integrity.

### 7.5 Participant cap (B4) — why 16
Per participant the walk costs roughly `add(162,000) + le(146,000) + lt(146,000) + select(55,000) ≈ 510,000` HCU, and the cumulative-`add` chain is inherently **sequential**.

- Against the **5,000,000 sequential-depth** limit: if only the `add` chain serialises, ~30 participants fit; if the comparisons and selects also serialise, **~10 fit**.
- Against the **20,000,000 global** limit: 16 participants ≈ 8.2M HCU, comfortable.

The true figure depends on how much the coprocessor parallelises, which is why **S2 measures it before any pool code is written**. `MAX_PARTICIPANTS = 16` is the starting value and **must not be raised** unless S2 measures a safe higher number. If S2 shows 16 does not fit, drop to 8. Without a hard cap, anyone can join with dust deposits until `draw()` permanently exceeds the limit — bricking the pool and stranding the prize. Chunked multi-transaction draws are the documented scaling path, out of scope here.

### 7.6 Draw authorisation (C6)
`draw()` is callable by the owner from `Locked`, and by **anyone** once `block.timestamp >= lockTimestamp + DRAW_TIMEOUT`. It is callable **once per round**, enforced by the state machine. The admin cannot see balances or the ticket, so choosing *when* to draw grants no ability to pick a winner; the timeout removes the only real admin lever, which is refusing to draw at all.

## 8. Prize reserve (C2)

`fundPrize(externalEuint64 amount, bytes inputProof)` pulls **cMockUSD** — the same confidential token as deposits — crediting the actual returned amount per C1. Funding the prize in plaintext ERC-20 while crediting winners in encrypted balance would leave the credit unbacked and the final withdrawer unable to exit.

**Solvency invariant:** `sum(confidentialBalance) + unclaimed prizeReserve ≤ pool's cMockUSD balance`, maintained by only ever crediting actual transferred amounts (C1) and never crediting a prize that was not funded.

The prize is **irrevocable**. There is no sweep, rescue, skim, or emergency-withdraw function anywhere in the contract, and P6 asserts none exists. Once funded, the operator cannot recover it; it is distributed or it rolls over.

Note for the README: on testnet `MockUSD` has open mint, so a funded prize is not a real economic commitment. State this rather than implying otherwise.

## 9. Claim flow (B3)

A non-winner cannot be rejected with a `require` — `ebool` cannot gate a revert, and forcing the encrypted→plaintext branch would need asynchronous public decryption that **publicly deanonymises the winner** (Section 2). Claim is therefore a pull that credits an encrypted amount:

```solidity
function claim() external {
    require(roundState == RoundState.Claimable, "not claimable");
    require(!claimed[roundId][msg.sender], "already claimed");
    claimed[roundId][msg.sender] = true;                       // per-user, per-round

    ebool   isWinner = FHE.eq(winnerIndex, participantIndex[msg.sender]);  // scalar compare
    euint64 payout   = FHE.select(isWinner, prizeReserve, FHE.asEuint64(0));

    confidentialBalance[msg.sender] = FHE.add(confidentialBalance[msg.sender], payout);
    prizeReserve                    = FHE.sub(prizeReserve, payout);
    // + ACL re-grant per 5.1
}
```

Properties:
- Fully **synchronous** — no oracle round trip, no async decryption.
- The winner is **never revealed**. Every claimer's transaction looks identical; only their own encrypted balance changes, and only they can decrypt it.
- Non-winners are credited zero and do not revert. This closes revision 1's unsolvable "clean revert that doesn't leak" requirement by removing the need for it.
- Comparison is against a **plaintext** `participantIndex` (scalar `FHE.eq` on `euint16`), far cheaper than an `eaddress`/euint160 comparison.
- `claimed[roundId][msg.sender]` is per-user, so one participant claiming cannot block another. A global per-round flag (revision 1) would have been a griefing vector.
- If nobody was selected (Section 7.3), everyone is credited zero and `prizeReserve` survives intact for rollover.

## 10. Withdrawal flow (C1, C5)

`withdraw(externalEuint64 amount, bytes inputProof)`:
```solidity
euint64 requested = FHE.fromExternal(amount, inputProof);
euint64 toSend    = FHE.min(requested, confidentialBalance[msg.sender]);   // clamp, no branch
euint64 actual    = cMockUSD.confidentialTransfer(msg.sender, toSend);     // ACTUAL returned
confidentialBalance[msg.sender] = FHE.sub(confidentialBalance[msg.sender], actual);
confidentialTotal               = FHE.sub(confidentialTotal, actual);
// + ACL re-grant per 5.1
```
`FHE.min` clamps in one operation, so an over-withdraw silently becomes a withdrawal of the full balance rather than an underflow or a leaking revert. Debiting `actual` rather than `toSend` keeps accounting exact under C1.

Withdrawal is available in **every** round state, including `Locked` and `Claimable`. There is no lockup, no fee, and no path that reduces principal other than the user's own withdrawal.

**`withdrawAll()` (C5)** takes no encrypted input and no input proof — it sends the caller's entire confidential balance. Constructing an `externalEuint64` requires the SDK and relayer; if that infrastructure is unavailable, users would otherwise be unable to withdraw at all. This escape hatch removes a custody-shaped liveness risk for a few lines of code and must not be cut.

## 11. Decryption model

- **Self-balance:** the wallet reads `confidentialBalanceOf(self)` for a handle, then runs the SDK user-decrypt flow — EIP-712 authorization scoped to contract + handle + expiry, threshold-decrypted by the KMS, re-encrypted to an ephemeral user key, decrypted locally. Never sent to any Iwa backend.
- **Claim result:** the user re-decrypts their own balance after claiming. A larger balance means they won. Nothing is published on chain that says so.
- No backend or indexer touches a ciphertext handle or any key material in this MVP.

## 12. Frontend architecture (scope cut)

A **standalone minimal dapp inside `zama-prize-savings/`**. It does **not** touch `iwa-web`: no router edits, no design-system changes, no new production screens, no shared test-suite impact.

Rationale: integrating into `iwa-web` would cost router wiring, vitest suites, copy guards and design-system conformance — hours of work worth zero bounty points — while putting regression risk on the frozen production frontend. If the bounty submission later graduates into the product, integration is a separate, explicitly-approved piece of work.

Surface: connect wallet → wrap MockUSD → `setOperator` → deposit → decrypt own balance → round state → claim → withdraw / withdrawAll. All Zama SDK calls sit behind one thin typed wrapper module so the UI never touches the raw SDK.

## 13. Threat model and information leakage analysis

To be finalised in the README against **observed** Etherscan behaviour, not intent.

**Public by design:**
- Contract address, ABI, `roundId`, `RoundState`, timestamps, `MAX_POOL_TOTAL`, `MAX_PARTICIPANTS`.
- **Participant set** — membership is a plaintext array. Who is in the pool is public; how much they hold is not.
- The one-time `wrap()` amount per user (Section 6.1). This is the only amount a user discloses, and it is an upper bound on their deposit, not their balance.
- That a given address called `deposit`, `claim`, or `withdraw`, and when.
- Optionally the post-round `drawTicket` (see C4 rule below).

**Private, ACL-enforced:**
- Every individual `confidentialBalance`, at rest and via `confidentialBalanceOf`.
- Every deposit and withdrawal **amount** (moved as confidential ERC-7984 transfers — no plaintext `Transfer` event carries them). Revision 1's headline leak is eliminated, not merely disclosed.
- `confidentialTotal`, `prizeReserve` remainder, `winnerIndex`.
- **Who won** — permanently, unless the winner chooses to reveal it.

**C4 — ticket disclosure rule (mandatory):** the `drawTicket` may be made publicly decryptable for draw auditability **only while the winner's identity remains private**. Publishing both the ticket and the winner's identity leaks the winner's cumulative-weight interval (`cumsum[i-1] ≤ ticket < cumsum[i]`), bounding their balance, and the bound tightens across rounds. Under Section 9 the winner is never revealed, so ticket disclosure is safe — but if any future change reveals winners, ticket disclosure must be removed in the same change. Never both.

**Residual, disclosed:**
- Timing correlation: deposit/claim/withdraw are timestamped, address-linked public actions even though amounts are not.
- Participation itself is public (see above).
- A winner who withdraws an unusually large amount shortly after a round may be inferable by an observer correlating the wrap amounts and timing. Amounts stay encrypted, so this is weak, but it should be stated rather than claimed impossible.
- Zama protocol trust assumptions: the KMS threshold committee (13 nodes, 2/3 majority) could in principle decrypt; coprocessor/relayer availability is a liveness dependency (mitigated for withdrawal by `withdrawAll`, Section 10).

## 14. Deployment model

Sepolia only. Hardhat deployment; addresses recorded in a checked-in deployments file. Frontend served from a public URL distinct from the main Iwa site. No mainnet deployment and no real-asset handling at any point. A dedicated Sepolia-only key, never the production Iwa deployer key, never committed.

## 15. Demo plan

One continuous real-person recording, ≤3 minutes, no AI-generated voice or video. Script: wrap MockUSD → `setOperator` → deposit → show the balance is an opaque handle on Etherscan → decrypt it in the UI via EIP-712 → lock and draw → two participants both call `claim()` (identical-looking transactions) → each decrypts their own balance, revealing who won *to themselves only* → withdraw principal to prove no loss. Recorded only after the P5 full cycle is green.

## 16. Release gates

1. **S1, S2, S3 all pass** (plan Phase 0). S2 is the architecture-killing gate: if an 8-participant weighted walk cannot fit the sequential-depth budget, stop and report.
2. Full `wrap → deposit → lock → draw → claim → withdraw` cycle green on Sepolia **across separate transactions** (proves ACL persistence, C3).
3. Red-team suite (plan P6) with no Critical/High open. Blocking rows: over-withdraw, double withdraw, double claim, requested-vs-actual exploit, ACL freeze, admin sweep absence, draw DoS at cap, winner substitution, randomness misuse, non-winner claim behaviour, encrypted/event/frontend leakage.
4. README leakage analysis reflects observed behaviour.
5. No secrets in the repo.
6. Demo and X thread only after 1–5 are green.

If the timeline in Section 0 makes these infeasible, the honest report is "could not complete a judged-quality submission in time" — that outcome is preferable to a submission that fails gate 3 or misrepresents gate 4.

# Iwa Prize Savings — Zama Season 4 Bounty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. TDD: failing test first, expected failure, minimal implementation, passing command, regression, STOP for review.
> **No commit, push, or deploy steps exist in this plan.** Commits, pushes and deploys are approved separately.
> **Time-critical:** deadline 2026-09-05 23:59 AOE. **S2 is a hard architecture gate — if it fails, STOP.** If S2 has not passed within 4 hours of starting, stop and submit nothing rather than burn the remaining window.

**Spec:** `docs/superpowers/specs/2026-09-04-zama-prize-savings-design.md` (revision 2)
**Branch:** `feature/zama-prize-savings` (created from `main` at `5ec9e59554a6ca7b6af7388148830dfb661b6c8e`)
**All work lives in `zama-prize-savings/`.** No file under `iwa-web/`, `iwa-savings/`, `iwa-circuit/`, `iwa-prover/`, `iwa-verifier/`, or any Circle contract is touched by any task in this plan.

Revision 2 reorders the spike to front-load architectural risk (the weighted draw, not the deposit) and folds in review corrections B1–B5 and C1–C7.

---

## Phase 0 — Spike (HARD GATE: S1, S2 and S3 must all pass before P1)

### Task S1: toolchain + encrypted store/read/user-decrypt round-trip

- Files: `zama-prize-savings/package.json` (new), `zama-prize-savings/hardhat.config.ts` (new), `zama-prize-savings/contracts/spike/SpikeRoundTrip.sol` (new), `zama-prize-savings/test/spike/roundTrip.test.ts` (new)
- Interfaces: `contract SpikeRoundTrip is ZamaEthereumConfig` with `store(externalEuint64 v, bytes calldata proof)` and `get() external view returns (euint64)`. On store: `FHE.fromExternal` → write → `allowThis` + `allow(handle, msg.sender)`.
- Failing test: store an encrypted `100`; then **in a separate transaction** read the handle and user-decrypt it via the EIP-712 flow, asserting exactly `100`; assert a second wallet cannot decrypt that handle.
- Expected failure: missing contract/functions; then, if `allowThis` is omitted, the separate-transaction read fails — which is the point of the test (spec 5.1, C3).
- Minimal implementation: the two functions plus correct ACL grants.
- Passing command: `cd zama-prize-savings && npx hardhat test test/spike/roundTrip.test.ts --network sepolia`
- Expected pass: owner decrypts `100`; non-owner rejected.
- Regression command: n/a (first task).
- Review checkpoint: **PIN AND RECORD INTO SPEC §2 (C7):** exact SDK package name (`@zama-fhe/sdk` vs `@zama-fhe/relayer-sdk`), exact encrypted-input function names, exact user-decrypt/EIP-712 function names, exact ACL helper spellings (`allowThis` vs `allow(h, address(this))`, `allowForDecryption` vs `makePubliclyDecryptable`), and that `ZamaEthereumConfig` from `@fhevm/solidity/config/ZamaConfig.sol` compiles and works on Sepolia. Do not guess any of these from docs — read them off the installed package.

### Task S2: GO/NO-GO — weighted random draw under HCU limits

**This is the gate that can kill the architecture. It runs before any pool code.**

- Files: `zama-prize-savings/contracts/spike/SpikeDraw.sol` (new), `zama-prize-savings/test/spike/draw.test.ts` (new)
- Interfaces: `drawWithN(uint16 n)` performing spec §7.2's walk over `n` hardcoded encrypted weights: `ticket = FHE.randEuint64(MAX_POOL_TOTAL)` with a **plaintext power-of-two** bound, cumulative `FHE.add`, `FHE.le`/`FHE.lt` range test, `FHE.select` into a `euint16 winnerIndex`. No `eaddress`. No `FHE.rem`. No encrypted bound.
- Failing test: run at **N=8 first, then N=16**. Assert the transaction succeeds (does not exceed HCU or sequential-depth limits); assert the random is generated in a state-changing transaction and differs across calls; decrypt `winnerIndex` in the harness and assert it falls in the correct weighted bucket for a known weight set; assert a ticket landing above the total selects nobody and leaves the reserve untouched (rollover path, spec §7.3).
- Expected failure: HCU/sequential-depth revert at N=16, or a wrong bucket, until the walk is correctly formulated.
- Minimal implementation: the walk only — no pool, no token, no state machine.
- Passing command: `npx hardhat test test/spike/draw.test.ts --network sepolia`
- Expected pass: N=8 and N=16 both execute within limits, with correct bucket selection.
- Regression command: `npx hardhat test test/spike/`
- Review checkpoint: **RECORD MEASURED HCU AND SEQUENTIAL DEPTH PER PARTICIPANT.** Set `MAX_PARTICIPANTS` from the measurement: 16 only if N=16 fits with headroom; otherwise drop to 8. **Never raise above the measured safe value.** If N=8 cannot fit the 5,000,000 sequential-depth budget, the draw-time architecture is dead — **STOP AND REPORT**, do not proceed to S3 or P1.

### Task S3: ERC-7984 wrapper flow and actual-returned-amount accounting

- Files: `zama-prize-savings/contracts/MockUSD.sol` (new), `zama-prize-savings/contracts/spike/SpikePool.sol` (new), `zama-prize-savings/test/spike/wrapper.test.ts` (new)
- Interfaces: `MockUSD` (OpenZeppelin `ERC20` + open `mint`); an `ERC7984ERC20Wrapper` instance over it; `SpikePool.pullFrom(externalEuint64, bytes)` calling `confidentialTransferFrom` and crediting **the returned `euint64`**.
- Failing test: wrap MockUSD → `setOperator(pool, expiry)` → pull an encrypted amount → decrypt the pool-side credit and assert it equals the amount actually moved. **Then the exploit test (C1):** a user holding 50 requests a pull of 100; assert the credited balance is **50, not 100**. Assert the pool cannot pull without an operator authorization, and that an expired operator authorization fails.
- Expected failure: the exploit test fails (credits 100) if the implementation credits the requested amount — this is exactly the fund-draining bug the test exists to catch.
- Minimal implementation: wrapper wiring plus returned-value crediting.
- Passing command: `npx hardhat test test/spike/wrapper.test.ts --network sepolia`
- Expected pass: all green, including the 50-not-100 assertion.
- Regression command: `npx hardhat test test/spike/`
- Review checkpoint: **HARD GATE — S1, S2, S3 all green.** Confirm the confidential transfer path emits no plaintext amount in any event. Only then start P1.

---

## Phase 1 — Pool contract

### Task P1: state machine, deposit, withdraw, withdrawAll

- Files: `zama-prize-savings/contracts/IwaPrizeSavings.sol` (new), `zama-prize-savings/test/pool.depositWithdraw.test.ts` (new)
- Interfaces: `RoundState { Open, Locked, Drawn, Claimable }`, `Ownable` (not `Ownable2Step`); `deposit(externalEuint64, bytes)` per spec §6; `withdraw(externalEuint64, bytes)` per spec §10; `withdrawAll()` with **no encrypted input** (C5); `confidentialBalanceOf(address) -> euint64`; participant registry capped at `MAX_PARTICIPANTS`.
- Failing test: deposit credits the actual returned amount (C1); deposit clamps to `MAX_POOL_TOTAL` headroom via `FHE.min` without reverting; over-withdraw of more than balance sends exactly the balance and leaves it at zero, never underflowing; **deposit then withdraw in a separate transaction** returns the full principal (proves ACL persistence, C3); `withdrawAll()` works with no SDK-built input; withdrawal succeeds in every round state including `Locked` and `Claimable`; the 17th distinct depositor reverts with a plaintext "pool full".
- Expected failure: missing functions; then the separate-transaction case fails if any write path omits `allowThis`.
- Minimal implementation: state machine, deposit, withdraw, withdrawAll, ACL re-grant on every write.
- Passing command: `npx hardhat test test/pool.depositWithdraw.test.ts --network sepolia`
- Expected pass: green.
- Regression command: `npx hardhat test`
- Review checkpoint: invariants "principal cannot be lost", "withdraw cannot exceed balance", "withdrawal never blocked" verified, not assumed.

### Task P2: prize funding and caps

- Files: `zama-prize-savings/contracts/IwaPrizeSavings.sol` (edit), `zama-prize-savings/test/pool.prizeFunding.test.ts` (new)
- Interfaces: `fundPrize(externalEuint64, bytes)` pulling **cMockUSD** (C2), crediting the actual returned amount; `MAX_POOL_TOTAL` and `MAX_PARTICIPANTS` as immutable plaintext constants; `lockRound()` owner-only.
- Failing test: only owner funds; the prize is held in the confidential token, not plaintext ERC-20; funding after `Locked` reverts; **no function exists that lets the owner withdraw, sweep, rescue or redirect the reserve or any user balance** — assert by ABI inspection, not just by behaviour; solvency holds after funding (spec §8).
- Expected failure: missing function; sweep-absence assertion fails if any rescue helper was added.
- Minimal implementation: confidential prize funding and constants.
- Passing command: `npx hardhat test test/pool.prizeFunding.test.ts --network sepolia`
- Expected pass: green.
- Regression command: `npx hardhat test`
- Review checkpoint: solvency invariant and irrevocability confirmed.

### Task P3: draw

- Files: `zama-prize-savings/contracts/IwaPrizeSavings.sol` (edit), `zama-prize-savings/test/pool.draw.test.ts` (new)
- Interfaces: `draw()` per spec §7 — S2's verified walk over **live** balances (no snapshot, B5), `euint16 winnerIndex`, owner-callable from `Locked`, **permissionless after `lockTimestamp + DRAW_TIMEOUT`** (C6).
- Failing test: draw executes within HCU limits at the measured `MAX_PARTICIPANTS`; cannot be called twice for the same round; cannot be called before `Locked`; a non-owner call before the timeout reverts, and the same call after the timeout succeeds (C6); a user who withdrew before the draw has correspondingly reduced weight (B5); no event or return value contains a plaintext balance, winner, or ticket; the rollover path leaves `prizeReserve` intact when no participant is selected.
- Expected failure: reverts / missing function.
- Minimal implementation: the draw, reusing S2's exact formulation.
- Passing command: `npx hardhat test test/pool.draw.test.ts --network sepolia`
- Expected pass: green.
- Regression command: `npx hardhat test`
- Review checkpoint: "winner selection never uses plaintext balances", "draw cannot manipulate weighting", "no fake randomness" verified.

### Task P4: encrypted claim credit

- Files: `zama-prize-savings/contracts/IwaPrizeSavings.sol` (edit), `zama-prize-savings/test/pool.claim.test.ts` (new)
- Interfaces: `claim()` exactly per spec §9 — `FHE.eq(winnerIndex, participantIndex[msg.sender])` scalar compare, `FHE.select` payout or zero, credited to the caller's confidential balance, `claimed[roundId][msg.sender]` per-user flag.
- Failing test: the winner's decrypted balance increases by exactly the prize; a non-winner's balance increases by exactly zero **and their transaction does not revert**; neither transaction's logs, return data, or revert reason distinguishes winner from non-winner; a second claim by the same address reverts on the per-user flag; one participant claiming does not prevent any other participant from claiming (per-user, not global — griefing check); claim only callable in `Claimable`; **no `require`/`if` anywhere branches on an `ebool`** (code inspection assertion).
- Expected failure: missing function; the non-winner case fails if the implementation reverts on loss.
- Minimal implementation: the claim function as specified.
- Passing command: `npx hardhat test test/pool.claim.test.ts --network sepolia`
- Expected pass: green.
- Regression command: `npx hardhat test`
- Review checkpoint: "claim cannot be replayed", "same prize cannot be claimed twice", "winner never publicly revealed" verified.

---

## Phase 2 — Verification

### Task P5: full cycle across separate transactions

- Files: `zama-prize-savings/test/pool.fullCycle.test.ts` (new)
- Interfaces: none new.
- Failing test: two participants run `wrap → setOperator → deposit → lockRound → draw → claim (both) → withdraw`, **each step in its own transaction**, asserting: both claims succeed and look identical externally; exactly one balance grew by the prize; both principals are fully withdrawable afterwards; the pool's confidential token balance reconciles with the sum of credited balances (solvency, spec §8).
- Expected failure: integration gaps — most likely a missing ACL re-grant surfacing only across transaction boundaries (C3).
- Minimal implementation: test-only; fixes land in the relevant P-task's file.
- Passing command: `npx hardhat test test/pool.fullCycle.test.ts --network sepolia`
- Expected pass: green.
- Regression command: `npx hardhat test`
- Review checkpoint: release gate 2 (spec §16).

### Task P6: red-team suite

- Files: `zama-prize-savings/test/pool.redTeam.test.ts` (new)
- Interfaces: none new.
- Failing test — one assertion per mandatory row, **Critical/High findings block submission**:
  - over-withdraw (request > balance sends exactly balance, no underflow)
  - double withdraw (second withdrawal of an emptied balance sends zero)
  - double claim (per-user flag holds)
  - **requested-vs-actual transfer exploit** (request 100 holding 50 credits 50 — C1)
  - **ACL loss / frozen funds** (every write path survives a separate-transaction read and withdrawal — C3)
  - **admin sweep** (no sweep/rescue/redirect function exists in the ABI; owner cannot move user funds or a funded prize)
  - **draw DoS at participant cap** (filling to `MAX_PARTICIPANTS` with dust still leaves `draw()` executable within HCU limits; the 17th depositor is rejected)
  - winner substitution (no caller can influence `winnerIndex`; claiming with a spoofed or non-participant address credits zero)
  - randomness misuse (ticket is not predictable or replayable across rounds; not obtainable via `eth_call`; no encrypted bound, no `FHE.rem`)
  - non-winner claim behaviour (credits zero, does not revert, is externally indistinguishable)
  - encrypted data / event / frontend leakage (no plaintext balance, winner or ticket in any event, return value, revert reason or view; confidential transfers emit no plaintext amounts)
  - access-control bypass and unauthorized draw (non-owner before timeout rejected; after timeout permitted — C6)
  - replay / stale or malformed input proof, wrong chain, wrong contract (protocol-bound by construction — assert rejection)
  - reentrancy on any external token call preceding a state update
  - principal-loss sweep: assert **no** code path reduces a balance except the owner's own withdrawal
- Expected failure: each row fails until its protection exists; most should already hold from P1–P4, and this suite's job is to prove it hostilely.
- Minimal implementation: fixes only where a real gap is found.
- Passing command: `npx hardhat test test/pool.redTeam.test.ts --network sepolia`
- Expected pass: every row green.
- Regression command: `npx hardhat test`
- Review checkpoint: **release gate 3.** Any row that cannot be closed is reported explicitly, never hidden.

---

## Phase 3 — Deploy and standalone frontend

### Task P7: Sepolia deployment + standalone dapp

- Files: `zama-prize-savings/scripts/deploy.ts` (new), `zama-prize-savings/deployments.json` (new), `zama-prize-savings/app/` (new — standalone minimal dapp), `zama-prize-savings/app/lib/zama.ts` (new — the single SDK wrapper)
- **Explicitly not touched:** `iwa-web/` router, design system, screens, tests, copy (spec §12 scope cut).
- Interfaces: connect wallet → wrap MockUSD → `setOperator` → deposit → decrypt own balance → round state → claim → withdraw / withdrawAll. All SDK calls behind `app/lib/zama.ts`.
- Failing test: manual walkthrough against deployed Sepolia contracts — the full cycle works end-to-end in the browser; the UI never renders another user's balance; no decrypted value is written to the console or any log; the claim button looks and behaves identically for winners and non-winners before and after clicking.
- Expected failure: n/a (manual gate).
- Minimal implementation: minimal UI, no design system, no framework ceremony.
- Passing command: manual walkthrough, recorded in the README.
- Regression command: `npx hardhat test` still green against the deployed addresses.
- Review checkpoint: frontend leakage row closed or explicitly documented as open.

### Task P8: README, demo, X thread

- Files: `zama-prize-savings/README.md` (new)
- Content: confidentiality design (spec §4–§11); **information leakage analysis (spec §13)** including what is public (participant set, one-time wrap amounts, timing), what is private (all balances, all deposit/withdraw amounts, winner identity), the C4 ticket-disclosure rule, the funded-reserve-not-yield simplification, the open-mint testnet caveat, and the Zama KMS/relayer trust assumptions; deployed addresses; local run instructions; how the demo maps to `deposit → draw → claim → withdraw`.
- Then: ≤3-minute real-person demo per spec §15 (no AI-generated voice or video), and the X thread tagging @zama with #ZamaDeveloperProgram.
- Checkpoint: release gates 4 and 6. Recorded only after P5 and P6 are green.

---

## Scope cuts applied (do not re-add without approval)

- No `iwa-web` integration — standalone dapp in `zama-prize-savings/app/`.
- No encrypted weight snapshot — live balances at draw time.
- No multi-round production framework — one round, redeploy to repeat.
- No statistical multi-transaction fairness study — algorithmic assertion at small N instead.
- No `Ownable2Step` — plain `Ownable`.
- No separate general-purpose confidential token — OpenZeppelin `ERC7984ERC20Wrapper`.

## Must not be cut

ERC-7984 confidentiality · EIP-712 user decryption · deposit-weighted selection · `MAX_PARTICIPANTS` cap · returned-value accounting · encrypted claim credit · leakage analysis · over-withdraw, double-claim and no-sweep tests.

## Explicit non-actions

- No task here commits, pushes, or deploys to production. P7 deploys to **Sepolia only**, under separate approval, using a dedicated testnet key.
- Nothing in this plan touches `main`, `submission/starknet-v1`, or `iwa-v1-starknet`.
- If S2 fails, stop before S3 and P1 and report. Do not attempt the pool "just in case".

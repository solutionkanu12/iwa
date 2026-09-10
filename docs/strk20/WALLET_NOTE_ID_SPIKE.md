# A1 — Candidate P live-wallet note-id stability spike

**Date:** 2026-09-07 (probe built) · 2026-09-09 (forensic fixes) · **2026-09-09
21:46 — A1 PASSED on Starknet mainnet.**
**Status:** ✅ **A1 PASS.** Ready X on Starknet mainnet resolves a stable
open-note id across repeated `prepare(simulate)` calls, and the resolved id
changes exactly once a real note is created in that subchannel.
**Gate for:** `docs/superpowers/plans/2026-09-04-*` Part A2/A3. **Unblocked.**

---

## ✅ A1 PASS — real mainnet evidence (2026-09-09 21:46)

| | |
|---|---|
| Wallet | Ready X, Starknet **mainnet** |
| `supportedWalletApi` | `[0.10.3, 0.7.2]` — STRK20 methods present |
| Baseline: `prepare(simulate)` open-note id, **stable across repeated calls** | `0x1352748b2b1e5954c37bde6f9e52247284d7c9dec78dc17b0f541a2b4ec3771` |
| Intervening real note: **manual Ready X Shield**, Tx Status **Success**, 21:46 | tx `0x0679…9764` |
| Next `prepare(simulate)` open-note id **immediately after** the shield | `0x64c726788e6bbdba21d2d5e6b6fd46d0253d5df12d4c48195aacbd6d0a01076` |

**Chain of evidence:** stable resolved id before any new note → a real
on-chain note is created (successful shield) → the next resolved id is
**different**. This is exactly the Candidate P §3.5 property: the wallet
exposes a resolved open-note id via a shipped method, it is stable while the
subchannel is unchanged, and it tracks the real subchannel state. The earlier
`INVALID_REQUEST_PAYLOAD` (bad pool sentinels, fixed) and the
`PaymasterV2Error` (a deposit-plumbing issue in the *probe's* intervening step,
not Candidate P) are both resolved / worked around — the human used a manual
Ready shield for the intervening note.

**Consequence:** Candidate P's one open dependency is closed. A2 (minimal V2
private pot collection) proceeds. The dev probe (`/dev/note-id-probe`) stays as
a diagnostic; nothing about it ships.

---

## Prior history (for the record)

---

## 2026-09-09 — `INVALID_REQUEST_PAYLOAD` root cause (probe bug, FIXED)

Live run 3 (corrected probe from the forensic task) hit a **repeatable**
`WalletRPCError: INVALID_REQUEST_PAYLOAD` on both Prepare #1 and #2.

**Cause — hypothesis D (malformed calldata):** the forensic task added a
`${poolAddress}` control wrapped in two new sentinel felts,
`PROBE_POOL_SENTINEL_BEFORE/AFTER`. Both were **64 hex digits** and **above the
Stark field prime**. The Wallet API `FELT` schema (installed
`@starknet-io/types-js@0.10.3`, `api/components.d.ts`) is
`^0x(0|[a-fA-F1-9]{1}[a-fA-F0-9]{0,62})$` — **at most 63 hex digits**. Ready X
validates every `params.actions[].calldata[]` item against it and rejects the
whole request. The payload was identical for #1 and #2, so both failed
identically.

The original `${openNoteIds[0]}` sentinels (62 hex digits, below the prime) were
always valid — which is why live run 1 succeeded.

**Fix (dev probe only):** all four sentinels are now derived from short ASCII
strings (`asciiFelt`, ≤ 31 bytes ⇒ ≤ 62 hex digits, top byte < 0x80 ⇒ far below
the prime). New unit tests assert every `buildProbeActions` calldata item
matches the exact shipped `FELT` / `STRK20_CALLDATA_PLACEHOLDER` patterns.

**Not the cause of live run 2's earlier flake** — that was the old probe
(single valid sentinel pair) losing the response after needlessly re-running
Prepare #1/#2 (hypothesis C, already fixed). Run 2's root is still unconfirmed
and is what the next no-transaction run should settle.

---

## 2026-09-09 — intervening-note deposit failed: `PaymasterV2Error 156 / TRANSACTION_EXECUTION_ERROR`

No-transaction baseline was stable and repeatable (Prepare #1 == #2 ==>
`PARTIAL_STABLE_PENDING_SHIFT`). The intervening-note test then tried a 1-unit
USDC deposit via `wallet_strk20InvokeTransaction([{type:"deposit",token:USDC,
amount:"0x1"}])`. Ready preview: 0.000001 USDC shield · ~0.2283 USDC privacy fee
reserved · est. network fee ~$0.23. After Confirm →
`PaymasterV2Error: Paymaster error 156: TRANSACTION_EXECUTION_ERROR`.

### Layer: **wallet / paymaster**, not the STRK20 contract, not the token, not the probe

Read-only mainnet reads (SN_MAIN, 2026-09-09) against the pinned pool
`0x040337b1…812a`:

| view | value | meaning |
|---|---|---|
| `get_version` | `0x322e30` = "2.0" | the pinned pool, healthy |
| `get_fee_amount` | `0x53444835ec580000` = **6.0 STRK** | every `apply_actions` pulls **6 STRK** from `get_caller_address()` via `collect_fee` (`privacy.cairo:841`). 6 STRK ≈ $0.228 ≈ Ready's "0.2283 USDC reserved". |
| `get_fee_collector` | `0x0d79041…9e77` | configured, non-zero |
| `get_screener_public_key` | `0x501cc45…fdb2` | **non-zero ⇒ deposit screening is enforced** (`apply_actions` line 791: `screening.expect(SCREENING_REQUIRED)`) |
| `get_proof_validity_blocks` | `0x1c2` = 450 (~15 min) | proof staleness bound |

`PaymasterV2Error … TRANSACTION_EXECUTION_ERROR` is a **pre-submission
simulation revert**: the paymaster (SNIP-29 v2) refuses to relay a transaction
that reverts in `starknet_simulateTransactions`. Consequences:

- **No transaction was submitted. No transaction hash. No funds moved.** The
  probe's `createInterveningNote` never received a `transaction_hash` — the
  `await account.strk20InvokeTransaction(...)` threw.
- Code `156` is Ready/paymaster-internal (not in this repo or the STRK20
  package); not interpreted here beyond the accompanying standard error.

### What reverts in a paymaster-sponsored STRK20 deposit (ranked)

A regular-pool deposit runs, in one `apply_actions`:
`collect_fee` (6 STRK from the caller) → `_apply_transfer_from`
(1 unit USDC, user → pool, needs a standing USDC→pool allowance —
**cannot** be approved in the same tx, the pool is reentrancy-guarded) →
`_verify_screening` (FPI screener signature over `{depositor, issued_at}`).

1. **`collect_fee` — the account does not hold 6 STRK** (or Ready's fee path
   can't source it). `checked_transfer_from(STRK, get_caller_address() →
   fee_collector, 6 STRK)`. For a SNIP-9 outside-execution relay,
   `get_caller_address()` is the user's account. Most likely for a probe
   account that has been used to shield.
2. **Insufficient PUBLIC USDC** for Ready's ~0.2283 USDC fee reservation +
   0.000001 USDC deposit. A stable baseline means the account has a USDC
   self-subchannel, i.e. it has already shielded USDC — quite possibly all of
   its public USDC.
3. **Missing USDC → pool approval.** Ready must submit the `approve` as a
   separate prior transaction; if `wallet_strk20InvokeTransaction([deposit])`
   didn't (only one Confirm was shown), `_apply_transfer_from` reverts.
4. **Screening attestation missing / stale** for the paymaster-relayed deposit.
5. **`PROOF_EXPIRED`** if the paymaster simulated > ~15 min after Ready proved.

`amount:"0x1"` (0.000001 USDC) is **not** below any pool minimum — the only
deposit amount check is `ZERO_AMOUNT` (`privacy.cairo:1015`,
`actions.cairo:160`). The probe payload is schema-valid and correct.

### Candidate P is unchanged — still viable

The failure is entirely in the **intervening-note plumbing** (a Ready paymaster
deposit), which is a diagnostic convenience, not part of Candidate P's payout
flow. Candidate P's actual open property — `prepare(simulate)` exposes a
**stable resolved open-note id** — is already confirmed by the repeatable
no-transaction baseline. The only thing still unproven is that the resolved id
**shifts** when a USDC self-channel note is created, and that can be shown by
**any** means of creating such a note (a manual Ready shield; a private
self-transfer), not specifically this deposit call.

### Corrected human action (still no probe change; STOP for review)

1. Check the connected account's **public USDC** and **STRK** balances on
   Voyager. The deposit needs ~**6 STRK** (pool fee) + at least **1 unit
   (0.000001) public USDC** + a USDC→pool allowance.
2. If STRK < 6 or public USDC ≈ 0: top up ~**10 STRK** and ~**0.5 USDC**
   (public), then run the intervening-note test **once**.
3. Alternatively — cheapest and avoids the probe driving the deposit: **shield
   ~0.01 USDC from inside Ready's own UI** (it handles approve + screening),
   then click the probe's **"Re-verify baseline (no tx)"**. The manual shield
   *is* the intervening note; the probe only needs to re-prepare and see the id
   shift. Verdict target: no longer `PARTIAL_STABLE_PENDING_SHIFT` (id changed).
4. A follow-up option (probe change, not done here): make the intervening op a
   private **self-transfer** of a tiny shielded amount instead of a public
   deposit — needs no public USDC, no approve, no screening (still costs the
   6-STRK pool fee).

**Do not blind-retry the deposit** — it will reproduce the same revert.

---

## Live run 1 (2026-09-09, Ready X, Starknet mainnet)

| | |
|---|---|
| `supportedWalletApi` | `[0.10.3, 0.7.2]` — STRK20 methods: **yes** |
| Prepare #1 (simulate) | returned a **resolved** open-note id |
| Prepare #2 (simulate, no note created between) | returned the **SAME** resolved id |
| Verdict | `PARTIAL_STABLE_PENDING_SHIFT` |

**This run confirmed the core Candidate P property once:** Ready X's
`wallet_strk20PrepareInvoke(simulate)` DID expose a resolved open-note id, and
it was stable across two back-to-back calls.

## Live run 2 (2026-09-09, same wallet/session, "Intervening-note test" button)

| | |
|---|---|
| The button re-ran Prepare #1 from scratch (see forensic finding C) | |
| Prepare #1 | returned **NO** resolved id |
| Probe stopped | `REJECT_NO_RESOLVED_ID`, no deposit sent, no Prepare #3 |

**The old probe swallowed the wallet's actual response/error**, so we cannot
tell from run 2 whether Ready threw, returned a different shape, returned an
unresolved placeholder, or genuinely could not resolve the id. **Run 2 does not
prove Candidate P is unreliable** — see the forensic findings.

---

## Forensic findings (2026-09-09)

| # | Hypothesis | Status |
|---|---|---|
| **C** | The "Intervening-note test" reruns Prepare #1/#2 instead of reusing the confirmed ids | **CONFIRMED.** The old `runNoteIdStabilityProbe` always did `resolveOnce` twice before the intervening step. The button did not reuse run 1's stable id. Run 2's `REJECT` came from a **fresh** Prepare #1 failing, and `first === null` short-circuited before any deposit. FIXED: the probe now accepts `priorStableId` and, when given, does not re-derive #1/#2 and does not hard-reject on a single flake (new verdict `INCONSISTENT_ACROSS_RUNS`). |
| **B** | Extraction misses a valid response shape | **PARTIALLY.** The old `resolveOnce` only read `built.call.calldata`. Per the pinned reference (`private-transfers.ts buildExecuteResult`), the assembled server actions — where the resolved id lives — are derived from `proof.output`; a wallet could surface them under `proof.output` or a nested field instead of / as well as `call.calldata`, especially in `simulate` mode where the types-js spec says `proof.output` may be an empty array. FIXED: `findResolvedOpenNoteIdDeep` now searches the **whole** response recursively and reports where it found the id. |
| **A / E** | Ready X inconsistently returns resolved ids / Candidate P genuinely unreliable | **NOT PROVEN either way.** Run 1 succeeded, run 2 failed, but run 2's failure was never captured. Needs the forensic re-run below. |
| **D** | Wallet/proof state changed between the two runs (throttle, channel-discovery cache, transient proving/indexer backend) | **PLAUSIBLE, unconfirmed.** Three `strk20PrepareInvoke` calls in quick succession (2 in run 1 + 1 in run 2); the third failed. The new probe adds a retry-after-delay and records `retried`, so a transient will be visible. |

### Other issues found and fixed in the probe

- `probeContract` was `STARKNET_MAINNET.privacyPool` — an `invoke` targeting the
  pool itself is nonsensical (the pool has no `privacy_invoke` selector) and a
  wallet may validate the target inconsistently. Changed to
  `STARKNET_MAINNET.iwaHelper` (a real deployed contract that HAS
  `privacy_invoke`; `simulate` never executes it).
- Errors from `wallet_strk20PrepareInvoke` were swallowed (`.catch(() => null)`).
  Now captured into a `PrepareInspection` (message/code only, **never** a stack,
  **never** `proof.data`).
- Added a `${poolAddress}` control placeholder: if that resolves but
  `${openNoteIds[0]}` does not, the wallet does substitution but cannot compute
  the note id (e.g. no self-subchannel for the token yet).

---

## The question A1 answers

Candidate P (`docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`) has exactly one
open dependency (§3.5):

> Does a real privacy-enabled Starknet wallet, via the **shipped**
> `wallet_strk20PrepareInvoke`, expose a **resolved** open-note id in the
> returned call — and is that id the **same** one the final submission uses,
> as long as no note is created in that subchannel in between?

Everything else about Candidate P is already proven:

| Fact | Evidence |
|---|---|
| `wallet_strk20PrepareInvoke` / `wallet_signTypedData` / `wallet_addInvokeTransaction({calls,proof})` ship in 0.10.3 | `iwa-web/node_modules/@starknet-io/types-js@0.10.3` `methods.d.ts`, `components.d.ts` |
| the reference wallet client resolves `${openNoteIds[0]}` at compile time and bakes the concrete felt into the returned calldata | pinned `client/src/strk20-prover.ts` `substitute()`; `client/tests/client.test.ts` "resolves invoke calldata with per-open-note placeholders at compile time" |
| note id is a pure deterministic function of `(self channel key, token, subchannel index)` | pinned `hashes.cairo:206`; `iwa-web/src/chains/strk20/v2/precommittedNoteId.test.ts` (8/8) |
| a wrong / stale destination note makes the settlement revert with the pot untouched | `contracts/starknet/tests/test_precommitted_note_payout_v2.cairo` (10/10 vs the genuine pinned pool) |

So A1 is **not** a design question. It is a single behavioural check against a
shipped wallet on a public network.

---

## What was built / updated

| File | Purpose |
|---|---|
| `iwa-web/src/chains/strk20/noteIdStabilityProbe.ts` | probe: pure helpers + `runNoteIdStabilityProbe` + `captureShape` + `inspectPrepareResponse` + `findResolvedOpenNoteIdDeep` |
| `iwa-web/src/chains/strk20/noteIdStabilityProbe.test.ts` | 46 unit tests — **PASS** |
| `iwa-web/src/screens/DevNoteIdProbeView.tsx` | TEMPORARY local-only page `/dev/note-id-probe` (`import.meta.env.DEV` only; no nav link; tree-shaken from `npm run build`) |
| `iwa-web/src/lib/router.ts`, `iwa-web/src/main.tsx` | route wiring (dev-only branch) |

The probe calls **only** shipped methods: `supportedWalletApi`,
`wallet_strk20PrepareInvoke` (simulate), and — only via the caller-supplied
`createInterveningNote`, behind a UI confirm — `wallet_strk20InvokeTransaction`
for one small deposit. It never assembles or submits a payout.

### Verdicts

| Verdict | Meaning | Next |
|---|---|---|
| `PASS` | id stable across two prepares **and** it shifted after a real intervening note | A1 PASSES — proceed to A2 |
| `PARTIAL_STABLE_PENDING_SHIFT` | stable across two prepares; intervening step not run | run the intervening-note step |
| `INCONSISTENT_ACROSS_RUNS` | a prior run resolved a stable id but this run's prepare disagreed / returned none | **transient**, not a Candidate P property — re-run the no-transaction capture |
| `REJECT_UNSTABLE` | two back-to-back prepares gave different ids, no note between | reject Candidate P |
| `REJECT_NO_RESOLVED_ID` | **repeatable** — prepare exposes no resolved id anywhere (checked recursively, retried once) | reject Candidate P for this wallet |
| `INCONCLUSIVE_ID_DID_NOT_SHIFT` | stable, but an intervening note did not move it | investigate the note-id model |
| `WALLET_UNSUPPORTED` | wallet does not report Wallet API ≥ 0.10.3 | report the exact limitation; stop |

---

## Next human action — one NO-TRANSACTION run

Prereqs: Ready X on **Starknet mainnet**, the same account as run 1, with a
shielded balance of the probed token (USDC).

1. `cd iwa-web && npm run dev` → open `http://localhost:5173/dev/note-id-probe`.
2. Connect Ready. Confirm `supportedWalletApi` and the token (USDC).
3. Click **"Capture raw prepare shape (no tx)"**. Expand the inspection and
   record the whole JSON. This is the response the old probe threw away.
4. Click **"Run Prepare #1 + #2 (no tx)"**. Record #1, #2, the verdict, and both
   per-call inspections.
5. Click **"Run Prepare #1 + #2 (no tx)"** again (a fresh run). Record it.
6. If step 4 produced a baseline, click **"Re-verify baseline (no tx)"** a few
   times over a minute or two. Record each verdict + inspection.

**Nothing above sends a transaction or costs anything.** Do NOT click the
"Intervening-note test" button yet.

Paste the inspections into the Result table below. From the `sentinelPairPaths`,
`resolvedIdCandidatesHex`, `placeholderLiteralPaths`, `proof.outputLength`,
`call.calldataLength`, `error`, and `retried` fields we can prove which of
A/B/D is happening.

---

## Result — forensic re-run (fill in)

| Field | Value |
|---|---|
| Date | |
| Wallet + version | Ready X, |
| Network | Starknet mainnet |
| Token | USDC |
| Capture-shape inspection JSON | _(paste)_ |
| Prepare #1+#2 run A: #1 / #2 / verdict | |
| Prepare #1+#2 run A: inspection JSON ×2 | _(paste)_ |
| Prepare #1+#2 run B: #1 / #2 / verdict | |
| Re-verify baseline ×N: verdicts | |
| Any `error` / `retried:true` seen? | |
| `proof.outputLength` when the id resolved / when it did not | |
| `sentinelPairPaths` when resolved / not resolved | |
| `poolAddressPlaceholderResolved` | |

---

## Decision rule (after the forensic re-run)

- **All no-transaction prepares now resolve a stable id** (run 2 was a one-off
  transient) → `PARTIAL_STABLE_PENDING_SHIFT`. Candidate P remains viable. The
  only remaining step is one intervening-note deposit (small confirm-gated
  mainnet tx) to reach `PASS`.
- **`error` / `retried:true` present on the failed calls** → transient
  wallet/backend (hypothesis D). Candidate P remains viable; the probe should
  poll/retry in the real flow, and a mismatch is fail-safe anyway.
- **`poolAddressPlaceholderResolved:true` but no `sentinelPairPaths` for the
  open note, repeatably** → the wallet does substitution but cannot compute the
  note id here (hypothesis A/E, e.g. it does not `autoSetup` the subchannel).
  Try a token the account has definitely shielded; if still repeatable, this is
  a real Ready-X limitation — **reject Candidate P for Ready X** and record it
  (do not implement the §8 fallback without review).
- **`REJECT_UNSTABLE`** (two prepares, different ids, no note) → reject
  Candidate P.
- **`WALLET_UNSUPPORTED`** → report wallet/version/method.

A1 stays open until a forensic re-run gives a repeatable answer.

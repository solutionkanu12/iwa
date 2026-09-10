# Iwa V2 — Alternative Starknet-Private Payout Mechanisms

**Date:** 2026-09-07
**Branch:** `feature/iwa-v2` — no commit, no push, no deploy, no V1 change
**Context:** the shadow-account Wallet API path (verdict B) is blocked by missing
live wallet + anonymizer infrastructure (see `V2_CAPABILITY_G2_G5_STATUS.md`).
This document researches mechanisms that can work **today**.

**Bottom line:** there is a viable path — **Candidate P: precommitted
destination note** — that satisfies every Iwa invariant, needs only a small
isolated V2 contract addition and **no wallet changes**, and is built entirely
on STRK20 Wallet API methods that ship in `@starknet-io/types-js@0.10.3`. Its
one residual risk (note-id stability across the two wallet calls) is
mathematically characterised below, is fail-safe, and is the only thing that
still needs a real-wallet check on a public network.

---

## 1. Evidence baseline (what was actually inspected)

| Source | Exact location |
|---|---|
| Pinned STRK20 pool + SDK + reference wallet client | `starkware-libs/starknet-privacy@66e3caae8c0201227a6719696d004e30d90aea65` (the rev Iwa's `Scarb.toml` pins) |
| Installed Wallet API surface | `iwa-web/node_modules/@starknet-io/types-js@0.10.3` — `wallet-api/methods.d.ts`, `components.d.ts` |
| Installed Starknet lib | `iwa-web/node_modules/starknet@10.5.0` |
| Installed STRK20 skills | `.agents/skills/strk20-*` + `references/` |
| Iwa V1 contract behaviour | `contracts/starknet/src/iwa_strk20_helper.cairo`, `iwa_circle.cairo`, `tests/test_strk20_pool_integration.cairo` (190 passing) |

No API was assumed. Every "shipped" claim below is a line in the installed
`methods.d.ts` / `components.d.ts`; every pool-behaviour claim is a line in the
pinned Cairo source.

---

## 2. Candidates investigated, with evidence and verdict

Classification: **A** works today · **B** works with a small V2 contract change ·
**C** needs wallet/protocol support not currently shipped · **D** breaks an
Iwa invariant.

### Target 1 — STRK20 alternative private withdrawal/transfer without the shadow-account API

- **`withdraw` action** → `WithdrawInput { to_addr, token, amount, random }`
  (`actions.cairo:184`), `assert(to_addr.is_non_zero(), ZERO_TO_ADDR)`. The
  destination is a **public address**. A withdraw is a public exit — token,
  amount, recipient all public. **D** as a payout path.
- **`transfer` action** (private, in-pool) moves value "to another registered
  user". Requires the recipient to have run `SetViewingKey` and the sender to
  build a proof with their viewing key. The Iwa helper is a plain ERC-20
  holder, not a registered pool participant, and holds no viewing key, so it
  **cannot initiate** a private transfer. Making it one would require key
  custody in the helper/backend. **D**.
- **Verdict:** the only private outbound path STRK20 exposes is the
  helper→pool `OpenNoteDeposit` return inside `apply_actions`. Everything below
  is about authorising *that* correctly.

### Target 2 & 3 — Precommitted recipient note commitment / user-generated destination before the payout turn → **CANDIDATE P (B)**

- **An empty open note cannot be parked for later.** `_apply_actions` counts
  `EmitOpenNoteCreated` and asserts the count returns to zero in the same
  applied action set: `assert(undeposited_open_notes == 0, UNDEPOSITED_OPEN_NOTES)`
  (`privacy.cairo:903`). A filled note is single-use:
  `_deposit_to_open_note` requires current amount zero, else
  `NOTE_ALREADY_DEPOSITED` (`privacy.cairo:1008-1040`). So there is **no
  reserved-note primitive**.
- **But the note *id* is deterministic and knowable ahead of time.**
  `note_id = h(NOTE_ID_TAG, channel_key, token, index, 0)` and
  `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key,
  recipient_addr, recipient_public_key)` (`hashes.cairo:114-132, 200-210`).
  For a DeFi open note the SDK sets `recipient = self`
  (`builders.ts:98`, wallet-api skill example), so `channel_key` derives
  **entirely from the member's own wallet material** — no
  transaction-assembly randomness. The only moving part is `index`, the
  subchannel's note nonce, which `_prepare_note_creation` forces to be
  sequential (`INDEX_NOT_SEQUENTIAL`, `privacy.cairo` — index 0, or
  `notes[index-1]` must exist).
- **Consequence:** the member's *next* open-note id for a token is a pure
  function of `(their wallet material, token, current subchannel note count)`.
  The member can compute it (via their wallet), sign it, and **pre-register
  the id** with the V2 circle before the payout transaction is assembled. The
  note itself is created normally inside the settlement transaction.
- **Locally proven:** `iwa-web/src/chains/strk20/v2/precommittedNoteId.test.ts`
  (8/8) — the id is deterministic, identical across two "compute" passes with
  an unchanged index, changes iff the index changes, is token-scoped, needs
  the viewing key (so the dapp must get it from the wallet, not compute it),
  and is member-bound.
- **Classification: B** (small V2 contract addition — a destination registrar).

### Target 4 — Direct pool withdrawal to a committed note

- No such primitive. `Withdraw` → public `to_addr`; open notes are filled only
  by a helper's `OpenNoteDeposit` return. **D**.

### Target 5 — Shielded transfer primitives in the current STRK20 Wallet API

Installed `methods.d.ts` (0.10.3) exposes, and Candidate P uses:

| Method | Shipped 0.10.3? | Role in Candidate P |
|---|---|---|
| `wallet_strk20PrepareInvoke({actions, simulate?})` → `{call, proof}` | **YES** (`methods.d.ts:157`) | Build the payout `apply_actions` call; in `simulate` mode (empty proof) the dapp reads the **resolved open-note id** from `call.calldata`. |
| `wallet_strk20InvokeTransaction({actions})` | **YES** | Submit the payout (wallet proves + sends). |
| `wallet_signTypedData(TypedData)` → `Signature` | **YES** (`methods.d.ts:99`) | The member's SNIP-12 destination-registration signature (Iwa auth key). |
| `wallet_addInvokeTransaction({calls: Call[], proof?: STRK20_PROOF})` | **YES** (`components.d.ts:60-70`) | Optional: submit `[registerCall, strk20ApplyActionsCall]` as one atomic multicall with the proof attached. |
| `STRK20_ACTION` = `deposit \| withdraw \| transfer \| invoke` | **YES** (`components.d.ts:225`) | `transfer` with `amount:"OPEN"` creates the note; one `invoke` calls the helper with `${openNoteIds[0]}`. |

**NOT shipped in 0.10.3** (needed by the shadow path, not by Candidate P):
`compute_and_invoke` action, `wallet_strk20ShadowAccountCommitment`,
`STRK20_SHADOW_ACCOUNT_INVOKE_ACTION`.

- **Classification: A** for the primitives themselves.

### Target 6 — Account abstraction / multicall with shipped account methods → **A (enabler)**

- `AddInvokeTransactionParameters { calls: Call[]; proof?: STRK20_PROOF }` —
  the doc-comment: *"Optional SNIP-36-compliant ZK proof. Required when
  submitting a STRK20 call produced by `wallet_strk20PrepareInvoke`."*
  (`components.d.ts:66-69`). So a **multicall that includes a proof-carrying
  STRK20 `apply_actions` call alongside a plain call is expressible in
  0.10.3.**
- starknet.js 10.5.0: `account.execute(calls, { proofFacts, proof, tip })`
  (`V3Details` = `… & Partial<Pick<UniversalDetails,'proofFacts'|'proof'>>`,
  `index.d.ts:7569`); `calculateInvokeTransactionHash(…, proofFacts?)`
  (`index.d.ts:7028`); `executeFromOutside` / SNIP-9 (`index.d.ts:5950`).
- The pinned reference wallet client (`client/src/client.ts:55-58`) already
  models this as `executeWithProof([...preCalls, strk20Call, ...postCalls],
  proof)`.
- **Classification: A** as an enabler. Whether a specific shipped wallet
  implements the multicall-with-proof case is a live check; the **two-tx
  variant** (separate register tx, then plain `wallet_strk20InvokeTransaction`)
  avoids it entirely and is the conservative default.

### Target 7 — Commit-reveal destination

- Committing `H(note_id)` and revealing at settlement adds a round-trip but no
  privacy: `note_id` and `amount` are already public in the `OpenNoteDeposit`
  (`objects.cairo:104-111`), and the note *owner* is hidden by STRK20 whether
  the id was committed as a hash or in the clear. Pre-registering `note_id`
  directly is simpler and equivalent. **B, no benefit over Candidate P.**

### Target 8 — ZK proof-based payout authorization with current Cairo/Starknet primitives → **C**

- Would need a **custom Cairo verifier** (the legacy `iwa-circuit` /
  `iwa-prover`, unapproved for reuse per `SECURITY.md`) **and** the member's
  STRK20 viewing key to build the witness (channel-key derivation). The wallet
  never exposes the viewing key and will not run an app-specific circuit.
- STRK20's own proving pipeline is not exposed for application circuits; there
  is no shipped "prove a statement about my channel/note" wallet primitive.
- **Classification: C**, and heavy. Not pursued.

### Target 9 — Privacy-pool withdrawal proof binding entitlement to circle state, recipient hidden → **= Candidate P**

- The pool's `validate_proof` requires the transaction to carry `proof_facts`
  whose `message_to_l1_hashes == [compute_message_hash(actions, pool)]`
  (`privacy.cairo:804-838`). The `Invoke` server action's calldata — which
  carries the destination note id — is therefore **proof-bound: it cannot be
  tampered with after proving** without invalidating the transaction.
- Entitlement (member, round, amount) is bound by the **helper reading circle
  state**, not calldata (V1 already does this: `amount = payout.amount`,
  `member_ref == payout.scheduled_member_ref` in
  `iwa_strk20_helper.cairo:253-268`).
- Recipient (note owner) stays hidden by STRK20.
- **This is exactly Candidate P.**

### Target 10 — Any other current Starknet privacy primitive

- **AVNU private-swap executor** — swap-only, no help for payout binding. N/A.
- **`identity_key` via `compute_and_invoke`** (`hashes.cairo:57-61`,
  `privacy.cairo:542-574`) — this is the shadow-account family; the action is
  not in 0.10.3. **C** (already the blocked path).
- Nothing else in the pinned source or the installed skills.

---

## 3. Best viable path — Candidate P: precommitted destination note

### 3.1 The V1 gap it closes

V1's `SettlePayout` already: is pool-only; reads `member_ref` and `amount`
from circle state; verifies a member Iwa-auth-key signature that binds the
destination `open_note_id`; consumes a single-use nonce; is atomic. The
**only** thing that blocks V1 collection from a browser is that the member's
settlement signature must bind an `open_note_id` that the wallet only produces
*during* transaction assembly, so the browser flow cannot order "resolve id →
sign id → submit" (`STATUS.md`, "What does not work yet").

Candidate P moves the destination binding **earlier and out of the settlement
transaction**: the member pre-registers the id (authorised once, ahead of
time), and settlement carries no signature at all.

### 3.2 Flow (all shipped 0.10.3 methods, two-transaction variant)

**Preconditions:** the member is a circle contributor who has shielded the
circle token at least once (so their self-subchannel exists —
`SUBCHANNEL_NOT_FOUND` otherwise), and has run the V1 "authorize my payout,
amount X" step (`authorize_payout_settlement`, unchanged).

1. **Resolve** — dapp builds `[{transfer OPEN → self}, {invoke helper:
   SettlePayout(circle_id, round, member_ref, token, "${openNoteIds[0]}")}]`
   (no signature in calldata) and calls
   `wallet_strk20PrepareInvoke({actions, simulate:true})`. It parses the
   returned `call.calldata` (the `apply_actions` server-action stream) to
   extract the resolved concrete open-note id `N`.
2. **Authorise the destination** — member signs SNIP-12
   `IWA_PAYOUT_DEST_V2 { chain_id, circle_contract, helper, pool, token,
   circle_id, round, member_ref, note_id: N, dest_epoch, nonce, expiry }`
   via `wallet_signTypedData`, against their **Iwa auth key** (the same key
   V1 uses — not the wallet key, not the viewing key).
3. **Register** — dapp submits `circleV2.register_payout_destination(circle_id,
   round, member_ref, N, dest_epoch, nonce, r, s)` as a plain transaction.
   The V2 circle verifies the signature against
   `member_auth_keys[(circle_id, member_ref)]` (trusted state — not caller
   supplied), checks `member_ref == payout.scheduled_member_ref`, `dest_epoch`
   strictly increasing, `nonce` unused, `expiry` not passed, then stores
   `registered_payout_note[(circle_id, round)] = N` and consumes the nonce.
4. **Settle** — dapp calls `wallet_strk20InvokeTransaction({actions})` with the
   same actions (still `${openNoteIds[0]}` placeholder, no signature). The
   wallet re-resolves the placeholder → **must be `N` again** (see §3.5). The
   pool runs `apply_actions` → `helper.privacy_invoke`:
   - `caller == pool`
   - `payout = circle.get_payout_state(circle_id, round)`;
     `status == PrivateSettlementAuthorized`; `member_ref` matches
   - `amount = payout.amount` — **from state, calldata carries no amount**
   - `open_note_id (calldata) == circle.registered_payout_note(circle_id,
     round)` — **the binding**
   - `assert_outbound_available`, `debit_liability`, exact `approve_pool`,
     `settle_payout_from_helper` (consumes its own settlement nonce, marks
     `PrivatelyPaid`)
   - return `OpenNoteDeposit { N, token, amount }`; the pool pulls `amount`
     from the helper and fills note `N`.
5. The round reaches a terminal *successful* state **only** inside a
   successful `apply_actions`. Any failure reverts the whole STRK20
   transaction (`privacy.cairo:983-987`, `unwrap_syscall`, no catch).

**Atomic multicall variant (optional):** steps 3+4 as one
`wallet_addInvokeTransaction({ calls: [registerCall, strk20ApplyActionsCall],
proof })`. Pending a real-wallet check of multicall-with-proof; not required
for correctness (registration alone finalises nothing).

### 3.3 Privacy properties

| Property | Status |
|---|---|
| Recipient wallet address | **Not exposed.** The note owner is hidden by STRK20; only `note_id` + `amount` appear in the public `OpenNoteDeposit`. |
| Payout amount | Public in the `OpenNoteDeposit` — **unavoidable** (open-note amounts are public by STRK20 design; `SECURITY.md` "Public by construction"). Not an *added* leak. |
| Member ↔ circle/round link | The `register_payout_destination` transaction sender is the member's account, linking that account to "collecting circle X round Y". But the member↔`member_ref` link is **already public by construction** in V1 (the join transaction has a public sender), and the payout order is public, so round R for that member is already derivable. **No new leak.** Optionally reduced via SNIP-9 relayed registration. |
| Viewing key | Never leaves the wallet. The dapp gets the resolved `N` from `wallet_strk20PrepareInvoke`, never the key. |
| Private transfer graph | Unchanged — STRK20's note/nullifier model is untouched. |

### 3.4 Public metadata leakage (state it honestly)

- Contract / helper / pool / token addresses; transaction timing and
  relayer/sender metadata.
- Circle existence, terms, round progression, payout order — already public.
- The pre-registered `note_id` `N` (a Poseidon hash; not invertible, not
  linkable to the member without the viewing key). When `N` later appears in
  an `OpenNoteDeposit` for that helper, an observer can correlate "the payout
  for circle X round Y went to note N" — but the circle/round of a helper
  invocation is already public. No identity is revealed.
- The open-note token and filled amount.
- `dest_epoch` / registration and any fallback-activation events.
- **Not anonymity.** STRK20 gives Iwa private settlement transfers, not
  anonymous membership.

### 3.5 The one residual risk — note-id stability, and why it is acceptable

`N` at step 1 must equal `N` at step 4. Both are
`compute_note_id(self_channel_key, token, index)`; `self_channel_key` and
`token` are permanent; `index` is the member's (self-channel, token)
subchannel note count. `index` advances **only** when the member creates
another note in that exact subchannel (a deposit of that token, a self-change
note, another DeFi output) between step 1 and step 4.

- In a focused, co-timed payout flow (member present, dapp drives steps 1→4 in
  one session), `index` is stable — proven deterministic in
  `precommittedNoteId.test.ts`.
- If `index` did move, step 4's created note ≠ registered `N` → the helper's
  `open_note_id == registered` check fails → the **whole STRK20 transaction
  reverts, the pot is untouched, and the flow re-runs from step 1**. It is
  **fail-safe**: a mismatch never loses or misdirects funds.
- This is the same class of assumption STRK20's own `${openNoteIds[N]}`
  placeholder already relies on.

**The remaining live gate (smaller than the shadow path):** confirm that a
real privacy-enabled wallet (Ready / Xverse) on Starknet Sepolia:
(a) resolves `${openNoteIds[0]}` to a concrete id in the `call.calldata`
returned by `wallet_strk20PrepareInvoke(simulate:true)` (the pinned reference
client does — `client/tests/client.test.ts:127`,
`strk20-prover.test.ts` "resolves invoke placeholders …"); and
(b) resolves the same id at `wallet_strk20InvokeTransaction`.

### 3.6 Replay / double-collect protection

- **Registration nonce** — single-use in the `(member_ref, nonce)` namespace,
  consumed atomically with the store.
- **`dest_epoch`** — strictly increasing; a stale destination cannot be
  re-registered.
- **Helper settlement nonce** — single-use (V1's
  `settle_payout_from_helper`, unchanged).
- **Payout state machine** — `PrivateSettlementAuthorized → PrivatelyPaid`;
  a second settlement sees the wrong state and reverts.
- **Pool one-fill rule** — `NOTE_ALREADY_DEPOSITED` (`privacy.cairo:1008-1040`)
  independently blocks refilling `N`.
- **Proof binding** — the destination id in the invoke calldata is bound into
  `message_to_l1_hashes`; it cannot be swapped after proving.
- **Locally proven:** `test_precommitted_note_payout_v2.cairo` — replay of a
  completed payout rejected; wrong destination rejected; forged / stale-epoch
  / nonce-replay registrations rejected; pool-side failure after the helper
  returns reverts registration + settlement + approval.

### 3.7 Recovery / liveness

- **Member present (the main product problem):** solved — the 3-step flow runs
  in one session. V1 cannot do this at all.
- **Member briefly offline mid-flow:** the settlement proof is valid
  ~`proof_validity_blocks` (~15 min, governance-set). The member must complete
  steps 1→4 within that window. Far better than V1 (stuck indefinitely).
- **Member lost key / gone:** still requires *some* privacy wallet to assemble
  the note-creating settlement transaction — this is inherent to
  "browser/user-controlled, no backend, no admin, private". Least-bad design
  (a real V2 addition, not built here):
  - at join the member commits a **fallback destination** = a note id
    computable by a **separately backed-up** privacy wallet (seed in a safe),
    plus a long timelock `fallback_after`;
  - after the timelock with no successful payout, the fallback destination
    becomes acceptable and settlement submission becomes permissionless
    (destination selection never does);
  - any fresh authorisation / re-registration resets the timer;
  - organizer / admin / backend / helper have **no** recipient discretion at
    any point.
- No public-account fallback. Ever.

### 3.8 Required contract changes (V2 only — no V1 file touched)

A small isolated addition (proven in the spike as
`PayoutDestinationRegistrarV2` + a V2 `SettlePayout` leg):

1. `register_payout_destination(circle_id, round, member_ref, note_id,
   dest_epoch, nonce, r, s)` — member-auth-key-signed (key read from circle
   state), single-use nonce, strictly increasing epoch, stores
   `registered_payout_note[(circle_id, round)]`.
2. V2 `SettlePayout`: check `open_note_id == registered_payout_note[(circle_id,
   round)]` **instead of** an inline settlement signature. Amount and member
   still from state (as V1).
3. Payout states `PrivateSettlementAuthorized`, `PrivatelyPaid`, plus the
   fallback states for §3.7.
4. `register_fallback_destination` + timelock (recovery).

Everything else — payout order, accounting, grace, defaults, liability
conservation, atomicity — carries from V1 unchanged. V1 stays a separate
immutable deployment; `(contract address, circle id)` identity; no migration.

### 3.9 Required wallet changes

**None.** `wallet_strk20PrepareInvoke`, `wallet_signTypedData`,
`wallet_strk20InvokeTransaction`, `wallet_addInvokeTransaction` are all in
`@starknet-io/types-js@0.10.3`. The only wallet dependency is *behavioural*
(§3.5), verifiable on a public network with a real wallet.

---

## 4. Rejected against the hard requirements

| Candidate | Rejected because |
|---|---|
| Helper-initiated private `transfer` (T1) | Needs viewing-key custody in the helper/backend. |
| `withdraw` to member address, then re-shield (T1, T4) | Public ERC-20 transfer exposing recipient + amount; explicitly prohibited (design §1). |
| Reserved / pre-created empty note (T2) | Impossible: `UNDEPOSITED_OPEN_NOTES` (`privacy.cairo:903`). |
| ZK app-circuit payout auth (T8) | Needs the viewing key in the dapp and an unapproved custom verifier; no wallet primitive. **C**. |
| Shadow-account / `compute_and_invoke` (T10) | Action + methods not in 0.10.3; no verifiable anonymizer deployment. **C** (the already-blocked path). |
| Any "organizer registers the destination" shortcut | Organizer would gain recipient influence — prohibited. |

---

## 5. Local proof status (test-first)

| Proof | File | Result |
|---|---|---|
| Capability (Cairo) against the **genuine pinned pool** | `contracts/starknet/tests/test_precommitted_note_payout_v2.cairo` + `src/v2_precommit_spike.cairo` (feature `v2_precommit_spike`) | **10/10 PASS** (`snforge 0.63.0`) |
| Note-id determinism + fragility condition (TS) | `iwa-web/src/chains/strk20/v2/precommittedNoteId{.ts,.test.ts}` | **8/8 PASS** (`vitest 4.1.11`) |
| Baseline unaffected | `snforge test --features test_erc20` (no `v2_precommit_spike`) | 190 pass — spike is feature-gated and the test file is wrapped in `#[cfg(feature: 'v2_precommit_spike')] mod spike { … }` |

The 10 Cairo tests, all green against `privacy::privacy::Privacy` rev 66e3caae:
`precommitted_destination_is_filled_by_the_genuine_pool`,
`settled_amount_tracks_circle_state_not_calldata`,
`wrong_destination_note_is_rejected_and_nothing_changes`,
`wrong_member_ref_is_rejected`,
`replay_of_a_completed_payout_is_rejected`,
`forged_registration_is_rejected`,
`stale_epoch_registration_is_rejected`,
`registration_nonce_is_single_use`,
`direct_helper_call_bypassing_the_pool_is_rejected`,
`pool_side_failure_after_the_helper_returns_reverts_everything`.

What the Cairo spike proves against the real pinned pool: a note id
**known and registered before the STRK20 transaction is assembled** is filled
by the genuine pool with the exact state-derived amount; substitution, wrong
member, replay, forged / stale / nonce-replayed registration, direct
(non-pool) helper calls, and a pool-side failure after the helper returns are
all rejected with state + liability + approval unchanged.

What is **not** proven locally (the live gate): real-wallet behaviour in §3.5.

---

## 6. Whether a real testnet proof can be attempted now

**Partly.** The contract side is deployable to Starknet Sepolia today (V2
registrar + V2 helper spike + a mock/real circle). The end-to-end proof needs
a **real privacy-enabled browser wallet on Sepolia** to exercise §3.5 — the
same category of dependency as the shadow path, but on **already-shipped**
methods, so far more likely to succeed. Recommended sequencing:

1. Get the Cairo spike green locally (done — see §5).
2. Stand up the SDK/devnet `simulate` harness (or a real wallet on Sepolia)
   and confirm §3.5 (a) + (b) — resolved id present in the prepared call,
   stable across the two calls.
3. Only then: deploy the V2 registrar + helper spike to Sepolia and run one
   minimal-value payout end-to-end with a real wallet.
4. Freeze the `IWA_PAYOUT_DEST_V2` SNIP-12 encoding and cross-language vectors
   **after** step 2, and return for security review.

Do **not** implement full V2, flip create-default, or freeze the encoding
before step 2.

---

## 7. Exact next step

1. **Review this document** and decide whether Candidate P is the approved V2
   private-payout direction (replacing / alongside the shadow-account design,
   which stays valid but infrastructure-blocked).
2. If approved: build the §3.5 verification harness (SDK simulate or real
   Sepolia wallet) — the smallest possible check that a real wallet exposes a
   stable resolved open-note id. This is the single remaining gate.
3. Keep the spike (`v2_precommit_spike` feature + the two test files) as the
   executable capability record; do not merge it into V1 or production paths.

---

## 8. If Candidate P's live gate fails

If a real wallet does **not** expose a stable resolved open-note id from
`wallet_strk20PrepareInvoke`, then **no currently-shipped mechanism** lets a
browser bind an Iwa payout to a private destination without either
(a) the shadow-account Wallet API (not shipped), or
(b) viewing-key custody in the dapp/backend (prohibited).

The least-bad architecture in that case, **not to be implemented without
review**: a member-operated **key-holding settlement agent** running the
Privacy SDK **on the member's own device** (not a server) — e.g. a desktop
helper or a WASM module the member runs locally — which holds only that
member's own STRK20 account + viewing key, assembles the note-creating
settlement transaction, and is bound by the same V2 contract checks (state
amount, pre-registered destination, single-use nonce). This keeps custody with
the member and off any Iwa server, at the cost of a heavier client. It is a
fallback, not a recommendation.

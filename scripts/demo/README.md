# IWA STRK20 mainnet demo tooling

Drives one complete IWA savings-circle round over StarkWare's STRK20 privacy
pool on Starknet mainnet: shield, two private contributions, one private
payout. Read-only by default; every broadcast is behind an explicit flag.

## What is deployed

| | Address |
|---|---|
| IwaCircle | `0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be` |
| IwaStrk20Helper | `0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb` |
| STRK20 privacy pool (StarkWare) | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |
| USDC (native, 6 decimals) | `0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb` |
| STRK (18 decimals) | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` |

Both IWA class hashes are pinned in `demo.config.json` and re-checked on chain
before anything runs. IWA never declares or deploys the pool.

## Safety model

1. **Dry run is the default.** `--confirm-send` is required to broadcast. A dry
   run still compiles the real actions, signs, and simulates through the SDK's
   mock prover, so it validates the same object a send would submit.
2. **A green preflight is a precondition.** Crypto parity and on-chain wiring
   gates run in-process before an account is constructed. Any failure aborts.
3. **Fail closed.** Wrong chain, drifted class hash, blocked open-note
   depositor, unexpected pool version, non-`Pending` obligation, consumed
   nonce, stale helper surplus, missing secret — all abort before spending a
   proof.
4. **One send gate.** Every broadcast goes through `submit` / `submitPoolTx` in
   `lib/run.mjs`. There is nowhere else a transaction can leave the process.
5. **Secrets are environment-only.** Never in the repo, never printed.

## Setup

```sh
cp .env.example .env.local     # fill in; .env.local is gitignored
npm run preflight              # read-only; verifies the whole deployment
```

Every command below loads secrets with Node's own `--env-file`.

## Funding

`00_prepare.mjs` prints the exact figures from the **live** pool fee. For the
default circle (2 members x 1.00 USDC):

- **2.00 USDC** in the operator account, approved to the pool.
- **~30.66 STRK**: 4 pool transactions x the live fee (6 STRK each, read from
  `get_fee_amount()`), plus a gas allowance and a 20% margin. Approve the pool
  for at least the fee total.

The pool fee is **not gas**. `collect_fee` pulls it from the caller with
`transfer_from`, so a standing STRK allowance to the pool is required. It is
governance-settable, which is why nothing here hardcodes it.

## Run

```sh
node --env-file=.env.local 00_prepare.mjs                              # dry run
node --env-file=.env.local 00_prepare.mjs    --confirm-send            # create_circle + joins
node --env-file=.env.local 04_deposit.mjs    --confirm-send            # approvals + POOL TX 1
node --env-file=.env.local 05_contribute.mjs --member A --confirm-send # POOL TX 2
node --env-file=.env.local 05_contribute.mjs --member B --confirm-send # POOL TX 3
node --env-file=.env.local 06_payout.mjs     --confirm-send            # finalize + authorize + POOL TX 4
node --env-file=.env.local 07_verify.mjs                               # verify every hash
node --env-file=.env.local 08_strk20_json.mjs --write                  # write ../../strk20.json
```

Drop `--confirm-send` from any step to rehearse it first. Progress is kept in
`run-state.json` (gitignored): the circle id and every submitted hash.

## Why the transaction shape is what it is

Each constraint comes from the pinned protocol source, not from preference.

- **One `InvokeExternal` per pool transaction.** Each contribution therefore
  needs its own pool transaction; they cannot be batched.
- **Contributions create no open note.** The helper returns an empty span, and
  creating an open note without filling it reverts the whole transaction with
  `UNDEPOSITED_OPEN_NOTES`.
- **Payout creates exactly one open note.** The helper returns one
  `OpenNoteDeposit` and approves the pool for exactly that amount, which the
  pool pulls, leaving no residual allowance.
- **Withdraw precedes invoke.** Tokens are already in the helper when
  `privacy_invoke` runs, which is what `assert_exact_inbound_balance` checks.
- **`approve` and the pool call are separate transactions.** `apply_actions` is
  reentrancy-guarded against sharing a transaction with other calls.
- **Prove at `head - 10`.** Notes mature 10 blocks after creation, the prover
  reads finalized state, and the sequencer wants a base block at least 10
  blocks old. The tooling enforces this across script invocations from
  `run-state.json`, and re-fetches the proving block after any wait.
- **`tip: 0n` on every v3 transaction**, and proof keys are omitted entirely
  when the provider returns no proof facts — passing `proofFacts: []`
  serializes an invalid transaction that reverts with `INVALID_PROOF_FACTS`.

## Signatures

Members authorize settlement with Stark-curve signatures over
domain-separated Poseidon hashes. The JS signer is locked to the deployed
verifier by `contracts/starknet/tests/test_hash_parity.cairo`, which feeds
fixed vectors produced by `lib/iwa.mjs` straight into the contract's own
`check_ecdsa_signature` path.

`verifyIwa` re-implements the contract's full acceptance predicate — the range
and canonical low-s guards of `verify_settlement_hash`, then corelib's
`(zG + rQ).x == sR.x || (zG - rQ).x == sR.x`. Every signature is checked
against it before it is put in a transaction, so a signature the chain would
reject never gets broadcast.

Regenerate the pinned vectors with `npm run vectors` after any signer change,
then re-run the Cairo suite.

## Known operational dependencies

- **A proving service endpoint is required to send.** The pinned SDK ships no
  default; supply `IWA_PROVER_URL`. Dry runs never contact it.
- **Deposits are screened.** Since v0.14.3 the pool verifies an FPI screening
  signature on every deposit. Hosted proving attaches it; a self-hosted prover
  does not, and the usual workaround is to shield through a privacy-enabled
  wallet and transfer privately to the operator account. Contributions and
  payouts carry no deposit leg and are unaffected.
- **The helper must not be a blocked open-note depositor.** The pool maintains
  that list; the preflight checks it live, because payout cannot settle
  otherwise.
- **Helper surplus must be zero before a contribution.** A stray token transfer
  to the helper makes exact inbound accounting fail; `normalize_surplus(token)`
  is permissionless and clears it to the immutable sink.

## What STRK20 does not hide

Shielding and withdrawal are public edges. The helper invocation and its state
changes are visible. An open note's token and filled amount are public; its
owner is not. Timing can enable correlation. IWA states this rather than
claiming blanket privacy.

## Files

| | |
|---|---|
| `00_prepare.mjs` | member identities, funding, `create_circle`, joins |
| `04_deposit.mjs` | ERC-20 approvals + shield USDC (pool tx) |
| `05_contribute.mjs` | private contribution settlement (pool tx, per member) |
| `06_payout.mjs` | finalize, authorize, private payout settlement (pool tx) |
| `07_verify.mjs` | network / success / pool interaction / IWA state |
| `08_strk20_json.mjs` | writes the sprint submission file |
| `lib/preflight.mjs` | the gates, runnable standalone |
| `lib/iwa.mjs` | domain hashes and the Stark-curve signer |
| `lib/parity.mjs` | the fixture shared with the Cairo parity test |
| `lib/circle.mjs` | IWA calldata and view decoding |
| `lib/sdk-loader.mjs` | pins the vendored SDK and the pool version |
| `lib/run.mjs` | the send gate, proving window, run state |
| `lib/funding.mjs` | exact funding from the live fee |
| `lib/secrets.mjs` | environment-only secret loading |

# STRK20 Integration Research

## Verification status

Status: CORE PROTOCOL ROUTE VERIFIED

Primary IWA integration route has been verified.

Remaining before implementation:
- verify current USDC mainnet address
- verify STRK mainnet address
- verify wallet capability detection
- verify exact helper calldata design
- verify exact IWA contribution/payout state transition model
- re-check current pool/class hash immediately before deployment

## Mainnet network

Target network:

`SN_MAIN`

The STRK20 Private Sprint requires a working Starknet Mainnet product.

## Official pool

Current verified/corroborated mainnet privacy pool:

`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`

This address must be independently rechecked immediately before deployment.

The helper contract must not rely on an address copied from old notes without current verification.

## Supported asset addresses

### USDC

Native USDC on Starknet Mainnet:

`0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb`

Issuer/source verification: Circle.

IWA uses native USDC rather than legacy bridged USDC.e.

Re-verify immediately before mainnet deployment.

### STRK

STRK on Starknet Mainnet:

`0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`

Re-verify immediately before mainnet deployment.

## Recommended IWA integration route

IWA is a user-facing private dapp.

Primary route:

Starknet Wallet API + app-specific STRK20 anonymizer/helper contract.

The direct Privacy SDK is not the normal user path.

The wallet should retain responsibility for:
- viewing keys
- note discovery
- proof generation
- private transaction construction
- submission

IWA frontend must not receive the user's private viewing key.

## Wallet integration

IWA uses the Starknet Wallet API rather than directly managing STRK20 private state.

Verified baseline:

- Wallet API `>= 0.10.3`
- STRK20-capable `starknet.js`
- tested baseline: `starknet@10.4.0`
- tested companion packages:
  - `@starknet-io/get-starknet-discovery@6.0.3`
  - `@starknet-io/get-starknet-wallet-standard@6.0.3`
  - `@starknet-io/types-js@0.10.3`

Do not mix a floating modern `starknet` version with stale hard-pinned wallet packages without re-running compatibility tests.

### Capability detection

Detect STRK20 support using the wallet API version query:

const versions = await walletV6.supportedWalletApi(wallet)
const supported = versions.some((v) => compareVersions(v, "0.10.3") >= 0)

Do not call `strk20Balances()` merely to detect capability because balance access can trigger a user consent prompt.

### Shielding

Shielding requires two user-visible transactions:

1. ERC-20 approval
2. STRK20 private deposit

The UI must label these as separate steps so the second wallet prompt is not mistaken for a duplicate transaction.

### Registration

Private transfers require registered STRK20 users.

The wallet can register the sender on first use.

A recipient must also be registered before receiving a normal private transfer.

IWA must provide recipient-onboarding UX or use a separately reviewed escrow-style mechanism if pay-before-registration becomes necessary.

### Note maturity

New notes require roughly 10 blocks before they become spendable.

The frontend must represent this waiting state instead of treating a newly created note as immediately available.

### Pool fees

Read the pool fee dynamically using the pool's `get_fee_amount`.

Do not hardcode the fee.

When calculating a MAX spend, account for the pool fee before asking the user to sign.

### Transaction confirmation

Bound transaction confirmation polling with an application timeout.

A timeout means:

`submitted, confirmation not visible yet`

not:

`transaction failed`

Preserve the transaction hash/explorer link and continue polling.

### Address comparison

Normalize Starknet felt addresses before comparison.

Prefer:

BigInt(left) === BigInt(right)

instead of comparing padded and unpadded hexadecimal strings directly.

### Private DeFi dry-run

Before submitting an IWA helper transaction:

await account.strk20PrepareInvoke(actions, true)

Use this to detect malformed calldata and action construction before paying for submission.

## Private transfers

Inside the STRK20 pool, the protocol hides from public observers:
- sender
- receiver
- amount
- token
- spent note linkage

Notes use a UTXO-style model with nullifiers preventing double-spend.

## Private DeFi / IWA helper flow

A private DeFi call is one STRK20 transaction carrying two actions:

1. `transfer` with amount `"OPEN"`
2. `invoke` targeting the IWA helper

The wallet resolves:

`${openNoteIds[N]}`

and:

`${poolAddress}`

The pool performs:

withdraw from pool
→ call helper `privacy_invoke`
→ helper performs validated application action
→ helper approves pool for returned output
→ helper returns `Span<OpenNoteDeposit>`
→ pool credits the open note

## privacy_invoke requirements

The pool deserializes invoke calldata directly into the helper's `privacy_invoke` parameters.

The helper must return exactly:

`Span<OpenNoteDeposit>`

An `OpenNoteDeposit` contains:
- `note_id`
- token address
- `u128` amount

An empty span is valid when no output should be credited.

The protocol permits at most one `InvokeExternal` or `ComputeAndInvoke` operation per pool transaction.

## Action ordering

STRK20 actions use fixed phases and may never move backward:

0. SetViewingKey
1. OpenChannel
2. OpenSubchannel
3. Deposit
4. UseNote
5. CreateEncNote / CreateOpenNote
6. Withdraw
7. InvokeExternal / ComputeAndInvoke

`InvokeExternal` / `ComputeAndInvoke` is limited to at most one per transaction.

## Pool balance invariant

STRK20 tracks temporary balance per token.

Rules:
- intermediate token balance may never become negative
- final temporary balance for every token must equal zero

No value may be created, destroyed, or left unaccounted.

## IWA helper security model

IWA helper is expected to be stateful because IWA circle obligations and progression persist across transactions.

Therefore the helper should pin the verified STRK20 pool address and enforce caller authorization in `privacy_invoke`.

Conceptually:

`get_caller_address() == configured_strk20_pool`

The exact implementation must be reviewed before deployment.

The helper must additionally validate:
- supported asset
- non-zero amount where required
- circle existence
- membership/eligibility
- round
- contribution obligation
- replay state
- payout state
- note/output assumptions

The helper must not become an arbitrary-call proxy.

## Output handling

Open-note output amounts are public.

The open-note owner remains hidden.

For operations where output amount is determined by an external call, output should be derived from actual token balance delta rather than blindly trusting an external return value.

Any `u256 → u128` conversion must be explicit and fail safely.

External reverts should propagate so the entire STRK20 transaction reverts atomically.

## IWA private contribution design

Target conceptual flow:

user shielded balance
→ Wallet API builds open-note + invoke action
→ STRK20 pool withdraws contribution amount to IWA helper
→ IWA helper validates circle/round/obligation
→ valid contribution state is recorded
→ funds remain governed by deterministic IWA circle rules

Task 8A-S locks the fund-holding boundary: helper-confirmed contribution and
cure inflows are attributed to one exact circle/round/token liability. Public
callers cannot consume their financial settlement state.

The helper must not publicly expose the member identity unnecessarily.

## IWA private payout design

Target conceptual flow:

eligible IWA payout
→ deterministic scheduled recipient
→ STRK20 helper/pool interaction
→ recipient receives private note

Admin must not choose or redirect the recipient.

Payout and recovery settlement signatures bind the rightful member's open-note
id, configured helper, configured pool, locked token, stored amount, circle,
round, member, and nonce under separate domains.

## What remains public

STRK20 does not make every application action invisible.

Public or potentially public:
- shielding/deposit edge
- withdrawal edge
- timing
- helper contract invocation
- helper-side state changes
- open-note token
- open-note filled amount
- application-specific public state

IWA must minimize helper-side metadata and must not claim helper action amounts are fully hidden.

## Viewing keys and compliance

Each user has:
- private viewing key held by the user
- public viewing key registered on-chain

The private viewing key is also encrypted to the protocol auditor's public key.

Under authorized recovery of that viewing key, an auditor can inspect that user's transaction history.

A viewing key cannot spend user funds.

## Selective disclosure capability

STRK20's built-in disclosure model is primarily auditor-oriented viewing-key disclosure.

Recovered viewing keys can reveal detailed history for the selected user.

This does NOT directly satisfy IWA's product requirement for a reusable scoped claim such as:

`completed at least 3 savings cycles with no defaults`

while revealing no raw history.

## Decision: Legacy Circom/Groth16

PARTIAL REUSE / REBUILD MINIMALLY

Reason:

IWA requires scoped Portable Trust Credentials that reveal only the requested reliability claim.

STRK20 provides private transfers and auditor-oriented history disclosure, but the researched protocol material does not provide the exact IWA scoped reputation-proof primitive.

Therefore:

- preserve `iwa-circuit/`
- preserve `iwa-prover/`
- audit the legacy proof design
- reuse only sound business/proof concepts
- rebuild or adapt the smallest proof layer necessary
- do not mechanically port the previous Stellar verifier

STRK20 remains responsible for payment privacy.

The IWA credential ZK layer is responsible only for proving scoped reliability claims.

## Privacy limitations

Known limitations relevant to IWA:

- deposits are public edges
- withdrawals are public edges
- timing may enable correlation
- distinctive amounts may weaken privacy
- helper actions may be visible
- open-note amounts are public
- app-side state transitions can leak information if designed poorly

IWA must document these honestly.

## Mainnet sprint requirements

To be scored, the project requires at least three successful Starknet Mainnet transactions that touched the STRK20 pool and are listed in `strk20.json`.

A successful transaction hash alone is insufficient.

Each transaction must be verified for:
- correct network
- success
- STRK20 pool interaction
- expected IWA behavior

## Locked Task 8A-S core settlement design

### Cairo privacy package pin

Task 8A uses the official StarkWare `privacy` Cairo package from
`https://github.com/starkware-libs/starknet-privacy`, pinned immutably to
`66e3caae8c0201227a6719696d004e30d90aea65`. This is the revision resolved
from the official `PRIVACY-0.14.3-RC.5` tag on August 28, 2026. The required
protocol return type is `privacy::objects::OpenNoteDeposit`. The IWA toolchain
remains Scarb/Cairo 2.18.0 with `starknet` 2.17.0; compatibility must pass the
workspace build before helper production code is accepted.

`IwaCircle` constructor configuration pins the privacy pool, supported tokens,
and a deployment-only setup authority. Deployment then creates the helper with
the resulting circle address and uses the authority once to initialize that
exact helper. Initialization locks permanently and clears the authority. The
deployment is not valid until onchain reads confirm the helper, lock, and
cleared authority. Financial entrypoints reject before that point.

Contribution and cure are inbound parked-value legs and bind no output note.
Payout and recovery are outbound legs and require a member-signed open-note id
before `Paid` or `Recovered`.

For every round:

```text
scheduled_payout_amount = contribution_amount * member_limit
round_unresolved_deficit = sum(all exact uncured default deficits)
round_funded_liability = scheduled_payout_amount - round_unresolved_deficit
```

Full payout requires zero unresolved deficit. Final recovery uses the
separately stored round-funded amount while preserving nominal payout and
recipient. There is no external subsidy or cross-round/cross-token borrowing.
Task 8A must reconcile actual helper balances with these core liabilities
atomically.

The zero-funded edge does not enter STRK20. Final preparation records
`NoFundedRecovery` when the derived recovery amount is zero. No
`privacy_invoke`, zero-value `OpenNoteDeposit`, signature, or nonce is used.
Only positive `RecoveryPending` amounts may reach the later helper recovery
operation; `Recovered` remains reserved for confirmed funded token movement.

## Open risks

- current wallet support must be validated
- exact wallet API version compatibility must be rechecked during implementation
- exact USDC mainnet address still needs verification
- exact STRK mainnet address still needs verification
- helper state machine not yet implemented
- helper not yet audited
- mainnet pool/class hash must be rechecked before deployment
- credential circuit has not yet been re-audited
- public metadata leakage from the IWA state machine remains to be designed carefully

## Task 8B verified pool behavior (read from pinned source)

Everything in this section was read directly from the pinned revision
`66e3caae8c0201227a6719696d004e30d90aea65`, package `packages/privacy`.
Line references are to that revision. Nothing here is inferred from memory.

### Invoke entrypoint and selector

`privacy::utils::constants::INVOKE_SELECTOR = selector!("privacy_invoke")`
(`utils.cairo:83`). The pool reaches an application helper only through that
selector, so the IWA helper entrypoint name is correct.

`ComputeAndInvoke` uses `INVOKE_WITH_COMPUTATION_SELECTOR =
selector!("privacy_invoke_with_computation")` (`utils.cairo:89`). IWA does not
implement that selector and therefore cannot be driven through that path.

### Calldata encoding

`InvokeExternalInput { contract_address, calldata: Span<felt252> }`
(`actions.cairo`). The pool forwards `calldata` verbatim through
`call_contract_syscall` (`privacy.cairo:983-987`). There is no envelope,
length prefix, or operation tag added by the protocol: the helper's own
`privacy_invoke` ABI is the encoding. IWA's parameter order
`(operation, circle_id, round, member_ref, token, open_note_id, nonce,
signature_r, signature_s)` is therefore the whole contract.

### Return encoding

The pool deserializes the return data as `Span<OpenNoteDeposit>` and then
asserts the buffer is fully consumed (`privacy.cairo:989-991`,
`INVALID_INVOKE_RETURN_DATA`). Returning anything else, or trailing bytes,
reverts.

`OpenNoteDeposit { note_id: felt252, token: ContractAddress, amount: u128 }`
(`objects.cairo:104-111`). This matches the IWA helper exactly.

An empty span is valid and is the correct encoding for "no output note".

### Inbound value: pool to helper

Inbound value reaches the helper as `ServerAction::TransferTo`, applied by
`_apply_transfer_to` as a plain ERC20 `transfer` from the pool. `TransferTo`
is produced by the client `Withdraw` action, which sits in `WITHDRAW_PHASE`
(6) while `InvokeExternal` sits in `INVOKE_PHASE` (7), and
`assert_and_advance_phase` forbids moving backwards (`actions.cairo`).

Verified consequence: tokens are already in the helper before
`privacy_invoke` is called. The IWA helper's `assert_exact_inbound_balance`
is therefore correctly placed.

### Outbound value: helper to pool

The pool does not receive outbound value from the return value. For each
returned deposit it calls `_deposit_to_open_note` with
`depositor = the invoked contract` (the helper), which performs
`checked_transfer_from(token, sender: helper, recipient: pool, amount)`
(`privacy.cairo:1032-1037`).

Verified consequence: the helper MUST hold an ERC20 approval to the pool for
exactly the returned amount at the moment it returns. The IWA helper's
`approve_pool` is required, and its exact-amount approval is consumed in full
by the pull, leaving zero residual allowance.

### Open-note deposit rules enforced by the pool

`_deposit_to_open_note` (`privacy.cairo:1010-1043`) asserts, in order:

- `token.is_non_zero()` — `ZERO_TOKEN`
- `amount.is_non_zero()` — `ZERO_AMOUNT`
- the note exists — `NOTE_NOT_FOUND`
- `salt == OPEN_NOTE_SALT` — `NOTE_NOT_OPEN`
- the note's current amount is zero — `NOTE_ALREADY_DEPOSITED`
- `token == note.token` — `TOKEN_MISMATCH`

Verified consequences for IWA:

- A zero-amount output note can never be credited. IWA's `NoFundedRecovery`
  design, which returns an empty span rather than a zero-value deposit, is the
  only encoding the protocol accepts.
- An open note can be filled at most once, protocol-side. This is an
  additional, independent replay bound on top of IWA's own nonce domains.
- The output token is bound to the note itself, independently of IWA's own
  token binding.

### Open-note accounting invariant

`_apply_actions` counts open notes: every `EmitOpenNoteCreated` increments
`undeposited_open_notes`; each returned deposit decrements it via
`checked_sub` (`privacy.cairo:1002-1004`), and the whole transaction ends with
`assert(undeposited_open_notes == 0, UNDEPOSITED_OPEN_NOTES)`
(`privacy.cairo:903`).

Verified consequences:

- Returning more deposits than open notes created panics with
  `TOO_MANY_OPEN_NOTES_DEPOSITED`.
- Creating an open note and returning an empty span reverts the whole
  transaction with `UNDEPOSITED_OPEN_NOTES`.
- Contribution and cure, which return an empty span, must therefore be
  submitted without a `CreateOpenNote` action. Payout and recovery must be
  submitted with exactly one.

### Client-side open-note creation

`create_open_note` (`privacy.cairo:674-710`) compiles one `CreateOpenNote`
client action into exactly two server actions:

1. `to_write_once_action(storage_address, open_note(token))`, where
   `open_note(token) = Note { packed_value: OPEN_NOTE_PACKED_VALUE, token }`
2. `ServerAction::EmitOpenNoteCreated(OpenNoteCreated { enc_recipient_addr,
   token, note_id })`

`enc_recipient_addr` is an auditor-encrypted blob that the pool emits but never
validates.

### Revert propagation

The pool calls the helper with `call_contract_syscall(...).unwrap_syscall()`
(`privacy.cairo:983-987`). A helper revert is not caught: it propagates and
reverts the entire pool transaction, together with every token movement,
storage write and event in that transaction. `apply_actions` is additionally
documented as all-or-nothing (`interface.cairo:410-420`).

### Caller observed by the helper

The pool invokes from its own contract context, so the helper observes
`get_caller_address() == pool address`. The protocol's own documentation on
`InvokeWithComputation` states the target "should assert the caller is the
privacy contract, otherwise anyone could invoke it directly and bypass the
privacy pool" (`actions.cairo:428-430`), which is exactly IWA's
`NOT_PRIVACY_POOL` guard.

### Action ordering and the one-invoke rule

`ClientActionTrait::assert_and_advance_phase` (`actions.cairo`) enforces
non-decreasing phases and advances past `INVOKE_PHASE` after an invoke, so at
most one `InvokeExternal`/`ComputeAndInvoke` may appear per transaction. IWA
uses exactly one.

### Other guards on the pool entrypoint

`apply_actions` (`privacy.cairo:782-799`) is callable by any address, but:

- it is reentrancy-guarded, so an invoked helper cannot call back into
  `apply_actions`
- it fails when the pool is paused
- `validate_proof` requires the transaction to carry `proof_facts` whose
  `message_to_l1_hashes` equals `[compute_message_hash(actions, pool)]`
  (`privacy.cairo:804-838`)
- `collect_fee` pulls `fee_amount` STRK from the caller when non-zero
- a `TransferFrom` (regular-pool deposit) additionally requires a
  screener-signed attestation; IWA's helper flows contain no `TransferFrom`
  and therefore require no screening

The pool also maintains `blocked_open_note_depositors`; a blocked depositor
cannot credit open notes (`OPEN_NOTE_DEPOSITOR_BLOCKED`). The IWA helper is an
open-note depositor and is therefore subject to that list. This is an
operational dependency on the pool operator, not something IWA controls.

### Consistency with the Task 8A helper

No contradiction was found between the pinned protocol source and the Task 8A
helper. Specifically confirmed consistent: entrypoint selector, calldata
shape, return type, empty-span encoding, inbound-before-invoke ordering,
outbound approval-and-pull, exact-amount approval with no residual allowance,
zero-amount output rejection, and revert atomicity.

## Task 8B local harness and its deployment caveat

The integration harness deploys the genuine pinned `privacy::privacy::Privacy`
contract locally. To make it declarable from `snforge`, `Scarb.toml` carries:

```toml
[[target.starknet-contract]]
build-external-contracts = ["privacy::privacy::Privacy"]
```

### Caveat: the pool also appears in production build artifacts

Because that setting sits on the package's `starknet-contract` target, a plain
`scarb build` emits three contract classes rather than two:

```
IwaCircle, IwaStrk20Helper, Privacy
```

`Privacy` is StarkWare's pool. IWA must never declare or deploy it: the mainnet
pool already exists at the address recorded above. Deployment tooling must name
`IwaCircle` and `IwaStrk20Helper` explicitly and must never iterate over every
artifact in `target/dev`.

Confining the pool to the test target alone was attempted and rejected. Adding
an explicit `[[test]]` target with `source-path = "tests/lib.cairo"` and the
`build-external-contracts` entry does keep production artifacts clean, but the
declared test target then builds *only* the listed external contracts and drops
the package's own, so every test that declares `IwaCircle`, `IwaStrk20Helper`,
or `TestErc20` fails with:

```
Failed to get contract artifact for identifier = IwaCircle.
```

Verified: 15+ previously green tests fail under that layout. The remaining
option, listing IWA's own contracts as "external" from the test crate, is
untested and interacts awkwardly with the feature-gated `TestErc20`. Until that
is resolved, the package-level setting stays and the deployment caveat above is
the mitigation.

## Finding 8B-01 resolved: unaccounted surplus handling

Verified against the real pool: a 1-unit ERC20 donation to `IwaStrk20Helper`
made `assert_exact_inbound_balance` reject every later contribution and cure in
that token, permanently, with no recovery path.

Fixed under approved Option B. Exact inbound accounting is unchanged.

Accounted custody for a token is `token_liability` — the sum of that token's
legitimate round liabilities. Surplus is `balance - accounted custody`.

`normalize_surplus(token)` is permissionless and narrowly scoped: supported
tokens only, requires `balance >= accounted custody`, moves exactly the
difference to the immutable `surplus_sink` pinned at deployment, and reverts
when there is no surplus. It writes no storage, so it cannot create backing,
satisfy a settlement, consume a nonce, or alter a payout recipient, default, or
cure record. `get_surplus(token)` exposes the same figure as a view.

The helper constructor now takes a fifth immutable argument, `surplus_sink`,
validated non-zero and distinct from the helper itself, the privacy pool, and
both configured tokens. Deployment must choose this address deliberately: it is
immutable, and it receives any tokens mistakenly sent to the helper.

Regression coverage lives in `tests/test_strk20_pool_integration.cairo` and
proves donations never become backing, normalization restores exact inbound
settlement through the real pool, legitimate backing can never be swept,
tokens stay isolated, and the caller cannot choose the destination or profit.

## Task 8C: mainnet address re-verification (2026-08-29)

Re-verified from current authoritative sources, not from memory or from earlier
notes in this document. Two independent kinds of evidence were used: published
documentation, and direct read-only calls against Starknet mainnet.

The RPC endpoint `https://api.cartridge.gg/x/starknet/mainnet` returned chain id
`0x534e5f4d41494e` (`SN_MAIN`), confirming the calls below were made against
mainnet. No transaction was sent.

### STRK20 privacy pool — CONFIRMED

`0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`

- `starknet_getClassHashAt` returned class
  `0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d`,
  so a contract is deployed there.
- `get_version()` returned `0x322e30`, which is the short string `"2.0"` —
  exactly `privacy::utils::constants::CONTRACT_VERSION` in the pinned revision.
- `get_fee_amount()` and `is_open_note_depositor_blocked(...)` both answered,
  so the address exposes the pinned pool's `IViews`/`IFees` interface.

This is the strongest available evidence short of a class-hash match: the
address answers the exact view interface of the pinned pool at the pinned
version. Web search did **not** corroborate the address from documentation, and
the pinned repository does not contain any mainnet address, so the on-chain
interface probe is the verification of record. Re-run it immediately before
deployment with `deploy/iwa-deploy.sh validate`.

### Native USDC — CONFIRMED

`0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb`

- Listed as the Starknet mainnet USDC address in Circle's official developer
  documentation (`developers.circle.com/stablecoins/usdc-contract-addresses`).
- On chain: `symbol()` = `"USDC"`, `decimals()` = `6`, `name()` = `"USDC"`.

Note the bridged token `USDC.e`
(`0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8`) is a
**different** contract. IWA uses native USDC only.

**Six decimals.** One USDC is `1_000_000`. Any UI or amount arithmetic must not
assume 18.

### STRK — CONFIRMED

`0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`

- Corroborated by `starknet-io/starknet-addresses` and Starkscan.
- On chain: `symbol()` = `"STRK"`, `decimals()` = `18`,
  `name()` = `"Starknet Token"`.

### Live pool fee — new operational finding

`get_fee_amount()` returned `6000000000000000000`, i.e. **6 STRK per
`apply_actions` call**, pulled from the caller by `collect_fee` via
`checked_transfer_from` on the STRK token. Local integration tests ran against a
pool deployed with a zero fee, so this cost does not appear in them.

Consequences: whoever submits an IWA pool transaction must hold STRK and have
approved the pool for the fee, and the fee must be read live rather than
hardcoded, since a governance action can change it.

### Verification method

Reproduce with:

```
contracts/starknet/deploy/iwa-deploy.sh validate <config.json>
```

which repeats the chain-id check, the pool class and interface probe, and the
token symbol and decimals checks, and sends nothing.

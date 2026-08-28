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

`IwaCircle` constructor configuration pins one reviewed settlement helper and
one privacy pool. Contribution and cure are inbound parked-value legs and bind
no output note. Payout and recovery are outbound legs and require a
member-signed open-note id before `Paid` or `Recovered`.

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

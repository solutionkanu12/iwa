# IWA — Security

## Security posture

IWA is a financial product.

Security is a release gate, not a final checklist item.

No component should be described as secure merely because:

- tests pass
- a transaction succeeds
- the contract compiles
- the UI works
- an agent says the code looks safe

Security claims must map to concrete properties that were reviewed or tested.

## Core security goals

IWA must protect:

1. user funds
2. private financial relationships
3. contribution integrity
4. payout integrity
5. credential integrity
6. admin boundaries
7. protocol configuration
8. signing and secret material
9. reliability history
10. recovery paths

## Non-custodial rule

IWA admins, backend services and operational infrastructure must not have unilateral control over user funds.

The system must not require the IWA team to hold:

- wallet seeds
- private keys
- user signing keys
- viewing keys
- custodial withdrawal authority

Where a protocol interaction requires signing, the signing authority must be explicitly documented and minimized.

## Trust boundaries

Major boundaries:

```text
User
  ↓
Wallet
  ↓
STRK20
  ↓
IWA Cairo contracts
  ↓
Starknet state
```

Supporting systems:

```text
Frontend
Backend / Indexer
Admin Dashboard
RPC Providers
Deployment Tooling
CI/CD
```

Each boundary must be reviewed separately.

## Privacy boundary

The following must not leak through the backend, frontend logs, analytics or admin tools:

- private contribution details
- private payout relationships
- viewing keys
- wallet private keys
- signing secrets
- raw private transfer graph
- raw credential evidence
- unnecessary wallet-to-person mappings

Public exposure must be minimized to what protocol correctness and usability require.

### Public by construction

These are **not** leaks; they are unavoidable properties of the current design
and must be described honestly rather than defended as private:

- the invite secret, once submitted in `join_circle` calldata
- the `member_ref` commitment, in the payout order, events and settlement paths
- the correlation between the joining wallet and that `member_ref`, because the
  join transaction has a public sender
- circle existence, size, cadence, asset and round progression
- deposit and withdrawal edges at the STRK20 boundary, transaction timing,
  helper invocation, and open-note amounts

STRK20 gives IWA private settlement transfers. It does not give IWA anonymous
membership. Product copy, UI and marketing must not imply otherwise.

## STRK20 integration rule

Do not implement STRK20 behavior from memory.

Before protocol code is written:

- read the installed STRK20 skill
- read its bundled references
- confirm exact transaction ordering
- confirm helper/anonymizer contract expectations
- confirm caller validation requirements
- confirm note handling
- confirm output handling
- confirm supported disclosure behavior
- confirm current mainnet addresses

If documentation and assumptions conflict, documentation wins until independently verified.

## STRK20 pool validation

The official STRK20 pool address used for the sprint must be verified from current upstream documentation before deployment.

Never rely only on:

- an old conversation
- copied notes
- agent memory
- a stale environment file

Deployment and runtime configuration should fail closed when the configured pool does not match the expected verified pool.

## Helper-contract security

If `IwaStrk20Helper` is used, it is a high-risk boundary.

Review at minimum:

- allowed caller
- expected STRK20 pool
- supported function selectors
- token allowlist
- circle existence
- round state
- contribution obligation
- amount validation
- replay protection
- note/output validation
- duplicate-state transitions
- external calls
- failure/revert behavior

The helper must not become a generic arbitrary-call proxy.

## Caller authorization

Sensitive functions must explicitly validate their caller.

Never assume that because a function is intended to be called by STRK20, only STRK20 will call it.

Where required by protocol architecture:

```text
caller == verified STRK20 pool
```

must be enforced.

Other privileged methods require similarly explicit role validation.

### Member contribution authorization

Public `member_ref` commitments and invite secrets observed in join calldata
are not contribution credentials. Each member instead registers a separate
IWA authentication public key during join and retains the private key.

The key uses the Stark curve and Cairo corelib's established ECDSA verifier.
IWA additionally enforces the verifier's documented `r`/`s` range requirements
and canonical low-`s` form. No custom signature algorithm is implemented.

The signed contribution authorization is domain-separated with
`IWA_CONTRIBUTION_V1` and binds `circle_id`, `round`, `member_ref`, exact
`amount`, and `nonce`. It is not bound to `get_caller_address()` and must not
contain a wallet private key, viewing key, or invite secret.

## Asset allowlist

First release:

- USDC
- STRK

Reject unknown assets.

Do not treat arbitrary token addresses supplied by a user as trusted.

When future assets are added, each asset must receive explicit configuration and review.

## Circle-state invariants

These properties must hold regardless of transaction ordering or user behavior.

### Payout order

Once the first active contribution begins:

- payout order cannot be changed
- recipient order cannot be rewritten by admin
- arbitrary recipient substitution is forbidden

### Contribution uniqueness

A contribution obligation cannot be satisfied more than once.

Replay of a previously accepted contribution must fail.

### Payout uniqueness

A payout for a round cannot execute more than once.

### Historical immutability

A completed contribution state cannot be silently rewritten.

Examples:

```text
MISSED_DEFAULT → ON_TIME
```

must not be possible through admin intervention.

### Round progression

Rounds cannot finalize before all required deterministic conditions are met.

Round numbers cannot:

- skip unexpectedly
- move backward
- finalize twice

### Deficit handling

An unresolved deficit follows predefined rules.

Admin cannot:

- ignore it arbitrarily
- reroute locked payout
- fabricate a cure
- change the member's historical state

## Accounting invariants

The exact accounting invariant depends on the final STRK20 integration model.

Before mainnet, define and test an equation describing all value entering and leaving each circle.

Conceptually:

```text
accepted value
=
unsettled value
+ successfully distributed value
+ valid recoveries/withdrawals
+ explicitly accounted protocol fees
```

There must be no unexplained value creation or loss.

Every new fee path must be included in the invariant.

## Timestamp and grace security

Grace behavior must be deterministic.

Review:

- Starknet timestamp semantics
- boundary timestamps
- exact due-time comparison
- exact grace-expiry comparison
- late contribution at boundary
- sequencer timestamp assumptions

Avoid ambiguous logic such as multiple components calculating the deadline differently.

## Replay protection

Any contribution or payout operation that could be replayed must include a unique state-bound identifier.

Possible components include:

```text
circle id
round
member commitment/ref
obligation identifier
action type
nonce/nullifier/protocol identifier
```

Exact mechanics must match STRK20's supported model.

For IWA contributions, Task 6D must store nonce consumption atomically with
the obligation transition. A valid signature without an unused, state-bound
nonce is insufficient. Task 8 must call that transition only from the verified
STRK20 helper route while preserving the same signature and nonce checks.

## External calls

Minimize external calls.

For every external call:

- document target
- document authority
- document expected return/failure behavior
- consider reentrancy/state-ordering issues
- update protected state in a safe sequence

No user-supplied arbitrary destination/call-data feature may be introduced without a separate security design.

## Admin security model

Admin is operational, not custodial.

Admin may have controlled abilities such as:

- narrow emergency pause
- operational configuration where explicitly safe
- support tooling
- monitoring
- approved feature toggles

Admin must not be able to:

- seize funds
- spend user balances
- alter payout order
- choose payout recipients
- falsify contributions
- erase defaults
- rewrite completed rounds
- forge credential results
- reveal viewing keys
- reveal private transfer history

## Least privilege

Administrative roles should be separated where it materially reduces risk.

Potential future roles:

```text
OPERATIONS
PAUSER
CONFIG_MANAGER
AUDITOR
SUPPORT
```

Do not introduce role complexity merely for appearance.

The first implementation may use a smaller role model if it still preserves least privilege.

## Emergency pause

The pause must be narrowly scoped.

Preferred behavior:

Pause:

- new joins
- new contributions
- newly initiated risky operations when necessary

Do not automatically pause safe recovery paths unless the discovered vulnerability affects them.

The pause must not:

- transfer funds to admin
- change ownership
- rewrite state
- redirect payout
- create unlimited freeze authority without recovery design

Every pause/unpause action should be auditable.

## Recovery design

Recovery paths must avoid converting IWA into a custodial service.

Where funds can safely be recovered:

- authorization should remain with the rightful user or deterministic contract logic
- amounts must derive from verified state
- recovery must not bypass payout/accounting invariants
- recovery actions must be replay protected

The deployed v1 contracts satisfy the first four points and do not satisfy the
fifth. No recovery path exists for a member who loses the key that authorizes
their own payout. That gap is finding H-2 and is described in full in the next
section. It was accepted knowingly for this deployment rather than resolved,
and the contracts are immutable, so it cannot be changed without a new version.

## Payout liveness and a lost member key

This is finding H-2 from the Phase 6 audit. It is a liveness limitation of the
deployed design, not a defect in the backend, the frontend, the organizer flow
or the STRK20 caller. It is recorded here because it is the most serious known
limitation of the current contracts and it cannot be fixed in place.

### The condition

Every round has one scheduled recipient, fixed at creation. Before that round's
pot can settle, the scheduled member must call `authorize_payout_settlement` and
present a signature that verifies against `member_auth_keys[(circle_id,
member_ref)]`. That key is the public half of a keypair the member derives in
their own browser from one wallet signature. It is written once, when they join,
and there is no setter anywhere in the contract.

If that member permanently loses access to the wallet the key was derived from,
or simply refuses to sign, the required authorization can never be produced.
The round's pot then stays where it is, indefinitely.

The effect is wider than one round. `prepare_final_settlement` refuses to run
while any round is still `Scheduled`, and it does so deliberately: the preflight
loop treats a scheduled payout as a rightful claim that must not be silently
converted to recovery or discarded. That protects the rightful recipient from
having their entitlement taken away, and the price of it is that one unreachable
key can also stop the circle from being finalized.

### Why it happens

It follows directly from two decisions that are otherwise correct.

The first is that a member is a commitment, not an address, and their authority
over their own money is a key only they hold. Nobody else can produce that
signature, which is exactly the property that makes the payout order impossible
for an organizer or an operator to redirect.

The second is that the contracts carry no administrative power at all. There is
no owner, no pause, no setter and no upgrade path. `setup_authority` is written
once at deployment and burned to zero, which can be read from chain.

Together these mean the only party who can release a round's pot is the member
it belongs to. When that member is unreachable, so is the pot.

### Who cannot recover it

Nobody. Stated precisely, because the distinction matters:

- The organizer cannot. Every settlement hash binds `member_ref`, and the
  organizer holds no key that satisfies it.
- Iwa cannot. There is no admin function, no seizure path, and no key held by
  the operator that any settlement function will accept.
- The other members cannot. Authorization is per member, not by threshold.
- The helper cannot. `IwaStrk20Helper` accepts calls only from the privacy pool
  and moves tokens only along a settlement the circle contract has authorized.
- A redeployment cannot. The deployed contracts are immutable and the funds are
  accounted against the deployed instances.

`normalize_surplus` on the helper deserves an explicit mention, because it is
permissionless and it does move tokens, and it must not be mistaken for a rescue
path. It can only move surplus, meaning the amount held above the sum of every
accounted round liability. A stranded pot is an accounted round liability, so it
is not surplus. The function asserts `surplus != 0` and would revert, and it
finishes by asserting the remaining balance still equals the accounted total, so
it cannot reduce backing for a real obligation. Its destination is immutable
storage rather than a parameter, so a caller cannot direct value anywhere.

### What is not true

The funds are not stealable, and no one can redirect them. Every settlement
function binds the circle, the round, the member commitment, the helper, the
pool, the token, the exact amount and the destination note into the hash that is
signed. A signature for one payout cannot be spent on another, and there is no
recipient substitution anywhere in the design.

This is also not an active exploit, and it does not mean funds are generally
unsafe. It is a liveness condition with one trigger: the scheduled recipient of
a round becoming unable or unwilling to authorize their own settlement. Circles
whose members retain access to their wallets are unaffected, and the accounting
invariants hold either way.

### Current status

Accepted as a known limitation of this deployment. Fixing it properly requires
a new contract version, described under Contract versioning below. No patch is
being rushed into the deployed contracts, because they cannot be patched, and no
administrative override is being added, because that would trade a liveness
problem for a custody problem.

### Options considered for a future contract version

None of these are implemented. They are recorded so the v2 design starts from an
argued position rather than from scratch.

**A. Time locked fallback recipient.** After a long, fixed delay with no
authorization, settlement may proceed to a destination fixed before the circle
started.

*Liveness:* solves it, and is the only option here that works when the member is
genuinely gone rather than merely inconvenienced. *Custody:* stays
non-custodial if the fallback is committed at creation and cannot be edited.
*Attack surface:* the delay is the whole defence. Too short and it becomes a
denial of service against a member who is briefly offline. *Abuse risk:* the
main one is choosing the fallback badly, so it should be the member's own second
destination rather than the organizer's. *Organizer power:* none, provided the
organizer never chooses the fallback. *Admin power:* none. *Payout order:*
unchanged. The rotation and the amounts stay deterministic; only the destination
of one settlement changes, and only after a published delay. *Privacy:* the
fallback destination is another note, so the pool model is unchanged, though a
fallback that fires is publicly visible as a fallback. *Deployment:* new
contract version.

**B. Member designated recovery key.** A member registers a second public key at
join time, and either key can authorize their payouts.

*Liveness:* solves the lost device case, not the lost person case. *Custody:*
fully non-custodial, and the cleanest fit with the existing model, since it
changes one key lookup into two. *Attack surface:* doubles the number of keys
that can authorize a payout, so a compromised recovery key is as good as the
primary. *Abuse risk:* low, but people store both halves in the same place and
lose both together. *Organizer power:* none. *Admin power:* none. *Payout
order:* unchanged. *Privacy:* unchanged, since the key is already public and
already written per member. *Deployment:* new contract version, and a real
product question about how a person is asked to keep a second key safe without
the request being ignored.

**C. Multi key account or passkey recovery.** Recovery moves into the account
layer instead of the circle, using an account contract that supports several
signers.

*Liveness:* solves it for accounts that have it, and does nothing for members
who joined with a plain wallet. *Custody:* non-custodial, and the recovery
question moves to a layer that is designed for it. *Attack surface:* inherits
whatever the account implementation allows, which is outside Iwa's control.
*Abuse risk:* depends entirely on the account. *Organizer and admin power:*
none. *Payout order:* unchanged. *Privacy:* unchanged. *Deployment:* this is
the most natural home for the problem long term, especially alongside embedded
Iwa accounts, but it cannot be relied on as the only answer while members join
with wallets Iwa does not control. Worth noting that today's member key is
derived deterministically from a wallet signature, so this option depends on the
wallet rather than replacing the dependency.

**D. Guardian or social recovery threshold.** A quorum of nominated parties can
jointly authorize a payout the member cannot.

*Liveness:* solves it, including the lost person case. *Custody:* preserves
non-custody only if the member alone nominates the guardians and Iwa is never
one of them. *Attack surface:* the largest of the five. A threshold that can
release a payout is a threshold that can be colluded into releasing it, and in a
savings circle the obvious guardians are the other members, who are exactly the
people with an interest in the pot. *Abuse risk:* high for that reason.
*Organizer power:* dangerous if the organizer can nominate or serve, because it
reintroduces exactly the redirection the fixed payout order exists to prevent.
*Admin power:* none if Iwa is structurally excluded. *Payout order:* unchanged,
but the recipient effectively becomes negotiable, which weakens the guarantee
people are being asked to trust. *Privacy:* guardians learn a member's
participation. *Deployment:* new contract version. Recommended only with
guardians outside the circle, and not as the first mechanism.

**E. Escrow or administrative recovery.** Iwa, or an escrow it controls, can
release a stranded pot.

*Liveness:* solves it. *Custody:* destroys the property the product is built
on. *Attack surface:* creates a key whose compromise reaches every circle at
once, and makes Iwa a target and a regulated custodian. *Abuse risk:*
structural rather than hypothetical, and no policy statement constrains a key
that exists. *Organizer power:* unchanged. *Admin power:* total, which is the
objection. *Payout order:* nominally unchanged, though an administrator who can
release funds can in practice redirect them. *Privacy:* an administrator with a
release path needs enough visibility to decide when to use it. *Deployment:*
**rejected.** AGENTS.md states that admin must never be able to seize or move
user funds, and this is that, whatever it is called.

### Invariants any future recovery must preserve

- The organizer cannot redirect a payout.
- Iwa cannot seize funds, under any name or process.
- The payout order stays deterministic and fixed at creation.
- No arbitrary recipient substitution. Any alternative destination is committed
  before funds are, and is not chosen after the fact.
- Recovery cannot trigger immediately. A delay long enough to be clearly not an
  attack is part of the safety, not a detail.
- The recovery path is known to every member before they commit money, not
  introduced afterwards.
- Recovery is auditable. It emits its own event and is distinguishable on chain
  from an ordinary settlement.
- The privacy model is not weakened silently. Any new disclosure is stated.

Option A with the fallback destination chosen by the member, optionally combined
with B, satisfies all eight. That is the direction to design against.

## Contract versioning

H-2 cannot be fixed in the deployed contracts. They have no upgrade path by
design: no owner, no pause, no setter, no class replacement, and a setup
authority burned to zero. This is a property worth keeping, and the cost of
keeping it is that a fix means a new deployment.

A future `IwaCircle` v2 should carry the chosen recovery mechanism. When it
exists:

- Existing circles stay on v1. They cannot be migrated, and pretending otherwise
  would be false.
- New circles can use v2 once it has been audited. Nothing forces a move.
- There is no forced migration and no shared upgrade switch, because there is
  nothing to switch.
- The application should be able to tell a person which version a circle runs
  on and what that version can do, so the difference is visible rather than
  implied.

None of this is implemented.

## Portable Trust Credential security

A credential must only prove facts derivable from valid protocol history.

Threats include:

- forged reliability
- replayed credentials
- stale claims
- cross-user credential reuse
- credential copied outside its intended context
- excess disclosure
- verifier correlation

Credential design should consider:

- claim scope
- user binding
- validity period
- verifier/context binding where useful
- replay model
- revocation/expiry model if required
- minimal disclosure

Do not publish raw contribution history just to make credential verification easy.

## ZK security

The legacy Circom/Groth16 code is not automatically trusted because it previously worked.

If reused:

- re-audit circuit constraints
- check unconstrained signals
- check public/private inputs
- check field conversions
- review witness generation
- review proof binding
- review replay behavior
- review verifier correctness
- review trusted setup assumptions where applicable

If STRK20 makes the separate proof system unnecessary, remove the unnecessary cryptographic surface rather than maintaining it for complexity.

## Frontend security

The frontend must not leak private information through:

- console logs
- analytics payloads
- error-reporting tools
- URLs/query strings
- browser storage
- copied debug payloads
- wallet error messages
- screenshot-friendly debug panels

Review browser storage deliberately.

Do not persist secret material in:

```text
localStorage
sessionStorage
IndexedDB
cookies
```

unless the relevant protocol/library explicitly requires a secure pattern that has been reviewed.

## Wallet security

Never request:

- seed phrase
- raw private key

IWA should use wallet authorization.

The application must clearly verify:

- connected chain
- intended account
- transaction intent
- supported wallet behavior

Wrong-network actions must fail closed.

## Backend security

Backend stores only public/non-sensitive information unless a future feature receives a new explicit security design.

Required protections:

- authentication for admin endpoints
- authorization per privileged action
- input validation
- rate limiting where useful
- secure secret storage
- database access controls
- audit logging
- dependency review
- no sensitive data in logs

## Admin dashboard security

Admin dashboard must not expose private user data merely because it is privileged.

Every sensitive admin mutation must be:

- authenticated
- authorized
- attributable
- logged

Financial-control actions not allowed by this architecture must not exist as hidden UI controls.

## API security

Future B2B verification APIs should use:

- scoped API credentials
- usage limits
- rate limiting
- revocation
- audit logs
- claim-minimizing responses

An API client should not gain access to full user savings history.

## Secrets policy

Never commit:

- private keys
- wallet seeds
- API secrets
- database passwords
- auth secrets
- deployment signing material
- private RPC credentials
- viewing keys

Before every meaningful push:

```bash
git diff --cached
```

must be reviewed for secrets and unrelated changes.

Where available, run automated secret scanning.

If a secret is exposed, treat it as compromised and rotate it.

## Environment files

Real environment files should not be committed.

Prefer:

```text
.env
.env.local
.env.*.local
```

in `.gitignore`.

Commit only sanitized examples such as:

```text
.env.example
```

with placeholder values.

## Mainnet deployment rules

Do not deploy merely because the code compiles.

Mainnet gate requires:

1. unit tests pass
2. integration tests pass
3. invariant/fuzz tests pass
4. manual contract review completed
5. STRK20 integration reviewed
6. privacy review completed
7. access-control review completed
8. deployment config verified
9. secrets scan clean
10. roles verified
11. class hashes verified
12. addresses verified
13. minimal-value walkthrough planned

## Mainnet value rule

Initial mainnet interactions should use the smallest practical amount.

Do not move significant funds merely to satisfy hackathon transaction requirements.

## Deployment verification

Before execution verify:

- chain is Starknet Mainnet / `SN_MAIN`
- STRK20 pool address
- USDC address
- STRK address
- expected class hash
- deployed contract address
- owner/admin address
- pause authority
- RPC target
- frontend config
- backend config

If any value is ambiguous:

**stop deployment and verify it.**

## Transaction recording

Only successful, verified transactions should be written into `strk20.json`.

For every qualifying transaction confirm:

- correct network
- successful receipt
- correct STRK20 pool interaction
- expected IWA state transition
- no unexpected events

Do not insert hashes simply because they exist.

## Dependency security

Before introducing a dependency:

- verify its purpose
- prefer official/current package
- avoid duplicates
- review package reputation/source
- pin/version deliberately where appropriate

Do not add a package merely because an agent recognizes its name.

## Build and CI security

Required checks should eventually include relevant combinations of:

```text
format
lint
typecheck
unit tests
contract tests
integration tests
fuzz/invariant tests
build
secret scanning
```

A green build does not replace manual review.

## Audit workflow

Security review happens throughout development.

### Before implementation

- threat model
- trust boundaries
- invariants

### During implementation

- tests before/minimally alongside behavior
- review each security-critical diff
- narrow commits

### Before integration

- interface assumptions reviewed

### Before mainnet

- dedicated full-system audit

### After deployment

- verify deployed bytecode/class hashes and configuration

## Findings severity

Use at least:

```text
CRITICAL
HIGH
MEDIUM
LOW
INFORMATIONAL
```

Each finding should contain:

```text
Title
Severity
Affected component
Impact
Attack path / failure mode
Evidence
Recommended fix
Fix status
Verification
```

Do not downgrade a finding because a deadline is near.

## Known current risk status

This section was written before the Starknet implementation existed and said so.
It is now out of date in the one direction that matters, because the contracts
are deployed and hold real value, so it is restated against what is actually
true.

Where things stand:

- `IwaCircle` and `IwaStrk20Helper` are deployed to Starknet mainnet and are
  immutable. Addresses are in `STATUS.md`.
- STRK20 settlement has been exercised on mainnet. The recorded transactions are
  in `strk20.json`.
- No external security audit has been carried out. The invariants in this
  document are the ones the contracts are expected to hold, verified by the
  contract test suite and by internal review, and that is a weaker statement
  than an audit.
- H-2, payout liveness under a lost member key, is an accepted known limitation
  of this deployment. See the section above.
- Legacy Stellar/Soroban security assumptions must not be inherited
  automatically. The frontend modules that carried them have been removed.
- Legacy Circom/prover components remain unapproved for reuse until reviewed.
  Proof generation is present but gated closed, and nothing on this network can
  check a proof.

## Development rule

For security-critical code:

1. understand intended invariant
2. write or identify a failing test
3. implement minimal behavior
4. run test
5. run neighboring/regression tests
6. inspect diff
7. run security-specific review
8. commit only verified change

## Agent rule

Agents must never:

- invent security verification
- claim an audit happened when it did not
- expose secrets
- bypass tests to save time
- disable safety checks without explicit justification
- create arbitrary admin powers
- silently expand scope
- treat a successful transaction as proof of correctness
- delete old security-relevant logic before its behavior is understood

## Release principle

If IWA cannot satisfy the security gate safely before a deadline:

**reduce scope instead of weakening the security model.**

## Zama Prize Savings (Ethereum Sepolia bounty) security rules

The Zama bounty track (`zama-prize-savings/`, branch `feature/zama-prize-savings`)
has its own invariants, verified by the S1/S2/S3 spike suites and carried into
the P1 pool core.

- Only the ACTUAL returned ERC-7984 transfer amount may be credited. Never the
  requested amount. This is the unbacked-share / fund-draining exploit guard.
- With the pinned `@openzeppelin/confidential-contracts` 0.5.3, ERC-7984
  transfers are all-or-nothing (`FHE.select(balance >= amount, amount, 0)`),
  NOT min-clamped. A shortfall transfer moves and returns 0.
- A shortfall deposit transfers 0 and credits 0. Accepted behavior for the
  bounty MVP; the user retries with a valid amount.
- No admin sweep/rescue/emergency function exists or may be added. The owner
  cannot move user funds or pool funds in any direction.
- ACL re-grant after every new encrypted handle write: `FHE.allowThis(handle)`
  plus `FHE.allow(handle, user)`. Omitting either freezes the balance.
- `withdrawAll()` is a mandatory liveness hatch: no encrypted input, no input
  proof, works even if the relayer/SDK infrastructure is unavailable.
- No plaintext balance, deposit/withdraw amount, or winner may appear in pool
  state, events, return values, or revert reasons.
- `MAX_PARTICIPANTS = 16` hard cap (S2-measured HCU ceiling). The 17th distinct
  wallet is rejected in plaintext. Participant registration is once per wallet
  on first deposit request; a single wallet can never consume more than one
  slot, and zero-weight participants cannot be selected in the draw (S2-verified).
- **Unresolved release risk (accepted for the bounty MVP):** 16 distinct
  zero-transfer wallets can still consume all participant slots. Bounded per
  wallet (one slot each) and harmless to the draw, but a testnet attacker with
  16 wallets can fill the pool. A registration fee or plaintext stake would
  fix it; out of scope for this bounty.
- **Prize funding (C2):** `fundPrize` is owner-only, allowed only while the
  round is Open, and credits ONLY the actual returned ERC-7984 transfer. A
  shortfall funds 0. The prize reserve is encrypted and irrevocable - no
  function in the contract can reduce, redirect, recover, or sweep it, and the
  owner has no decrypt access to it.
- **Participant total vs prize reserve:** `confidentialTotal` is participant
  draw weight only; `prizeReserve` is a separate encrypted value that never
  counts toward draw weight and never consumes `MAX_POOL_TOTAL` headroom.
- **`MAX_POOL_TOTAL = 1024`** (2^10, S2-measured bound): plaintext power-of-two
  cap on participant deposit weight. Deposit requests clamp to headroom via
  encrypted `FHE.min(requested, MAX_POOL_TOTAL - total)` - no plaintext
  branch, no decryption of the total, fail-closed to 0 via `trySub`.
- **Draw (P3):** `draw()` runs the S2-proven encrypted cumulative weighted
  walk over LIVE participant balances, once per round (`Locked -> Drawn`).
  The owner may draw immediately after lock; anyone may draw at or after
  `lockTimestamp + DRAW_TIMEOUT` (900s, Sepolia MVP value, C6 anti-stranding).
  `FHE.randEuint64(MAX_POOL_TOTAL)` only - no encrypted bounds, no `FHE.rem`,
  no re-draw, no rebias. A ticket `>=` the actual confidential total yields
  NO_WINNER (65535) and the prize rolls over untouched.
- **Winner and ticket stay encrypted.** `winnerIndex` is an encrypted euint16
  handle with `allowThis` only - nobody, including the owner, is granted
  decryption access. The ticket is stored confidentially; there is no
  `makePubliclyDecryptable` path anywhere (C4: never publish both ticket and
  winner identity). The draw moves no tokens: prize reserve and all balances
  are untouched.
- **Claim (P4):** `claim()` is a pull action in `Drawn`/`Claimable` (first
  claim performs the one-time `Drawn -> Claimable` transition). The winner
  check is the scalar encrypted `FHE.eq(winnerIndex, asEuint16(index))` and
  the credit is `FHE.select(isWinner, prizeReserve, 0)` - there is no
  `require` on an encrypted condition, no decrypt of the winner index, and no
  plaintext payout anywhere. A non-winner claims successfully and receives
  encrypted zero, externally indistinguishable from a winner claim.
- **Claim replay protection is per-user** (`hasClaimed`), never a global
  per-round flag: one user's claim cannot block another's, and claiming zero
  still consumes the caller's own attempt.
- **Prize reserve decreases only by the actual encrypted payout** to a
  verified winner; a NO_WINNER round credits zero to everyone and leaves the
  reserve fully intact for rollover.
- **Claim accounting (option A, decision.md):** the winner's credited balance
  AND `confidentialTotal` increase by the payout, so `total == sum(credited)`
  always. Claim is only reachable after the round is Drawn, so a prize credit
  can never retroactively affect the completed draw. Solvency invariant
  `sum(credited) + prizeReserve <= holdings` is preserved across claims; a
  winner's prize is withdrawable through the normal confidential withdrawal.
- **Full-cycle result (P5, verified across separate transactions):**
  - solvency `sum(user balances) + prizeReserve == holdings` holds at every
    checkpoint of the complete lifecycle, and at the end of a fully-claimed
    and fully-withdrawn round holdings and liabilities are both zero
  - every encrypted handle written in one transaction (deposit, funding,
    draw, claim) remains operable in all later transactions of the lifecycle
  - no user loses principal: winners end with principal + prize, non-winners
    with exactly their principal
  - rollover rounds (ticket >= total) credit zero to everyone and leave the
    prize reserve fully backed in the pool for rollover/future use

## Zama prize pool — P6 red-team findings table

| # | Severity | Title | Exploitability | Impact | Status |
|---|----------|-------|----------------|--------|--------|
| F1 | **HIGH** | Zero-transfer participant-slot DoS | 16 distinct wallets, each: setOperator + zero-value deposit (free on testnet); permissionless, no recovery | The pool is permanently full for real users (cap 16, one slot per wallet, no removal function, no owner recovery). Funds, draw and existing participants unaffected. Pool is single-round/redeployable. | **ACCEPTED FOR THE SEPOLIA BOUNTY MVP ONLY (2026-09-05). BLOCKS ANY PRODUCTION/MAINNET DEPLOYMENT** - participant admission must be redesigned before production (see decision.md) |
| F2 | LOW/INFO | First-funding reserve handle is decryptable by the funder | Only on the FIRST funding: FHESafeMath.tryAdd stores the token's `transferred` handle directly, and the OZ token grants `allow(transferred, from)` | The funder can decrypt the reserve value exactly while it equals the amount they themselves just funded - information already known. Access disappears once the handle is rewritten (second funding or any claim). Not a confidentiality failure. | Verified, documented, accepted |
| F3 | INFO | Donations to the pool create surplus | Anyone can send cMockUSD to the pool | Surplus is never backing; the `<=` solvency invariant holds; cannot be withdrawn; harmless | Documented (mirrors helper-surplus model) |
| F4 | INFO | Claim with an unfunded prize uses an uninitialized reserve operand in FHE.select | Never-funded round reaches Claimable | Evaluates as 0 per the OZ FHESafeMath note; mock-verified | Sepolia-verify item |

**Attack rows verified GREEN (29 red-team tests):** replay of encrypted input
cannot double-credit; double-debit impossible; over-withdraw/withdraw-after-
claim stay backed; zero-value deposit/funding create zero liability; prize
cannot be credited twice; reserve cannot underflow; total == sum(credited)
after chaotic flows; winner substitution impossible; participant-index
confusion impossible; sentinel (65535) does not collide with index 15;
unregistered/owner claims rejected; ordering immutable; single randomness
source, no modulo/rebias, no second draw; draw at zero-weight cap within HCU;
cross-user and owner decryption rejected; no setters/upgrade/proxy/
delegatecall/selfdestruct; owner cannot unwrap or transferFrom the pool's
tokens; operator expiry enforced; state-machine matrix complete; adversarial
lifecycle: no principal loss, no insolvency, no ACL freeze, no disclosure.

**Sepolia-only verification items (mock ACL enforcement is incomplete):**
1. Operation-level ACL of the `allowTransient` token handoff pattern.
2. Input-proof binding: the mock accepted wrong-contract and wrong-sender
   inputs; Sepolia must reject them (fail-closed).
3. Uninitialized-operand semantics in claim-with-no-prize (F4).
4. Absence of plaintext in real coprocessor events (mock coprocessor logs
   cleartext internally).
5. First-funding reserve-handle grant behavior (F2) on the real ACL.
6. N=16 HCU against real Sepolia limits (local: 8.62M global / 2.82M depth).

## Real Sepolia verification results (P7A, 2026-09-05 - all confirmed)

1. **S1 round-trip:** PASS on the real network - cross-transaction ACL holds,
   wallet A decrypts 100, wallet B rejected by the real ACL ("not authorized").
2. **allowTransient handoff + operator path:** PASS - real deposits (40, then
   20) through the pool pull work and stay decryptable.
3. **Wrong-contract proof binding:** REJECTED - the real input verifier fails
   with `InvalidSigner()`; the mock's acceptance was indeed mock-only.
4. **Wrong-sender proof binding:** REJECTED - same `InvalidSigner()`.
5. **No-prize claim:** credits zero, no stuck state, full withdrawal works.
6. **Event leakage:** no plaintext amounts/balances/prize/winner in real
   Sepolia logs across the whole verification flow.
7. **F2 first-funding ACL:** confirmed on the real ACL - the funder can
   decrypt only the first-funding reserve handle (their own amount); a
   rewritten handle removes access.
8. **N=16 production draw:** executes on Sepolia (gas 1,705,385); real
   coprocessor HCU identical to local (global 8,616,576, depth 2,818,032),
   comfortably under the 20M/5M limits.
9. **Real-network deviation observed:** well-known public test-mnemonic
   addresses are swept/drained on public testnets - verification uses
   freshly-generated random wallets; the deployed demo must never use
   published test keys.

All previously mock-only items 1-6 are now verified against the real network
except item 1's enforcement detail (the `allowTransient` handoff pattern ran
successfully on Sepolia, which exercises it end to end).
- **Draw is bounded to `MAX_PARTICIPANTS = 16`.** The walk iterates exactly
  `participants.length` (hard-capped at 16); production N=16 measured at
  global 8.62M HCU / depth 2.82M HCU, comfortably under the 20M/5M limits.
- Solvency invariant: `sum(credited balances) + prizeReserve <= pool's
  confidential token balance`, maintained by crediting only actual returned
  transfers; verified across deposit/withdraw/fund/shortfall flows.
- Sepolia ACL enforcement and event-behaviour verification are still pending
  credentials. The local mock does not enforce operation-level ACL, so the
  documented `allowTransient` handoff pattern must be confirmed on Sepolia.

## Task 8A-S settlement authority and solvency rules

`IwaCircle` pins the STRK20 pool and a deployment-only setup authority in its
constructor. The helper starts unset. Only that authority may initialize one
non-zero helper, exactly once; successful initialization locks the helper and
clears the authority to zero. The authority has no circle, membership,
financial, pause, token, pool, or replacement capability. Neither organizer
nor admin can replace or redirect the helper. Every financial-settlement
function rejects before initialization and then requires
`caller == settlement_helper`.

Deployment is valid only after the circle is deployed, the helper is deployed
with that circle pinned, the authority initializes the helper, and onchain
reads confirm the exact helper, locked initialization, and cleared authority.

The helper-only APIs are narrowly typed for contribution, cure, payout, and
recovery. There is no arbitrary target, selector, calldata, liability setter,
`mark_paid`, or `mark_recovered` surface. Public payout authorization remains
preparatory only. Public callers cannot consume financial contribution/cure
state or produce `Paid`/`Recovered`.

All financial signatures bind circle, round, member, helper, pool, token,
exact amount, and nonce under distinct domains. Payout and recovery also bind
the member-authorized open-note id.

Solvency is enforced per `(circle, round, token)`. Only helper-confirmed
contributions and cures credit that round, and only its payout or recovery may
debit it. A debit exceeding the same round's funded liability fails closed.
Another token, another round, donations, organizer funds, or hypothetical
insurance are not protocol backing.

### Unaccounted surplus (finding 8B-01)

The helper is an ordinary ERC20 holder, so anyone can send it tokens it never
agreed to hold. Accounted custody for a token is exactly `token_liability`,
the sum of that token's legitimate round liabilities; anything above it is
surplus.

Surplus is never backing. `credit_liability` and `debit_liability` are the only
writers of custody or round liability, and both are reachable only from the
four pool-authorized settlement branches of `privacy_invoke`. Inbound
settlement still requires `balance == accounted custody + exact amount`, so a
donation can never stand in for a member's contribution or cure.

Because that check is exact, a surplus previously blocked every later inbound
settlement in that token, permanently and with no recovery path. That was
confirmed against the real pool and is now fixed by
`normalize_surplus(token)`:

- accepts only the two configured assets, so there is no general token rescue
- requires `balance >= accounted custody`, then moves exactly the difference
- leaves `balance == accounted custody`, so legitimate backing cannot be swept
- reverts when there is no surplus, rather than silently draining anything
- writes no storage at all: no liability, circle, round, member, note, nonce,
  payout recipient, default, or cure history is touched
- sends to `surplus_sink`, an immutable address pinned at deployment and
  validated non-zero and distinct from the helper, the pool, and both tokens

The destination is never a parameter, so a caller cannot direct value and gains
nothing by calling. There is no setter, no admin path, and no upgradeable
destination. Anyone may call it, which is what removes the denial of service.

Residual, accepted: an attacker can still donate immediately before a
settlement transaction to make that one transaction revert, then repeat. This
is transient and repeatable rather than permanent, costs the attacker real
tokens plus gas each time, and is cleared by any permissionless normalization.
Folding normalization into the settlement path would remove it entirely, at the
cost of a token transfer inside every contribution and cure; that trade has not
been taken.

Uncured final accounting stores net-funded recovery separately: nominal payout
minus exact uncured deficits in that round. Nominal payout and defaults are not
rewritten.

A zero derived recovery is terminal `NoFundedRecovery`, not a zero-value token
operation. It can arise only during deterministic final preparation, preserves
the recipient and nominal amount, consumes no settlement nonce or signature,
and cannot transition to `RecoveryPending`, `Paid`, or `Recovered`. Positive
derived recovery alone uses `RecoveryPending` and requires later real movement.

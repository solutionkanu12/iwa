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

The exact recovery path must be specified before production deployment.

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

The new Starknet implementation has not been written yet.

Therefore:

- no claim of Starknet contract security exists
- STRK20 integration is not yet validated
- mainnet deployment has not occurred
- legacy Stellar/Soroban security assumptions must not be inherited automatically
- legacy Circom/prover components remain unapproved for reuse until reviewed

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

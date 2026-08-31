# IWA Starknet deployment (Task 8C)

Deployment preparation only. Nothing here has been deployed, and no
transaction has been sent from this repository.

```
./iwa-deploy.sh validate deploy.config.json     # offline + read-only on-chain checks
./iwa-deploy.sh plan     deploy.config.json     # print the ordered steps
./iwa-deploy.sh check-helper deploy.config.json <helper> <core> <helper-class>
                                                # fail-closed pre-init gate
./iwa-deploy.sh verify   deploy.config.json <core> <helper> <core-class> <helper-class>
./iwa-deploy.sh deploy   deploy.config.json --confirm-send    # sends transactions
./test-iwa-deploy.sh                            # offline assertions, no network
```

`validate`, `plan`, `verify`, `check-sink`, `check-helper` and
`check-artifacts` never send a transaction. `deploy` refuses to run without
`--confirm-send`.

## Artifact allowlist (closes 8B-02)

The tool acts on exactly two contracts, named one at a time:

```
IwaCircle
IwaStrk20Helper
```

It never enumerates `target/dev`, never globs, and never loops over
`.contracts[]` to decide what to deploy. Every other artifact present is listed
and explicitly ignored.

This matters because `scarb build` also emits StarkWare's `Privacy` pool class:
`build-external-contracts` is set on the package target so integration tests can
declare the genuine pinned pool. **IWA must never declare or deploy `Privacy`.**
The mainnet pool already exists and is not ours. `Privacy` is on an explicit
forbidden list, the tool asserts the allowlist and forbidden list are disjoint,
and `test-iwa-deploy.sh` proves the tool reports it as ignored and never as
selected.

The tool also refuses to proceed if `IwaCircle` exposes any helper-replacement
entrypoint (`set_settlement_helper`, `update_settlement_helper`,
`replace_settlement_helper`, `set_surplus_sink`), and requires
`initialize_settlement_helper` to be present.

## surplus_sink policy

`surplus_sink` is a required, immutable constructor argument of
`IwaStrk20Helper`. It receives tokens that were sent to the helper but never
accounted as backing, moved only by the permissionless `normalize_surplus`.
It cannot be changed after deployment: there is no setter and no admin.

It **must** be:

- a dedicated Starknet protocol treasury multisig controlled by the IWA project
- non-zero

It **must not** be:

- the helper itself — normalization would be a permanent no-op and would
  re-create the 8B-01 denial of service
- the privacy pool — unbacked tokens would pollute pool accounting
- the USDC or STRK token contract
- the setup authority, or any organizer-controlled operational address, so that
  no circle operator can benefit from surplus

The first four are enforced by the helper constructor. The tool additionally
refuses a sink equal to the setup authority, and refuses the placeholder that
ships in `deploy.config.example.json`, so a half-filled config cannot deploy.

No sink address is invented in this repository. Choosing it is a project
decision and is a blocker for deployment.

## Deployment order

1. **Verify addresses.** `./iwa-deploy.sh validate deploy.config.json`
   confirms the RPC chain id matches the configured network, that a contract is
   deployed at `privacy_pool` and answers the STRK20 pool view interface, and
   that each token reports the expected symbol.
2. **Deploy `IwaCircle`** with `usdc_token, strk_token, privacy_pool,
   setup_authority`, using a fresh salt.
3. **Deploy `IwaStrk20Helper`** with `iwa_circle, privacy_pool, usdc_token,
   strk_token, surplus_sink`, using a fresh salt.
4. **Run the pre-initialization gate** (`assert_helper_ready`). Read-only and
   fail-closed: it re-reads from the chain that the helper address hosts the
   exact helper class, that the helper config matches every configured address
   exactly, and that the circle is still uninitialized with the expected
   setup authority. Initialization is not sent unless every check passes.
5. **`initialize_settlement_helper(helper)`** exactly once, from the setup
   authority. The contract locks initialization and clears the authority to
   zero in the same call.
6. **Verify the stored helper** equals the deployed helper.
7. **Verify the setup authority is cleared** to `0x0`.
8. **Verify no replacement setter exists** (checked from the ABI in step 1).
9. **Verify the helper config** matches every expected address.

Steps 6-9 are re-runnable at any time:
`./iwa-deploy.sh verify deploy.config.json <core> <helper> <core-class> <helper-class>`.

The deployment is not valid until steps 6-9 pass on chain.

## Salt policy

The UDC computes a deployed address deterministically from deployer, salt,
class hash and constructor calldata. The abandoned deployment used salt `0x0`
and occupies those addresses. A recovery must therefore use a **fresh salt**:
reusing `0x0` with identical inputs recomputes the same occupied addresses and
reverts at deploy time. The tool refuses an explicit `salt: 0x0` in the
config, and when `salt` is omitted it generates a fresh random salt, prints it
prominently, and passes it deliberately to every deploy in the run. Record the
printed salt for reproducibility.

## What the tool refuses

- zero, malformed, or placeholder addresses
- `usdc_token == strk_token`
- `surplus_sink` equal to the pool, either token, or the setup authority
  (address comparison is felt-wise, so `0x0abc` and `0xabc` compare equal)
- a chain id that does not match the configured network
- a `salt` of `0x0` (the abandoned deployment occupies the salt-0 addresses)
- a malformed sncast output missing the `contract_address:` / `class_hash:` field
- a helper that is not deployed, runs a different class, has a mismatched
  config, or is wired to a circle that is already initialized (the
  pre-initialization gate, `check-helper`)
- missing or duplicated allowlisted artifacts
- an `IwaCircle` ABI exposing a helper-replacement setter
- deploying without `--confirm-send`

Re-initialization is refused by `IwaCircle` itself
(`HELPER_ALREADY_INITIALIZED`), and the cleared authority makes a second
attempt unauthorized regardless.

## Operational notes

- The mainnet pool charges a fee in STRK per `apply_actions` call, pulled from
  the caller. At the time of writing it read `6000000000000000000` (6 STRK).
  Read it live with `get_fee_amount` rather than hardcoding it, and fund
  whichever account submits pool transactions.
- The pool maintains `blocked_open_note_depositors`. If the IWA helper is ever
  added to that list it can no longer credit open notes, and payouts and
  recoveries will fail. This is controlled by the pool operator, not by IWA.
- `deploy.config.json` is your working copy; keep it out of version control if
  it ever contains anything sensitive. Only the example is tracked.

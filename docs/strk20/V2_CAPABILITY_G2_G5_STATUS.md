# Iwa V2 Private Payout — G2–G5 Execution Status

**Date:** 2026-09-07
**Branch:** `feature/iwa-v2` (no commit, no push, no deploy)
**Plan:** `docs/superpowers/plans/2026-09-04-iwa-circle-v2.md`, tasks G1–G5
**Outcome:** **STOPPED AT A HARD INFRASTRUCTURE BLOCKER between G3 and G4.**
G2 RED tests are written. Critical/High findings below block continuation.

---

## Environment verification (prerequisite) — PASS

| Check | Result |
|---|---|
| Repo testable from WSL | PASS — `/mnt/c/Users/HP/iwa` reachable from WSL Ubuntu |
| Scarb | `scarb 2.18.0` (WSL, `~/.local/bin`) |
| Starknet Foundry | `snforge 0.63.0`, `sncast 0.63.0` (WSL) |
| Dep resolution | `scarb metadata` resolves the pinned `privacy` git dep (`66e3caae…`) |
| Pinned anonymizer source present | `packages/shadow_account_anonymizer` exists in the pinned checkout |
| Note | `snforge` on `/mnt/c` is very slow (~15–20 min/run); tests run from WSL against the Windows-mounted tree |

---

## G1 (pin & verify the shadow-account primitive) — **NOT SATISFIABLE**

G1 was never passed in the prior phase and remains unpassable with the material
available in this repo and the installed STRK20 skills.

### G1 gate: "The exact wallet and target-network deployment match the pinned source. Otherwise stop; verdict B remains source-level only."

| G1 requirement | Status | Evidence |
|---|---|---|
| Pin exact anonymizer **address / class hash / pool binding / network** | **FAIL** | No canonical `ShadowAccountAnonymizer` deployment on Starknet **Sepolia or mainnet** is published in the pinned repo, the installed `strk20-*` skills, or their `references/`. The installed `strk20-privacy` freshness script pins only the **Sepolia pool** (`0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91`). Upstream `e2e/src/shadow-account-setup.ts` **self-deploys** the anonymizer on an ephemeral devnet with the test admin as upgrade owner. |
| Verify **governance and upgrade authority** for the anonymizer and shadow-account class | **FAIL (and adverse)** | Pinned `shadow_account_anonymizer.cairo`: `ReplaceabilityComponent` is initialised with `upgrade_delay: Zero::zero()` and a constructor `governance_admin`. The anonymizer is **instantly replaceable** by that role, with no timelock. It executes arbitrary `calls` as the shadow account and collects token balances. |
| Confirm a **real browser wallet** exposes shadow commitment + shadow invoke | **FAIL** | Installed `@starknet-io/types-js@0.10.3`: `methods.d.ts` exposes only `wallet_strk20InvokeTransaction`, `wallet_strk20PrepareInvoke`, `wallet_strk20Balances`. `STRK20_ACTION = deposit \| withdraw \| transfer \| invoke`. No `wallet_strk20ShadowAccountCommitment`, no shadow / compute-and-invoke action. The `strk20-privacy` skill (snapshot 2026-08-16): *"The Wallet API route remains pending. No shadow account method exists in `@starknet-io/types-js` 0.10.3 or starknet.js, so dapps relying on the user's wallet must wait."* |
| Confirm dapp-name + per-circle/per-epoch nonce derivation | Partial (source only) | `partial_commitment = Poseidon(identity_key, dapp_name)`, `commitment = Poseidon(partial_commitment, nonce)` — read from pinned source; not frozen. |
| Record exact public metadata / privacy leakage | Done in design §8; unchanged |

**The only functioning shadow-account route is the key-holding Privacy SDK**
(`@starkware-libs/starknet-privacy-sdk` `createPrivateTransfers().shadowAccounts()`),
which requires the integrator to hold the **account signing key and the viewing
key**. That is explicitly rejected by `SECURITY.md` (non-custodial rule), by
`AGENTS.md`, and by the plan's global constraints ("No server-held keys,
viewing keys, seeds, or payout authority").

---

## G2 (RED security tests) — **DONE (RED, as required)**

New files (tests only — no production code, no V1 change):

| File | Purpose |
|---|---|
| `contracts/starknet/tests/test_private_destination_capability_v2.cairo` | 24 RED Cairo tests covering the plan G2 list + `SECURITY.md` "Mandatory payout attacks": commitment registration/rotation/rotation-race; correct vs wrong shadow-account caller; commitment substitution; cross-circle reuse; state-derived member/round/token/amount; wrong amount/round/token/contract/chain; authorization replay; double collect; expiry; atomic revert of circle state + liability; reentrancy; liability mismatch; **no public ERC20 payout path**; no organizer/admin recipient discretion; time-locked private fallback; **no public-account fallback**. |
| `iwa-web/src/chains/strk20/v2/privateDestinationCapability.test.ts` | RED dapp-side tests: installed Wallet API lacks shadow methods (G3 checkbox 2); no identity/viewing key or note witness crosses the adapter boundary; commitment derived by the wallet not the dapp; no key-holding SDK fallback. |

Both are RED because the V2 layer does not exist:
- Cairo: `declare("IwaPrivateDestinationHelperV2")` / `declare("IwaCircleV2")` /
  `declare("ShadowAccountAnonymizer")` do not resolve.
- TS: `./privateDestinationSpike` (a G3 artifact) does not exist.

The Cairo file **does** deploy the genuine pinned pool (`declare("Privacy")`),
so when the V2 harness lands the tests bind to real protocol behaviour, not an
interface mock (satisfies the G2 gate's "real pinned pool" requirement).

### Recorded results (WSL, `snforge 0.63.0` / `vitest 4.1.11`)

| Suite | Command | Result |
|---|---|---|
| Cairo baseline (pre-change) | `snforge test --features test_erc20` | **190 passed, 0 failed** |
| Cairo baseline + new RED file | `snforge test --features test_erc20` | **190 passed, 20 failed** (the 20 new RED tests; baseline unchanged, crate still compiles) |
| Cairo new file only | `snforge test test_private_destination_capability_v2 --features test_erc20` | **0 passed, 20 failed** — every failure is `Failed to get contract artifact for identifier = IwaPrivateDestinationHelperV2` / `IwaCircleV2` |
| Frontend new RED file | `vitest run …/privateDestinationCapability.test.ts` | **1 passed, 6 failed** (the 1 pass is the `@starknet-io/types-js` version pin; the 6 fails are the capability + trust-boundary properties) |
| Frontend typecheck | `tsc -b` | clean (spike import guarded with `@ts-expect-error`) |

---

## G3 (minimal private payout harness / browser + wallet compatibility) — **BLOCKED**

Plan G3 gate: *"A real compatible wallet completes commitment derivation and
shadow invocation without backend key custody. Simulation-only success does not
pass."*

- No wallet on any Starknet network exposes the shadow-account Wallet API
  methods (see G1). The route is upstream-documented as **pending**.
- Plan G3 step 3 is explicitly conditional: *"Upgrade or vendor only the
  explicitly reviewed `0.10.4-rc.1` interface … **after real-wallet support is
  confirmed**."* Real-wallet support is **not** confirmed.
- The contract-side harness alone (a Cairo fixture) cannot satisfy this gate,
  and building `IwaCircleV2` / `IwaPrivateDestinationHelperV2` before G5 review
  is prohibited by the plan.

**Stopped here.** No spike module, no V2 helper, no vendored RC interface created.

---

## G4 (one real private Sepolia settlement) — **BLOCKED — HARD INFRASTRUCTURE BLOCKER**

Cannot be attempted "using only verified wallet/privacy infrastructure":

1. **No verifiable anonymizer deployment** on Starknet Sepolia (or mainnet).
   The user instruction is explicit: *"If canonical Sepolia anonymizer/pool/
   shadow-account infrastructure is still not verifiable, STOP at the exact gate
   and report it rather than inventing addresses or APIs."*
2. **No wallet** can assemble the shadow-account transaction (G1).
3. Deploying our own anonymizer + using the key-holding SDK to drive it would
   be (a) inventing infrastructure and (b) a custodial key model — both
   prohibited.

**Stopped here. No transaction attempted. No address or API invented.**

---

## G5 (freeze authorization schema + rerun security suite) — **NOT REACHED**

- Schema freeze is gated by the plan on the primitive being runtime-verified
  ("Do not freeze SNIP-12 encoding until the private destination primitive and
  wallet signature support are verified"). Not verified → **not frozen**.
- The security suite rerun is recorded above under G2.

---

## Findings (Critical/High block continuation)

| # | Severity | Title | Component | Impact |
|---|---|---|---|---|
| V2-01 | **HIGH** | No verifiable shadow-account anonymizer deployment | STRK20 shadow-account infra | The selected V2 private-payout primitive (verdict B) has no canonical contract to authenticate against on any Starknet network. G4 cannot proceed; verdict B stays source-level only. |
| V2-02 | **HIGH** | Wallet API shadow-account route is not shipped | Dapp ↔ wallet boundary | No browser wallet / `@starknet-io/types-js` 0.10.3 / starknet.js method exists. The only working route is the key-holding Privacy SDK, which violates Iwa's non-custodial invariant. G3 gate cannot pass. |
| V2-03 | **MEDIUM→HIGH** | Anonymizer is instantly upgradeable by a governance admin | Pinned `shadow_account_anonymizer.cairo` | `ReplaceabilityComponent` with `upgrade_delay = 0` + constructor `governance_admin`. A compromised/malicious upgrade of a contract that executes arbitrary calls as the shadow account and moves token balances could redirect in-flight payout value. Any real deployment's governance must be reviewed and is currently unknown. |
| V2-04 | **MEDIUM** | V2 helper caller set must widen to an anonymizer-resolved SubAccount | V2 helper design | The "small V2 contract change" replaces `caller == pool` with `caller == get_shadow_account(stored_commitment)`. This can only be pinned against a **trusted** anonymizer address, which does not exist (V2-01). |
| V2-05 | **LOW→MEDIUM** | `0.10.4-rc.1` shadow-method claim not corroborated by installed skills | Iwa docs (`INTEGRATION_RESEARCH.md`, `SECURITY.md`) | Iwa docs state the dev spec `0.10.4-rc.1` specifies the shadow methods; the installed `strk20-privacy` skill and freshness script treat the Wallet API shadow route as pending with no released method. Even if a draft exists, no wallet implements it. |

**V2-01 and V2-02 (HIGH) block continuation past G3.**

---

## Recommendation for review

1. Keep verdict **B (source-level feasible)**. Do **not** upgrade to runtime-
   verified; do **not** downgrade to C yet — the source path is intact, only the
   deployed ecosystem is missing.
2. Track two external unblock conditions before re-running G3–G5:
   - a privacy-enabled **browser wallet** ships the shadow-account Wallet API
     methods on Starknet Sepolia, and
   - a **canonical shadow-account anonymizer** is deployed on Sepolia with
     published address, class hash, pool binding, and reviewed governance.
3. Until then, new-circle creation stays on V1 / closed (design §14). No V2
   contract, adapter, or `create-default` flip.
4. The G2 RED suites stay in the tree as the executable spec for when G3 resumes.

### Update (2026-09-07, later): an alternative that works today

A follow-up investigation found a path that does **not** depend on the
shadow-account infrastructure — **Candidate P (precommitted destination
note)** — built entirely on Wallet API methods that ship in
`@starknet-io/types-js@0.10.3`. Its contract mechanism is proven (10/10)
against the genuine pinned pool. See
`docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`. The shadow-account design
stays valid but infrastructure-blocked; Candidate P is the recommended
near-term direction.

# IWA — Handoff

Live state for the next agent session. Details in `STATUS.md`; decisions in
`decision.md`; findings in `SECURITY.md`.

## Current state (Iwa V2 — Candidate P, implementation complete, not deployed)

- Branch: `feature/iwa-v2` at baseline
  `8710646e75dfe67e7b5b9f2d07f2d8c85b91d0e7`.
- V1 is preserved at tag `iwa-v1-starknet`, branch
  `submission/starknet-v1`, SHA
  `5ec9e59554a6ca7b6af7388148830dfb661b6c8e`. V1 contracts untouched.
- Private Starknet payout and private recovery remain hard invariants; direct
  public ERC20 payout stays rejected.
- **Shadow-account path superseded / infrastructure-blocked (V2-02):** no
  browser-wallet shadow-account methods (installed Wallet API types `0.10.3`),
  no verified anonymizer deployment. Its RED tests are kept for history and
  ignored/skipped in CI (`test_private_destination_capability_v2.cairo` all
  `#[ignore]`; `privateDestinationCapability.test.ts` six `it.skip`).
- **Candidate P is the selected path** (precommitted private destination note).
- **A1 PASS on real Ready X / Starknet mainnet** — `wallet_addDeclareTransaction`
  reached the approval prompt (no tx sent).
- **A2/A3 complete** — V2 contracts + `test_payout_settlement_v2.cairo`
  (24-case) + `test_hash_parity_v2.cairo`; full Cairo suite green.
- **V2 frontend payout path complete** — `chains/strk20/v2/*` +
  `DevV2PotCollectionView`.
- **Portable Trust Credential implemented** — `lib/credential/*`
  (claims / artifact / verify / generate / credentialChainReader) +
  `DevCredentialView`; fail-closed verifier, proof-of-possession, full
  privacy / forgery / replay matrix (`credentialSecurity.test.ts`).
- Nothing committed, pushed, or deployed.

## Next step

STOP FOR REVIEW. After approval: declare + deploy `IwaCircleV2` /
`IwaStrk20HelperV2` from the Ready X wallet, fill the addresses into
`iwa-web/src/chains/strk20/v2/deploymentV2.ts`, re-run the class-hash preflight
(`contracts/starknet/deploy/iwa-deploy-v2.sh` non-sending checks), then run one
real minimal-value private pot collection + one credential verification against
the deployed circle. V2 rotation / private recovery hardening and an external
audit come before any V2 mainnet use beyond that proof.

## Zama Prize Savings bounty (previous track, still live)

- Branch: `feature/zama-prize-savings`
- S1-S6: LOCAL PASS (159 tests)
- P7 REAL SEPOLIA VERIFICATION: PASS (all 8 items, real network)
- P7 DEPLOYMENT (official): MockUSD / CMockUSD / IwaPrizeSavings deployed on
  Sepolia, recorded in `zama-prize-savings/deployments/sepolia.json`
  (pool 0x2d1b97F7e1E4845260aBd23017686fBa38006037)
- P7 FRONTEND: Iwa Prize Savings integrated into the main Iwa app at
  `/app/prize-savings`
- F1 accepted for the Sepolia bounty MVP only; blocks any production/mainnet
  deployment.
- Remaining actions are human and listed in `zama-prize-savings/SUBMISSION.md`
  (final release checklist): commit, push, Vercel deploy, demo, X thread, form.
  Deadline 2026-09-05 23:59 AOE.

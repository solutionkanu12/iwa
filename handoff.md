# IWA — Handoff

Live state for the next agent session. Details in `STATUS.md`; decisions in
`decision.md`; findings in `SECURITY.md`.

## Current state (Zama Prize Savings bounty)

- Branch: `feature/zama-prize-savings`
- S1-S6: LOCAL PASS (159 tests)
- P7 REAL SEPOLIA VERIFICATION: PASS (all 8 items, real network - see
  SECURITY.md for the results; mock-only items now resolved, incl. real
  `InvalidSigner` rejection of wrong-contract/wrong-sender inputs)
- P7 DEPLOYMENT (official): MockUSD / CMockUSD / IwaPrizeSavings deployed on
  Sepolia, recorded in `zama-prize-savings/deployments/sepolia.json`
  (pool 0x2d1b97F7e1E4845260aBd23017686fBa38006037)
- P7 FRONTEND: Iwa Prize Savings integrated into the main Iwa app at
  `/app/prize-savings` - one Iwa product (AppShell, lavender system, sidebar +
  account nav, off the 4-tab phone bar). Frontend: 589 tests pass, build and
  typecheck clean, existing routes untouched.
- F1 accepted for the Sepolia bounty MVP only; blocks any production/mainnet
  deployment.
- Nothing committed, pushed, or deployed beyond the approved Sepolia bounty
  deployment (no commits made at all in this track).

## Next step

P8 packaging is READY. Remaining actions are human and listed in
`zama-prize-savings/SUBMISSION.md` (final release checklist): review and
commit, push, Vercel deploy (live `/app/prize-savings` currently serves the
previous build - rewrites fine, feature not yet live), record the ≤3-minute
demo, post the X thread, make the repo public, complete the form. Deadline
2026-09-05 23:59 AOE.
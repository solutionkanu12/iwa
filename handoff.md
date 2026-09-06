# IWA — Handoff

Live state for the next agent session. Details in `STATUS.md`; decisions in
`decision.md`; findings in `SECURITY.md`.

## Current state (multichain wallet UX pass)

- **One Iwa wallet manager, two independent slots** (`lib/evmWallet.ts` +
  `app/WalletProvider.tsx`): Starknet for circles/standing, EVM for Prize
  Savings. No forced dual connection.
- **Connect to Iwa chooser**: a disconnected visitor picks Starknet or EVM.
- **AppShell wallet control**: two compact rows (Starknet / EVM) with per-chain
  Connect/Disconnect and shortened addresses; a wrong-network EVM slot reads
  "Wrong network". The phone bar keeps its account pill; the two rows sit in
  that dropdown (no nested wallet pill).
- **Prize Savings EVM gate**: Starknet-only users are asked for the EVM wallet
  (Starknet stays connected); a wrong-network EVM wallet is asked to switch to
  Sepolia; only a correctly connected EVM slot reveals the feature.
- **Connect seam**: `eth_requestAccounts` lives only in the Ethereum adapter.
  Extension `accountsChanged`/`chainChanged` events cannot auto-connect a
  disconnected slot.
- Fresh 2026-09-06 verification: frontend 659 tests pass, `tsc -b` clean,
  production build complete; Zama 159 passing / 8 pending real-Sepolia tests.
  Production-preview Chrome checks at 320/390/768/1440px cover landing,
  chooser, dual-wallet AppShell control, Starknet-only gate, wrong-network
  Sepolia prompt, and EVM-only loaded action layout with no content clipping or
  horizontal overflow. Narrow Prize input/action rows wrap.
- Nothing committed, pushed, or deployed; no contracts or backend touched.

## Next step

Human review of the multichain wallet UX pass (STOP FOR REVIEW): review the
diff, then commit. Context docs updated (`decision.md`, `STATUS.md`,
`SECURITY.md`, this file).

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

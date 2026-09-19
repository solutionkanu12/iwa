# IWA — Handoff

Live state for the next agent session. Details in `STATUS.md`; decisions in
`decision.md`; findings in `SECURITY.md`.

## Current state (Iwa Account auth/session pass)

- Iwa Account is implemented in the working tree with Google/email Supabase
  PKCE initiation, a guarded `/auth/callback`, and durable backend-owned browser
  sessions.
- The callback scrubs code/token material before network work, exchanges each
  code once, deduplicates React Strict Mode and replay, rejects query-string
  access tokens, and keeps only a transitional hash-token fallback.
- Approved security exception: Supabase `persistSession: true` is used only
  with a custom store that accepts `*-code-verifier` keys. Supabase session,
  refresh-token and provider-token writes are rejected; automatic refresh and
  URL session detection are disabled.
- Backend Supabase tokens must pass signature, expiry, exact issuer, audience,
  provider, subject and verified-email checks. Successful login creates an
  opaque Iwa session whose raw token exists only in an HttpOnly cookie and whose
  SHA-256 hash is stored.
- Iwa Account does not authorize wallet transactions or admin access. Wallet
  connection, chain adapters and contract authorization are unchanged.
- Latest verification: frontend auth 27/27, backend account/auth 33/33, full
  frontend 836/836, full backend 324 passed / 16 skipped, both typechecks and
  frontend production build clean.
- Nothing committed, pushed, deployed or migrated in production. No contract,
  deployment-address or unresolved PRD-rename file was touched by this pass.

## Next step

Human review of the final Iwa Account diff and proposed commit set. Do not
commit, push, deploy or run the production migration until explicitly approved.

## Previous verified track (multichain wallet UX)

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
- At that checkpoint, nothing had been committed, pushed or deployed and no
  contracts or backend code had been touched. The current Iwa Account pass adds
  backend/auth work described above; this paragraph is historical context.

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

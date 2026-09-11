# Verifying IwaCircleCelo on Celoscan

Not run yet — this documents the exact command for when a real deployment exists.

## Prerequisites

- `CELOSCAN_API_KEY` set in the environment (a free Celoscan API key; see
  hardhat.config.ts's `etherscan.apiKey.celo`).
- The exact constructor arguments used for the deployment (printed by
  `deploy/deployIwaCircleCelo.ts` at deploy time — keep that output).

## Command

```
npx hardhat verify --network celo <DEPLOYED_ADDRESS> \
  <token_> <contributionAmount_> <cadenceSeconds_> <gracePeriodSeconds_> \
  "[<member_1>,<member_2>,...]"
```

`members_` is an `address[]`; hardhat-verify accepts it as a single
JSON-array-shaped argument (quoted, no spaces after commas).

## Why this should verify cleanly

The compiler settings verification runs against must match what actually
produced the deployed bytecode exactly:

- solc `0.8.27`
- optimizer enabled, `runs = 800`
- `evmVersion = "paris"`

All three are pinned explicitly in `hardhat.config.ts` (and mirrored in
`foundry.toml` for the separate fuzz/invariant layer), so a plain
`npx hardhat verify` run — which reads the same `hardhat.config.ts` — should
reproduce the same bytecode without needing any extra flags.

## Fallback: Sourcify

If Celoscan verification fails or an API key is not available, Sourcify is a
public alternative:

```
npx hardhat verify --network celo <DEPLOYED_ADDRESS> --contract contracts/IwaCircleCelo.sol:IwaCircleCelo <constructor args as above>
```

with `sourcify: { enabled: true }` added to `hardhat.config.ts` if not already
present at verification time.

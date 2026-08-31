#!/usr/bin/env node
// Step 1 — shield USDC into the STRK20 pool (pool transaction #1).
//
// Two ERC-20 approvals must exist before the pool transaction:
//   USDC to the pool, because a deposit is pulled with transfer_from;
//   STRK to the pool, because `collect_fee` pulls the pool fee from the caller
//   on every apply_actions in this run.
//
// The pool transaction registers the account if needed and deposits the whole
// round-1 pot. Registration and deposit sit in different action phases, so one
// transaction carries both.
//
//   node --env-file=.env.local 04_deposit.mjs                 # dry run
//   node --env-file=.env.local 04_deposit.mjs --confirm-send  # approve + shield

import {
  parseArgs,
  banner,
  bootstrap,
  makeTransfers,
  submit,
  submitPoolTx,
  waitForProvingWindow,
  readRunState,
  die,
} from "./lib/run.mjs";
import { loadCircleParams, formatUnits, USDC_DECIMALS, STRK_DECIMALS } from "./lib/params.mjs";
import { computeFunding } from "./lib/funding.mjs";
import { erc20ApproveCall } from "./lib/circle.mjs";
import { normFelt, callView } from "./lib/chain.mjs";

async function erc20Balance(provider, token, owner) {
  const r = await callView(provider, token, "balanceOf", [normFelt(owner)]);
  return BigInt(r[0]) + (BigInt(r[1]) << 128n);
}

async function erc20Allowance(provider, token, owner, spender) {
  const r = await callView(provider, token, "allowance", [normFelt(owner), normFelt(spender)]);
  return BigInt(r[0]) + (BigInt(r[1]) << 128n);
}

async function main() {
  const { cfgPath, confirmSend } = parseArgs();
  banner("04 DEPOSIT — shield USDC into the STRK20 pool", confirmSend);

  const ctx = await bootstrap({ cfgPath, confirmSend, needAccount: true, needProver: confirmSend });
  const { cfg, provider, account, sdk, ContractDiscoveryProvider, pool, feeAmount, proverUrl } = ctx;

  const params = loadCircleParams(cfg);
  const funding = computeFunding({ feeAmount, params });

  console.log("\n--- D. Balances and allowances (read-only) ---");
  const usdcBal = await erc20Balance(provider, cfg.usdc_token, account.address);
  const strkBal = await erc20Balance(provider, cfg.strk_token, account.address);
  const usdcAllow = await erc20Allowance(provider, cfg.usdc_token, account.address, cfg.privacy_pool);
  const strkAllow = await erc20Allowance(provider, cfg.strk_token, account.address, cfg.privacy_pool);

  console.log(`  USDC balance:   ${formatUnits(usdcBal, USDC_DECIMALS)} (need ${formatUnits(funding.usdcTotal, USDC_DECIMALS)})`);
  console.log(`  STRK balance:   ${formatUnits(strkBal, STRK_DECIMALS)} (need ${formatUnits(funding.strkTotal, STRK_DECIMALS)})`);
  console.log(`  USDC allowance: ${formatUnits(usdcAllow, USDC_DECIMALS)}`);
  console.log(`  STRK allowance: ${formatUnits(strkAllow, STRK_DECIMALS)}`);

  const shortfalls = [];
  if (usdcBal < funding.usdcTotal) shortfalls.push("USDC balance");
  if (strkBal < funding.strkTotal) shortfalls.push("STRK balance");
  if (shortfalls.length > 0) {
    const msg = `insufficient funding: ${shortfalls.join(", ")} — run 00_prepare.mjs for the exact figures`;
    if (confirmSend) throw new Error(msg);
    console.log(`  NOTE: ${msg}`);
  }

  console.log("\n--- E. Approvals ---");
  const approvals = [];
  if (usdcAllow < funding.usdcApproval) {
    approvals.push(erc20ApproveCall(cfg.usdc_token, cfg.privacy_pool, funding.usdcApproval));
  } else {
    console.log("  USDC allowance already sufficient");
  }
  if (strkAllow < funding.strkApproval) {
    approvals.push(erc20ApproveCall(cfg.strk_token, cfg.privacy_pool, funding.strkApproval));
  } else {
    console.log("  STRK allowance already sufficient");
  }

  let approvalBlock = null;
  if (approvals.length > 0) {
    const sent = await submit({
      account,
      provider,
      calls: approvals,
      label: `ERC-20 approvals (${approvals.length})`,
      confirmSend,
      kind: "transparent",
    });
    if (!sent.dryRun) approvalBlock = sent.receipt.block_number ?? null;
  }

  // The proof reads the depositor's token balance at its base block, so the
  // approval (and any top-up) must be at least 10 blocks old before proving.
  if (confirmSend) await waitForProvingWindow(provider, approvalBlock);

  console.log("\n--- F. Pool transaction: register + deposit ---");
  const chainId = await provider.getChainId();
  const transfers = await makeTransfers({
    sdk,
    ContractDiscoveryProvider,
    pool,
    account,
    cfg,
    proverUrl,
    chainId,
  });

  const self = normFelt(account.address);
  const amount = funding.usdcTotal;
  console.log(`  depositing ${formatUnits(amount, USDC_DECIMALS)} USDC to self`);

  await submitPoolTx({
    transfers,
    provider,
    account,
    confirmSend,
    proverUrl,
    label: "register + deposit USDC",
    build: (t) =>
      t
        .build({
          autoRegister: true,
          autoSetup: true,
          autoSelectNotes: "all",
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(normFelt(cfg.usdc_token), (tok) => tok.deposit({ amount }))
        .surplusTo(self),
  });

  const state = readRunState();
  console.log(`\n  pool transactions recorded so far: ${state.transactions.filter((t) => t.kind === "pool").length}`);
  if (!confirmSend) console.log("\nDRY RUN COMPLETE — nothing was sent.");
}

main().catch(die);

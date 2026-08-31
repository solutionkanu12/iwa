// Exact minimum funding for one full IWA STRK20 demo run.
//
// Two separate costs exist and are often conflated:
//
//   The POOL FEE is not gas. `collect_fee` pulls `get_fee_amount()` STRK from
//   the account that calls `apply_actions`, via `checked_transfer_from`. It
//   therefore needs a standing ERC-20 allowance to the pool, and it is charged
//   once per pool transaction regardless of gas price.
//
//   STARKNET GAS is charged on top, in STRK, on every transaction — pool and
//   transparent alike.
//
// The fee is read live because a governance action can change it. Nothing here
// is hardcoded from the integration research.

import { formatUnits, transactionPlan, USDC_DECIMALS, STRK_DECIMALS } from "./params.mjs";

/**
 * Gas allowance per transaction. This is a budgeting headroom figure, not an
 * estimate of any specific transaction: private pool transactions carry a
 * proof and are far heavier than an ERC-20 approval. Raise it rather than
 * risk a run stalling half-finished.
 */
export const GAS_ALLOWANCE_PER_POOL_TX = 3n * 10n ** 17n;
export const GAS_ALLOWANCE_PER_TRANSPARENT_TX = 5n * 10n ** 16n;

/** Safety margin applied to the STRK total so a fee change mid-run cannot strand it. */
export const STRK_SAFETY_MARGIN_PERCENT = 20n;

export function computeFunding({ feeAmount, params }) {
  const { pool, transparent } = transactionPlan(params.memberLimit);

  const poolTxCount = BigInt(pool.length);
  const transparentTxCount = BigInt(transparent.length);

  const poolFeeTotal = feeAmount * poolTxCount;
  const gasTotal =
    GAS_ALLOWANCE_PER_POOL_TX * poolTxCount + GAS_ALLOWANCE_PER_TRANSPARENT_TX * transparentTxCount;

  const strkSubtotal = poolFeeTotal + gasTotal;
  const strkTotal = strkSubtotal + (strkSubtotal * STRK_SAFETY_MARGIN_PERCENT) / 100n;

  // Every member contributes once in round 1; the whole pot is paid out to the
  // first member in the payout order. The account must shield the full pot.
  const usdcTotal = params.contributionAmount * BigInt(params.memberLimit);

  return {
    pool,
    transparent,
    poolTxCount,
    transparentTxCount,
    feeAmount,
    poolFeeTotal,
    gasTotal,
    strkSubtotal,
    strkTotal,
    usdcTotal,
    usdcApproval: usdcTotal,
    strkApproval: poolFeeTotal,
  };
}

export function printFunding(f, params) {
  const strk = (v) => `${formatUnits(v, STRK_DECIMALS)} STRK`;
  const usdc = (v) => `${formatUnits(v, USDC_DECIMALS)} USDC`;

  console.log("\n--- Minimum funding for one complete run ---");
  console.log(`  circle: ${params.memberLimit} members x ${usdc(params.contributionAmount)} contribution`);
  console.log(`  round-1 pot (scheduled payout): ${usdc(params.scheduledPayout)}`);
  console.log("");
  console.log(`  USDC required in the operator account: ${usdc(f.usdcTotal)}`);
  console.log(`    approve the pool for at least        ${usdc(f.usdcApproval)}`);
  console.log("");
  console.log(`  pool transactions:        ${f.poolTxCount}`);
  console.log(`  transparent transactions: ${f.transparentTxCount}`);
  console.log(`  live pool fee per pool tx: ${strk(f.feeAmount)}`);
  console.log(`  pool fees total:           ${strk(f.poolFeeTotal)}`);
  console.log(`  gas allowance total:       ${strk(f.gasTotal)}`);
  console.log(`  subtotal:                  ${strk(f.strkSubtotal)}`);
  console.log(`  + ${STRK_SAFETY_MARGIN_PERCENT}% margin`);
  console.log("");
  console.log(`  STRK required in the operator account: ${strk(f.strkTotal)}`);
  console.log(`    approve the pool for at least        ${strk(f.strkApproval)} (fee pull)`);
  console.log("");
  console.log("  Transaction plan:");
  for (const t of f.pool) console.log(`    [pool]        ${t.step}  ${t.label}`);
  for (const t of f.transparent) console.log(`    [transparent] ${t.step}  ${t.label}`);
}

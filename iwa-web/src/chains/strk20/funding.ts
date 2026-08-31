// chains/strk20/funding.ts — exact funding requirements and shortfalls.
//
// Two costs are routinely conflated and must not be:
//
//   The POOL FEE is not gas. `collect_fee` pulls `get_fee_amount()` STRK from
//   the account calling `apply_actions`, via transfer_from — so it needs a
//   standing ERC-20 allowance to the pool, and it is charged once per pool
//   transaction. Wallet flows sponsor gas but NOT the pool fee.
//
//   STARKNET GAS is charged on top, on every transaction.
//
// The fee is read live because governance can change it. Nothing is hardcoded.

export const USDC_DECIMALS = 6;
export const STRK_DECIMALS = 18;

/** Budgeting headroom, not an estimate of any one transaction. */
export const GAS_ALLOWANCE_PER_POOL_TX = 3n * 10n ** 17n;
export const GAS_ALLOWANCE_PER_TRANSPARENT_TX = 5n * 10n ** 16n;
export const STRK_SAFETY_MARGIN_PERCENT = 20n;

/** Formats a token amount exactly — no rounding, no float. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac === "" ? `${whole}` : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

/** Parses a decimal string into base units without losing precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`not a decimal amount: ${value}`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places: ${value}`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export interface FundingPlan {
  memberLimit: number;
  contributionAmount: bigint;
  /** True when the shield already happened (e.g. inside the wallet). */
  shieldCompleted: boolean;
  /** Pool transactions still to send. */
  poolTxCount: number;
  transparentTxCount: number;
  feeAmount: bigint;
  poolFeeTotal: bigint;
  gasTotal: bigint;
  strkRequired: bigint;
  /**
   * Transparent USDC the account must still hold. Zero once the shield is
   * done: contributions spend the shielded balance inside the pool, never the
   * public balance.
   */
  usdcRequired: bigint;
  /** Zero once the shield is done — the pool only pulls USDC for a deposit. */
  usdcApprovalRequired: bigint;
  /** Shielded USDC the contributions will spend. Always the full pot. */
  shieldedUsdcRequired: bigint;
  strkApprovalRequired: bigint;
}

/**
 * Funding for what is left to send.
 *
 * Two distinct balances matter and must not be conflated. A CONTRIBUTION
 * withdraws from the account's SHIELDED balance inside the pool and hands it to
 * the helper; it never touches the public ERC-20 balance and needs no USDC
 * allowance. Only a DEPOSIT pulls transparent USDC, and only that requires the
 * approval. So once the shield is done — here or inside the wallet — the
 * transparent USDC requirement drops to zero.
 *
 * Each contribution still needs its own pool transaction, because the pool
 * permits at most one InvokeExternal per transaction, and each still pays the
 * pool fee in STRK.
 */
export function computeFunding(args: {
  feeAmount: bigint;
  memberLimit: number;
  contributionAmount: bigint;
  shieldCompleted?: boolean;
}): FundingPlan {
  const { feeAmount, memberLimit, contributionAmount, shieldCompleted = false } = args;

  const poolTxCount = shieldCompleted ? memberLimit : 1 + memberLimit;
  // create_circle, join x memberLimit, approve STRK, and (only when the shield
  // is still to come) approve USDC.
  const transparentTxCount = 2 + memberLimit + (shieldCompleted ? 0 : 1);

  const poolFeeTotal = feeAmount * BigInt(poolTxCount);
  const gasTotal =
    GAS_ALLOWANCE_PER_POOL_TX * BigInt(poolTxCount) +
    GAS_ALLOWANCE_PER_TRANSPARENT_TX * BigInt(transparentTxCount);
  const subtotal = poolFeeTotal + gasTotal;

  const pot = contributionAmount * BigInt(memberLimit);

  return {
    memberLimit,
    contributionAmount,
    shieldCompleted,
    poolTxCount,
    transparentTxCount,
    feeAmount,
    poolFeeTotal,
    gasTotal,
    strkRequired: subtotal + (subtotal * STRK_SAFETY_MARGIN_PERCENT) / 100n,
    usdcRequired: shieldCompleted ? 0n : pot,
    usdcApprovalRequired: shieldCompleted ? 0n : pot,
    shieldedUsdcRequired: pot,
    strkApprovalRequired: poolFeeTotal,
  };
}

export interface Shortfall {
  label: string;
  have: bigint;
  need: bigint;
  decimals: number;
  symbol: string;
}

/**
 * Everything still missing before the remaining work can run. Empty means ready.
 *
 * `shieldedUsdc` is only checked when it is known: reading it prompts the user
 * for consent, so an unknown value is reported as its own shortfall rather
 * than silently assumed to be zero or sufficient.
 */
export function computeShortfalls(args: {
  plan: FundingPlan;
  usdcBalance: bigint;
  strkBalance: bigint;
  usdcAllowance: bigint;
  strkAllowance: bigint;
  shieldedUsdc?: bigint | null;
}): Shortfall[] {
  const { plan, usdcBalance, strkBalance, usdcAllowance, strkAllowance, shieldedUsdc } = args;
  const out: Shortfall[] = [];

  const add = (
    label: string,
    have: bigint,
    need: bigint,
    decimals: number,
    symbol: string,
  ): void => {
    if (have < need) out.push({ label, have, need, decimals, symbol });
  };

  // Transparent USDC and its allowance matter only for a deposit.
  if (plan.usdcRequired > 0n) {
    add("USDC balance", usdcBalance, plan.usdcRequired, USDC_DECIMALS, "USDC");
  }
  if (plan.usdcApprovalRequired > 0n) {
    add(
      "USDC allowance to the pool",
      usdcAllowance,
      plan.usdcApprovalRequired,
      USDC_DECIMALS,
      "USDC",
    );
  }

  if (plan.shieldCompleted) {
    if (shieldedUsdc === null || shieldedUsdc === undefined) {
      out.push({
        label: "shielded USDC balance not read yet",
        have: 0n,
        need: plan.shieldedUsdcRequired,
        decimals: USDC_DECIMALS,
        symbol: "USDC",
      });
    } else {
      add("shielded USDC", shieldedUsdc, plan.shieldedUsdcRequired, USDC_DECIMALS, "USDC");
    }
  }

  add("STRK balance", strkBalance, plan.strkRequired, STRK_DECIMALS, "STRK");
  add("STRK allowance to the pool", strkAllowance, plan.strkApprovalRequired, STRK_DECIMALS, "STRK");

  return out;
}

import { describe, expect, it } from "vitest";

import {
  STRK_DECIMALS,
  USDC_DECIMALS,
  computeFunding,
  computeShortfalls,
  formatUnits,
  parseUnits,
} from "./funding";

const SIX_STRK = 6n * 10n ** 18n;
const ONE_USDC = 1_000_000n;

describe("formatUnits", () => {
  it("formats native USDC at six decimals, not eighteen", () => {
    expect(formatUnits(2_000_000n, USDC_DECIMALS)).toBe("2");
    expect(formatUnits(1_500_000n, USDC_DECIMALS)).toBe("1.5");
    expect(formatUnits(1n, USDC_DECIMALS)).toBe("0.000001");
  });

  it("does not lose precision on large STRK amounts", () => {
    expect(formatUnits(143171671625630614176n, STRK_DECIMALS)).toBe("143.171671625630614176");
  });
});

describe("parseUnits", () => {
  it("round-trips through formatUnits", () => {
    expect(parseUnits("2", USDC_DECIMALS)).toBe(2_000_000n);
    expect(parseUnits("0.000001", USDC_DECIMALS)).toBe(1n);
  });

  it("refuses more precision than the token has", () => {
    expect(() => parseUnits("1.0000001", USDC_DECIMALS)).toThrow(/decimal places/);
  });

  it("refuses junk rather than coercing it", () => {
    expect(() => parseUnits("abc", USDC_DECIMALS)).toThrow();
    expect(() => parseUnits("", USDC_DECIMALS)).toThrow();
  });
});

describe("computeFunding", () => {
  const plan = computeFunding({
    feeAmount: SIX_STRK,
    memberLimit: 2,
    contributionAmount: ONE_USDC,
  });

  it("plans one shield plus one pool transaction per member", () => {
    // The pool permits at most one InvokeExternal per transaction, so the
    // contributions cannot be batched.
    expect(plan.poolTxCount).toBe(3);
  });

  it("charges the live pool fee once per pool transaction", () => {
    expect(plan.poolFeeTotal).toBe(3n * SIX_STRK);
  });

  it("requires the whole round-1 pot in USDC", () => {
    expect(plan.usdcRequired).toBe(2n * ONE_USDC);
    expect(formatUnits(plan.usdcRequired, USDC_DECIMALS)).toBe("2");
  });

  it("requires a STRK allowance covering the fee pull, which is not gas", () => {
    expect(plan.strkApprovalRequired).toBe(plan.poolFeeTotal);
  });

  it("keeps the STRK requirement above the bare fee total", () => {
    expect(plan.strkRequired).toBeGreaterThan(plan.poolFeeTotal);
  });

  it("tracks a governance fee change instead of hardcoding it", () => {
    const doubled = computeFunding({
      feeAmount: SIX_STRK * 2n,
      memberLimit: 2,
      contributionAmount: ONE_USDC,
    });
    expect(doubled.poolFeeTotal).toBe(plan.poolFeeTotal * 2n);
  });
});

describe("computeShortfalls", () => {
  const plan = computeFunding({
    feeAmount: SIX_STRK,
    memberLimit: 2,
    contributionAmount: ONE_USDC,
  });

  it("reports every gap when the account is empty", () => {
    const gaps = computeShortfalls({
      plan,
      usdcBalance: 0n,
      strkBalance: 0n,
      usdcAllowance: 0n,
      strkAllowance: 0n,
    });
    // Grouped by token: the USDC requirements, then the STRK ones.
    expect(gaps.map((g) => g.label)).toEqual([
      "USDC balance",
      "USDC allowance to the pool",
      "STRK balance",
      "STRK allowance to the pool",
    ]);
  });

  it("reports only the real gap for the live account state", () => {
    // Measured on mainnet: STRK funded, USDC empty, no allowances yet.
    const gaps = computeShortfalls({
      plan,
      usdcBalance: 0n,
      strkBalance: 143171671625630614176n,
      usdcAllowance: 0n,
      strkAllowance: 0n,
    });
    expect(gaps.some((g) => g.label === "STRK balance")).toBe(false);
    expect(gaps.some((g) => g.label === "USDC balance")).toBe(true);
  });

  it("is empty once funded and approved", () => {
    expect(
      computeShortfalls({
        plan,
        usdcBalance: plan.usdcRequired,
        strkBalance: plan.strkRequired,
        usdcAllowance: plan.usdcApprovalRequired,
        strkAllowance: plan.strkApprovalRequired,
      }),
    ).toEqual([]);
  });
});

describe("computeFunding after an external shield", () => {
  const post = computeFunding({
    feeAmount: SIX_STRK,
    memberLimit: 2,
    contributionAmount: ONE_USDC,
    shieldCompleted: true,
  });

  it("drops the transparent USDC requirement — contributions spend the shielded balance", () => {
    expect(post.usdcRequired).toBe(0n);
    expect(post.usdcApprovalRequired).toBe(0n);
  });

  it("still requires the full pot to be shielded", () => {
    expect(post.shieldedUsdcRequired).toBe(2n * ONE_USDC);
  });

  it("charges the pool fee only for the two remaining contributions", () => {
    expect(post.poolTxCount).toBe(2);
    expect(post.poolFeeTotal).toBe(2n * SIX_STRK);
  });
});

describe("computeShortfalls after an external shield", () => {
  const post = computeFunding({
    feeAmount: SIX_STRK,
    memberLimit: 2,
    contributionAmount: ONE_USDC,
    shieldCompleted: true,
  });

  // The live wallet state that the console was wrongly blocking on.
  const live = {
    plan: post,
    usdcBalance: 299_311n,
    strkBalance: 122n * 10n ** 18n,
    usdcAllowance: 0n,
    strkAllowance: 18n * 10n ** 18n,
  };

  it("no longer blocks on transparent USDC or its allowance", () => {
    const gaps = computeShortfalls({ ...live, shieldedUsdc: 2_017_800n });
    expect(gaps.map((g) => g.label)).toEqual([]);
  });

  it("blocks when the shielded balance has not been read", () => {
    const gaps = computeShortfalls({ ...live, shieldedUsdc: null });
    expect(gaps.some((g) => g.label.includes("not read"))).toBe(true);
  });

  it("blocks when the shielded balance is short", () => {
    const gaps = computeShortfalls({ ...live, shieldedUsdc: 1_000_000n });
    expect(gaps.some((g) => g.label === "shielded USDC")).toBe(true);
  });

  it("still blocks on an insufficient STRK allowance for the remaining fees", () => {
    const gaps = computeShortfalls({
      ...live,
      strkAllowance: 6n * 10n ** 18n,
      shieldedUsdc: 2_017_800n,
    });
    expect(gaps.some((g) => g.label === "STRK allowance to the pool")).toBe(true);
  });
});

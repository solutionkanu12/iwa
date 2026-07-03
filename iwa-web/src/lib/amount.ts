// lib/amount.ts — decimals-aware token amount formatting.
//
// On chain, amounts are integer base units (stroops for native XLM, which has 7
// decimals). The UI must always show human amounts, never raw base units. These
// helpers convert both ways and take the token's decimals as a parameter so they
// work for any asset (XLM = 7, stablecoins may differ). BigInt math keeps large
// stablecoin amounts exact.

/**
 * Base units -> human amount string (baseUnits / 10^decimals), trailing zeros
 * trimmed. e.g. formatAmount(500000000, 7) === "50".
 */
export function formatAmount(
  baseUnits: bigint | number | string,
  decimals = 7,
): string {
  const units = BigInt(baseUnits);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;

  let out = whole.toString();
  if (frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    out += `.${fracStr}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * Human amount string -> base units (human * 10^decimals), as a BigInt. The
 * reverse of formatAmount, for building on-chain values from user input.
 */
export function parseAmount(human: string, decimals = 7): bigint {
  const trimmed = human.trim();
  const negative = trimmed.startsWith("-");
  const [whole = "0", frac = ""] = trimmed.replace(/^-/, "").split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const units =
    BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  return negative ? -units : units;
}

// Demo circle parameters, validated against the deployed contract's own rules.
//
// Every constraint below is transcribed from `create_circle` in
// contracts/starknet/src/iwa_circle.cairo. Validating here means a bad circle
// is rejected before a transaction is built, rather than reverting on chain
// after the gas is spent.

/** MAX_MEMBER_LIMIT in iwa_circle.cairo. */
export const MAX_MEMBER_LIMIT = 32;

/** Native USDC on Starknet has six decimals, not eighteen. */
export const USDC_DECIMALS = 6;
export const STRK_DECIMALS = 18;

const DEFAULTS = {
  contributionAmount: "1000000",
  memberLimit: 2,
  cadenceSeconds: 604800,
  gracePeriodSeconds: 86400,
};

/**
 * Reads and validates the `circle` block of the demo config.
 * `member_limit >= 2` is a contract rule, not a preference: a one-member
 * circle cannot be created at all.
 */
export function loadCircleParams(cfg) {
  const p = { ...DEFAULTS, ...(cfg.circle ?? {}) };

  const contributionAmount = BigInt(p.contributionAmount);
  const memberLimit = Number(p.memberLimit);
  const cadenceSeconds = Number(p.cadenceSeconds);
  const gracePeriodSeconds = Number(p.gracePeriodSeconds);

  if (contributionAmount <= 0n) throw new Error("circle.contributionAmount must be > 0");
  if (!Number.isInteger(memberLimit) || memberLimit < 2 || memberLimit > MAX_MEMBER_LIMIT) {
    throw new Error(`circle.memberLimit must be an integer in [2, ${MAX_MEMBER_LIMIT}]`);
  }
  if (!Number.isInteger(cadenceSeconds) || cadenceSeconds <= 0) {
    throw new Error("circle.cadenceSeconds must be a positive integer");
  }
  if (!Number.isInteger(gracePeriodSeconds) || gracePeriodSeconds <= 0) {
    throw new Error("circle.gracePeriodSeconds must be a positive integer");
  }

  // IWA-07: contribution_amount * member_limit must fit in u128.
  const scheduledPayout = contributionAmount * BigInt(memberLimit);
  if (scheduledPayout >= 1n << 128n) {
    throw new Error("contributionAmount * memberLimit overflows u128");
  }

  return {
    contributionAmount,
    memberLimit,
    cadenceSeconds,
    gracePeriodSeconds,
    scheduledPayout,
  };
}

/** Formats a token amount for humans without losing exactness. */
export function formatUnits(amount, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}` : `${whole}.${frac}`;
}

/**
 * The demo's transaction shape. Two kinds matter for funding:
 *
 *   POOL transactions call `apply_actions` and each pull the pool fee in STRK
 *   from the submitting account, on top of Starknet gas.
 *
 *   TRANSPARENT transactions are ordinary Starknet calls (ERC-20 approvals and
 *   IWA circle bookkeeping) and cost gas only.
 *
 * The pool enforces at most one InvokeExternal per transaction, so each
 * contribution needs its own pool transaction — that is a protocol constraint,
 * not a design choice.
 */
export function transactionPlan(memberLimit) {
  const pool = [
    { step: "04_deposit", label: "register + shield USDC into the pool", touchesPool: true },
  ];
  for (let i = 0; i < memberLimit; i += 1) {
    pool.push({
      step: "05_contribute",
      label: `contribution settlement for member ${String.fromCharCode(65 + i)}`,
      touchesPool: true,
    });
  }
  pool.push({ step: "06_payout", label: "payout settlement to an open note", touchesPool: true });

  const transparent = [
    { step: "04_deposit", label: "approve USDC to the pool (deposit pull)" },
    { step: "04_deposit", label: "approve STRK to the pool (fee pull, all runs)" },
    { step: "00_prepare", label: "create_circle" },
    ...Array.from({ length: memberLimit }, (_, i) => ({
      step: "00_prepare",
      label: `join_circle member ${String.fromCharCode(65 + i)}`,
    })),
    { step: "06_payout", label: "finalize_round_payout_accounting" },
    { step: "06_payout", label: "authorize_payout_settlement" },
  ];

  return { pool, transparent };
}

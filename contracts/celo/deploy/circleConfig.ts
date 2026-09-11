// deploy/circleConfig.ts — the shape of one circle's deployment values, and
// the checks that must pass before any of them reach a real transaction.
//
// The real member list, contribution amount, cadence, and grace period are
// product decisions, not something this tooling invents. They live in a
// local, untracked JSON file (see circle.example.json for the shape) so the
// exact values can be reviewed as plain text before a deploy ever runs.

import { readFileSync } from "fs";
import { resolve } from "path";

/** Canonical cNGN on Celo mainnet. The only token this tooling will deploy against. */
export const CNGN_MAINNET = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
export const CELO_MAINNET_CHAIN_ID = 42220;
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 32;

export interface CircleDeployConfig {
  /** Must equal CNGN_MAINNET; kept as a field (not hardcoded away) so the
   *  config file itself states what it deploys against, for review. */
  token: string;
  /** Base units, as a decimal string (exact — never a JS number). */
  contributionAmount: string;
  cadenceSeconds: number;
  gracePeriodSeconds: number;
  /** Payout order. Position i is `scheduledMember(i + 1)`. */
  members: string[];
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS.test(value);
}

/**
 * Loads and shape-validates a config file. Throws with a specific message on
 * anything malformed — a deploy script must never guess a missing or
 * wrong-typed field into a default.
 */
export function loadCircleConfig(path: string): CircleDeployConfig {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    throw new Error(
      `Could not read circle config at ${absolute}. Copy deploy/circle.example.json to a local, ` +
        `untracked file with the real values and point CIRCLE_CONFIG_PATH at it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Circle config at ${absolute} is not valid JSON: ${(e as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Circle config at ${absolute} must be a JSON object.`);
  }
  const c = parsed as Record<string, unknown>;

  if (typeof c.token !== "string") {
    throw new Error("Circle config: 'token' must be a string address.");
  }
  if (typeof c.contributionAmount !== "string") {
    throw new Error("Circle config: 'contributionAmount' must be a decimal string (base units).");
  }
  if (typeof c.cadenceSeconds !== "number" || !Number.isInteger(c.cadenceSeconds)) {
    throw new Error("Circle config: 'cadenceSeconds' must be an integer.");
  }
  if (typeof c.gracePeriodSeconds !== "number" || !Number.isInteger(c.gracePeriodSeconds)) {
    throw new Error("Circle config: 'gracePeriodSeconds' must be an integer.");
  }
  if (!Array.isArray(c.members) || !c.members.every((m) => typeof m === "string")) {
    throw new Error("Circle config: 'members' must be an array of address strings.");
  }

  return {
    token: c.token,
    contributionAmount: c.contributionAmount,
    cadenceSeconds: c.cadenceSeconds,
    gracePeriodSeconds: c.gracePeriodSeconds,
    members: c.members as string[],
  };
}

/**
 * Every check the contract's own constructor would enforce, run here first
 * so a bad config fails with a specific, readable reason instead of a
 * reverted (and gas-spent) transaction. Returns every problem found, not
 * just the first, so a reviewer sees the whole picture in one pass.
 *
 * Deliberately does NOT require gracePeriodSeconds > 0: the contract itself
 * allows a zero grace period (no late window), so requiring more here would
 * reject a legitimate configuration the contract is fine with.
 */
export function validateDeployConfig(config: CircleDeployConfig): string[] {
  const errors: string[] = [];

  if (!isEvmAddress(config.token)) {
    errors.push(`token is not a valid EVM address: ${String(config.token)}`);
  } else if (config.token.toLowerCase() !== CNGN_MAINNET.toLowerCase()) {
    errors.push(`token must be canonical cNGN (${CNGN_MAINNET}), got ${config.token}`);
  }

  let amount: bigint | null = null;
  try {
    amount = BigInt(config.contributionAmount);
  } catch {
    errors.push(`contributionAmount is not a valid integer string: ${config.contributionAmount}`);
  }
  if (amount !== null && amount <= 0n) {
    errors.push("contributionAmount must be greater than zero");
  }

  if (!Number.isInteger(config.cadenceSeconds) || config.cadenceSeconds <= 0) {
    errors.push("cadenceSeconds must be a positive integer");
  }
  if (!Number.isInteger(config.gracePeriodSeconds) || config.gracePeriodSeconds < 0) {
    errors.push("gracePeriodSeconds must be a non-negative integer");
  }

  if (!Array.isArray(config.members)) {
    errors.push("members must be an array");
  } else {
    if (config.members.length < MIN_MEMBERS || config.members.length > MAX_MEMBERS) {
      errors.push(
        `member count must be between ${MIN_MEMBERS} and ${MAX_MEMBERS}, got ${config.members.length}`,
      );
    }
    const seen = new Set<string>();
    for (const member of config.members) {
      if (!isEvmAddress(member)) {
        errors.push(`member is not a valid EVM address: ${String(member)}`);
        continue;
      }
      if (member === "0x0000000000000000000000000000000000000000") {
        errors.push("members must not include the zero address");
        continue;
      }
      const key = member.toLowerCase();
      if (seen.has(key)) {
        errors.push(`duplicate member address: ${member}`);
      }
      seen.add(key);
    }
  }

  return errors;
}

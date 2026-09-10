// chains/strk20/v2/deployCapabilityProbe.ts — DEV-ONLY.
//
// Option A capability check: does the connected Ready X browser wallet actually
// implement `wallet_addDeclareTransaction`? This module only READS wallet
// capability and, at most, runs a NON-SENDING fee estimate. It never sends a
// transaction and never asks the wallet to sign a real declare/deploy.
//
// `wallet_addDeclareTransaction` support cannot be queried directly, so it is
// probed by calling it with a payload that is:
//   * STRUCTURALLY VALID   — the real IwaCircleV2 Sierra class: a present, valid
//     `sierra_program`, a valid `contract_class_version`, real
//     `entry_points_by_type`, and `abi` serialized as a string (the RPC
//     CONTRACT_CLASS shape) — so nothing can crash on a null/missing field; and
//   * DELIBERATELY UNDECLARABLE — `compiled_class_hash` set to `0x1`, which does
//     not match the class. A compliant wallet MUST reject this before it can
//     submit or sign, because the class↔hash binding is invalid.
//
// Classification of the rejection:
//   method-not-found / -32601 / "unsupported method"        -> DECLARE_BLOCKED
//   invalid params / compiled-class-hash mismatch / "already
//     declared" / class-size limit / fee-estimate rejection -> DECLARE_SUPPORTED
//   a user approval prompt is reached (user cancels)        -> DECLARE_SUPPORTED
//   a client-side TypeError ("cannot read properties …")    -> INCONCLUSIVE
//     (this is the 2026-09-10 failure mode from the null-contract_class probe;
//      it means our payload never reached the wallet's own logic)
//   anything else                                            -> INCONCLUSIVE
//
// Ready X shows an approval prompt for wallet_addDeclareTransaction, and its
// cancellation does NOT settle the request promise. `raceRequestWithTimeout`
// abandons the pending request after a short timeout; the caller then asks the
// user whether a prompt was seen/cancelled (`confirmDeclarePrompt`). "Yes" is
// classified DECLARE_SUPPORTED — a prompt is proof the method exists and reached
// the approval stage, and compiled_class_hash=0x1 means an accidental approval
// is still rejected at validation (COMPILED_CLASS_HASH_MISMATCH), never a fee.

import { hash } from "starknet";

/** The V2 class hashes frozen in the deployment plan / iwa-deploy-v2.sh. */
export const EXPECTED_CIRCLE_V2_CLASS =
  "0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a";
export const EXPECTED_CIRCLE_V2_COMPILED_CLASS =
  "0x022abd3af698ad7971f53d33c52bf9b0c6931f33a248bf1f6590f1fed02e1dc8";

/** A valid felt that is NOT the real compiled class hash — forces a pre-sign reject. */
export const WRONG_COMPILED_CLASS_HASH = "0x1";

export type MethodSupport = "SUPPORTED" | "BLOCKED" | "INCONCLUSIVE";

export interface RawContractClass {
  sierra_program?: unknown;
  contract_class_version?: unknown;
  entry_points_by_type?: unknown;
  abi?: unknown;
}

/** The wallet-API `ADD_DECLARE_TRANSACTION_PARAMETERS` for the probe. */
export interface DeclareProbeParams {
  compiled_class_hash: string;
  contract_class: {
    sierra_program: unknown;
    contract_class_version: string;
    entry_points_by_type: unknown;
    /** RPC CONTRACT_CLASS.abi is a string, not an array. */
    abi: string;
  };
}

/**
 * Builds a structurally VALID declare payload from the real IwaCircleV2 Sierra
 * artifact, with `compiled_class_hash` deliberately wrong (`0x1`). Throws if the
 * artifact is missing the fields a real declare needs — the caller then reports
 * that it could not build the strict probe (rather than sending a weak one).
 */
export function buildDeclareProbeParams(sierra: RawContractClass): DeclareProbeParams {
  if (!Array.isArray(sierra.sierra_program) || sierra.sierra_program.length === 0) {
    throw new Error("artifact has no sierra_program — cannot build a valid declare probe");
  }
  if (typeof sierra.contract_class_version !== "string" || !sierra.contract_class_version) {
    throw new Error("artifact has no contract_class_version");
  }
  const ep = sierra.entry_points_by_type as Record<string, unknown> | undefined;
  if (
    !ep ||
    !Array.isArray(ep.CONSTRUCTOR) ||
    !Array.isArray(ep.EXTERNAL) ||
    !Array.isArray(ep.L1_HANDLER)
  ) {
    throw new Error("artifact has no valid entry_points_by_type");
  }
  const abi =
    typeof sierra.abi === "string"
      ? sierra.abi
      : JSON.stringify(sierra.abi ?? []); // RPC CONTRACT_CLASS.abi is a string
  if (abi === "[]" || abi === "" || abi === "null") {
    throw new Error("artifact has no ABI — cannot build a valid declare probe");
  }
  return {
    compiled_class_hash: WRONG_COMPILED_CLASS_HASH,
    contract_class: {
      sierra_program: sierra.sierra_program,
      contract_class_version: sierra.contract_class_version,
      entry_points_by_type: {
        CONSTRUCTOR: ep.CONSTRUCTOR,
        EXTERNAL: ep.EXTERNAL,
        L1_HANDLER: ep.L1_HANDLER,
      },
      abi,
    },
  };
}

/** An intentionally invalid `wallet_addInvokeTransaction` payload for the probe. */
export const INVALID_INVOKE_PROBE_PARAMS = { calls: "not-an-array" } as const;

const CLIENT_SIDE_CRASH = [
  "cannot read propert",
  "cannot read properties",
  "is not a function",
  "undefined is not an object",
  "null is not an object",
  "reading '",
  "reading \"",
  "of undefined",
  "of null",
];

const BLOCKED_MARKERS = [
  "method not found",
  "-32601",
  "method_not_found",
  "methodnotfound",
  "not implemented",
  "not_implemented",
  "notimplemented",
  "unsupported method",
  "unsupported request",
  "unknown method",
  "unknown request",
  "unrecognized method",
  "no such method",
  "no handler",
  "handler not found",
  "method not supported",
  "not supported by",
  "wallet_adddeclaretransaction is not",
  "adddeclaretransaction is not supported",
  "declare is not supported",
  "declaration is not supported",
];

const SUPPORTED_MARKERS = [
  // param / class validation from inside the method
  "invalid_request_payload",
  "invalid request payload",
  "invalid params",
  "-32602",
  "compiled_class_hash",
  "compiled class hash",
  "class hash mismatch",
  "compiled_class_hash_mismatch",
  "does not match",
  "invalid compiled",
  "recompil",
  "casm",
  "sierra_program",
  "contract_class",
  "contract class",
  "missing field",
  "expected",
  "schema",
  "deseriali",
  // the class is fine but undeclarable-as-is for a real reason -> method ran
  "already declared",
  "class_already_declared",
  "contract_class_size",
  "class size",
  "too large",
  // reached the estimate / signing stage
  "estimate",
  "insufficient",
  "balance",
  "nonce",
  "resource",
  "fee",
  // user reached a prompt and cancelled
  "user_refused",
  "user refused",
  "user abort",
  "user rejected",
  "user_rejected",
  "rejected by user",
  "declined",
  "user_canceled",
  "user_cancelled",
  "cancelled",
  "canceled",
];

/**
 * Classifies a rejection from calling `wallet_addDeclareTransaction` (or
 * `wallet_addInvokeTransaction`) with the guarded probe payload.
 */
export function classifyMethodProbe(
  outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
): { support: MethodSupport; reason: string } {
  if (outcome.ok) {
    return {
      support: "SUPPORTED",
      reason:
        "the wallet returned a result for a deliberately-undeclarable payload — unexpected; " +
        "the method clearly exists, but verify no transaction was created",
    };
  }
  const raw = describeError(outcome.error).toLowerCase();

  if (CLIENT_SIDE_CRASH.some((s) => raw.includes(s))) {
    return {
      support: "INCONCLUSIVE",
      reason:
        "a client-side TypeError was thrown before the wallet's own logic ran — the probe " +
        `payload never reached the method. Not a wallet verdict: ${trim(raw)}`,
    };
  }
  if (BLOCKED_MARKERS.some((s) => raw.includes(s))) {
    return { support: "BLOCKED", reason: `wallet reports the method is unavailable: ${trim(raw)}` };
  }
  if (SUPPORTED_MARKERS.some((s) => raw.includes(s))) {
    return {
      support: "SUPPORTED",
      reason: `the method exists — it rejected the invalid payload / reached the user: ${trim(raw)}`,
    };
  }
  return { support: "INCONCLUSIVE", reason: `could not classify the rejection: ${trim(raw)}` };
}

export interface EstimateShape {
  overall_fee: string;
  unit?: string;
  l1_gas?: string;
  l1_data_gas?: string;
  l2_gas?: string;
  resourceBounds?: unknown;
}

export type DeclareProbeOutcome =
  | { ok: true; result: unknown; strict: boolean }
  | { ok: false; error: unknown; strict: boolean }
  /**
   * The wallet request neither resolved nor rejected within the timeout. With
   * the guarded payload the only expected cause is a Ready X approval prompt
   * whose cancellation does not settle the promise. The caller then asks the
   * user (`confirmDeclarePrompt`) whether a wallet prompt was seen/cancelled.
   */
  | { pending: true; strict: boolean; timeoutMs: number }
  | { unavailable: string };

/**
 * Races a wallet request against a timeout. A late settlement is swallowed so it
 * cannot become an unhandled rejection — the probe abandons the request rather
 * than trying to cancel it (wallets expose no cancel).
 */
export async function raceRequestWithTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = request.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  // Never let a settlement that arrives after the timeout throw into the void.
  void settled.catch(() => {});
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export interface DeployCapabilityReport {
  walletName: string;
  address: string;
  chainId: string;
  supportedSpecs: string[] | { error: string };
  supportedWalletApi: string[] | { error: string };
  walletFeatureKeys: string[];
  /** Anything the injected provider exposes that could prove support without a call. */
  providerCapabilityHints: Record<string, unknown>;
  addDeclareTransaction: {
    support: MethodSupport;
    reason: string;
    strictPayload: boolean;
    rawError?: string;
    /** true when the wallet request timed out (a Ready X prompt is the expected cause). */
    pendingAfterTimeout?: boolean;
    /** true when the user confirmed a wallet approval prompt appeared and was cancelled. */
    userConfirmedPrompt?: boolean;
  };
  addInvokeTransaction: { support: MethodSupport; reason: string; rawError?: string };
  account: { declare: boolean; deploy: boolean; execute: boolean };
  verdict: "DECLARE_SUPPORTED" | "DECLARE_BLOCKED" | "INCONCLUSIVE";
  feeEstimate?:
    | { ok: true; estimate: EstimateShape; classHash: string; classHashMatchesExpected: boolean }
    | { ok: false; error: string }
    | { skipped: string };
}

export interface CapabilityProbeDeps {
  walletName: string;
  address: string;
  chainId: string;
  supportedSpecs: () => Promise<string[]>;
  supportedWalletApi: () => Promise<string[]>;
  walletFeatureKeys: () => string[];
  providerCapabilityHints: () => Record<string, unknown>;
  /**
   * Call `wallet_addDeclareTransaction` with the guarded probe payload built
   * from the real Sierra artifact. Returns `{ unavailable }` when the artifact
   * is not loaded (then the strict probe cannot run).
   */
  probeAddDeclare: () => Promise<DeclareProbeOutcome>;
  probeAddInvoke: () => Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }>;
  /**
   * Asked ONLY when `probeAddDeclare` returns `pending`: did a Ready X approval
   * prompt appear (and was it cancelled)? `true` classifies DECLARE_SUPPORTED —
   * a prompt is proof the method exists and reached the approval stage.
   */
  confirmDeclarePrompt?: () => Promise<boolean>;
  account: { declare: unknown; deploy: unknown; execute: unknown };
  estimateCircleV2DeclareFee?: () => Promise<{ estimate: EstimateShape; sierra: unknown } | null>;
}

export async function runDeployCapabilityProbe(
  deps: CapabilityProbeDeps,
): Promise<DeployCapabilityReport> {
  const specs = await settle(deps.supportedSpecs());
  const api = await settle(deps.supportedWalletApi());

  const declOutcome = await deps.probeAddDeclare();
  const invOutcome = await deps.probeAddInvoke();

  let decl: { support: MethodSupport; reason: string };
  let declStrict = false;
  let declRaw: string | undefined;
  let declPendingAfterTimeout = false;
  let declUserConfirmedPrompt = false;
  if ("unavailable" in declOutcome) {
    decl = { support: "INCONCLUSIVE", reason: `strict probe not run: ${declOutcome.unavailable}` };
  } else if ("pending" in declOutcome) {
    declStrict = declOutcome.strict;
    declPendingAfterTimeout = true;
    const confirmed = deps.confirmDeclarePrompt ? await deps.confirmDeclarePrompt() : false;
    declUserConfirmedPrompt = confirmed;
    decl = confirmed
      ? {
          support: "SUPPORTED",
          reason:
            `the wallet_addDeclareTransaction request stayed pending past ${declOutcome.timeoutMs}ms ` +
            "AND the user confirmed a Ready X approval prompt appeared and was cancelled — the " +
            "method exists and reached the approval stage; no transaction was submitted " +
            "(compiled_class_hash was 0x1)",
        }
      : {
          support: "INCONCLUSIVE",
          reason:
            `the wallet_addDeclareTransaction request stayed pending past ${declOutcome.timeoutMs}ms ` +
            "and no wallet approval prompt was confirmed — re-run, or confirm the prompt if you saw one",
        };
  } else {
    declStrict = declOutcome.strict;
    decl = classifyMethodProbe(
      declOutcome.ok
        ? { ok: true, result: declOutcome.result }
        : { ok: false, error: declOutcome.error },
    );
    declRaw = declOutcome.ok ? undefined : trim(describeError(declOutcome.error));
  }

  const inv = classifyMethodProbe(invOutcome);

  const account = {
    declare: typeof deps.account.declare === "function",
    deploy: typeof deps.account.deploy === "function",
    execute: typeof deps.account.execute === "function",
  };

  const verdict: DeployCapabilityReport["verdict"] =
    decl.support === "SUPPORTED" && account.declare && account.deploy && account.execute
      ? "DECLARE_SUPPORTED"
      : decl.support === "BLOCKED"
        ? "DECLARE_BLOCKED"
        : "INCONCLUSIVE";

  const report: DeployCapabilityReport = {
    walletName: deps.walletName,
    address: deps.address,
    chainId: deps.chainId,
    supportedSpecs: specs,
    supportedWalletApi: api,
    walletFeatureKeys: deps.walletFeatureKeys(),
    providerCapabilityHints: safeHints(deps.providerCapabilityHints),
    addDeclareTransaction: {
      support: decl.support,
      reason: decl.reason,
      strictPayload: declStrict,
      rawError: declRaw,
      pendingAfterTimeout: declPendingAfterTimeout || undefined,
      userConfirmedPrompt: declUserConfirmedPrompt || undefined,
    },
    addInvokeTransaction: {
      support: inv.support,
      reason: inv.reason,
      rawError: invOutcome.ok ? undefined : trim(describeError(invOutcome.error)),
    },
    account,
    verdict,
  };

  if (deps.estimateCircleV2DeclareFee) {
    if (verdict === "DECLARE_SUPPORTED") {
      try {
        const r = await deps.estimateCircleV2DeclareFee();
        if (r === null) {
          report.feeEstimate = { skipped: "Sierra artifact not available for the fee estimate" };
        } else {
          const classHash = hash.computeContractClassHash(r.sierra as never);
          report.feeEstimate = {
            ok: true,
            estimate: r.estimate,
            classHash,
            classHashMatchesExpected: eqFelt(classHash, EXPECTED_CIRCLE_V2_CLASS),
          };
        }
      } catch (e) {
        report.feeEstimate = { ok: false, error: trim(describeError(e)) };
      }
    } else {
      report.feeEstimate = {
        skipped: `fee estimate not attempted (declare support is ${decl.support})`,
      };
    }
  }

  return report;
}

// --- helpers ---

function safeHints(fn: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return fn();
  } catch (e) {
    return { error: trim(describeError(e)) };
  }
}

async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e) {
    return { error: trim(describeError(e)) };
  }
}

export function describeError(e: unknown): string {
  if (e === null || e === undefined) return "empty rejection";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "Error";
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts: string[] = [];
    if (o.code !== undefined) parts.push(`code ${String(o.code)}`);
    if (typeof o.message === "string" && o.message) parts.push(o.message);
    if (typeof o.data === "string" && o.data) parts.push(o.data);
    else if (o.data && typeof o.data === "object") {
      try {
        parts.push(JSON.stringify(o.data));
      } catch {
        /* ignore */
      }
    }
    if (parts.length) return parts.join(": ");
    try {
      return JSON.stringify(e);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  return String(e);
}

function trim(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

function eqFelt(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

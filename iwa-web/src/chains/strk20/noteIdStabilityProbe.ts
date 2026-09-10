// A1 — Candidate P live-wallet note-id stability probe.
//
// THE ONE OPEN GATE for Candidate P (docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md
// §3.5): does a real privacy-enabled Starknet wallet, via the SHIPPED
// `wallet_strk20PrepareInvoke`, expose a resolved open-note id in the returned
// call — and is that id the same one the final submission uses, as long as no
// note is created in between?
//
// Forensic build (2026-09-09): after a live run on Ready X where a second
// `prepare(simulate)` returned no resolved id, this module now
//   * searches the WHOLE prepare response for the sentinel-wrapped id
//     (`findResolvedOpenNoteIdDeep`), not just `call.calldata`;
//   * records a SAFE structural fingerprint of each response
//     (`inspectPrepareResponse`) — never `proof.data`, never a viewing key
//     (the Wallet API does not put one in this response anyway);
//   * captures wallet errors instead of silently collapsing them to null;
//   * retries a failed/unresolved prepare once after a short delay;
//   * accepts a `priorStableId` so a follow-up run does not re-derive #1/#2
//     and does not HARD-reject Candidate P on a single transient flake
//     (verdict `INCONSISTENT_ACROSS_RUNS`).
//
// No wallet API is invented. It calls only `supportedWalletApi`,
// `wallet_strk20PrepareInvoke`, and `wallet_strk20InvokeTransaction`.

import type { STRK20_ACTION } from "@starknet-io/types-js";

/**
 * Distinctive felts the probe wraps around `${openNoteIds[0]}` (and, as a
 * control, `${poolAddress}`) in the invoke calldata, so the resolved values can
 * be located anywhere in the prepared response.
 *
 * Every one MUST be a valid Wallet API `FELT`: it goes into
 * `wallet_strk20PrepareInvoke` calldata, and Ready X validates each item against
 * `^0x(0|[a-fA-F1-9]{1}[a-fA-F0-9]{0,62})$` — at most 63 hex digits — and against
 * the Stark field prime. A value that fails either is rejected with
 * `INVALID_REQUEST_PAYLOAD` (this is the 2026-09-09 bug: the previous pool
 * sentinels were 64 hex digits AND above the prime). They are derived from short
 * ASCII strings (Cairo short-string style, <= 31 bytes => <= 62 hex digits,
 * top byte < 0x80 => well below the prime) so they cannot regress.
 */
function asciiFelt(s: string): bigint {
  if (s.length > 31) throw new Error(`sentinel string too long (max 31): ${s}`);
  let acc = 0n;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) throw new Error(`sentinel must be ASCII: ${s}`);
    acc = (acc << 8n) | BigInt(code);
  }
  return acc;
}

export const PROBE_SENTINEL_BEFORE = asciiFelt("A1PROBE_OPEN_NOTE_ID_BEFORE");
export const PROBE_SENTINEL_AFTER = asciiFelt("A1PROBE_OPEN_NOTE_ID_AFTER");
export const PROBE_POOL_SENTINEL_BEFORE = asciiFelt("A1PROBE_POOL_ADDR_BEFORE");
export const PROBE_POOL_SENTINEL_AFTER = asciiFelt("A1PROBE_POOL_ADDR_AFTER");

const OPEN_NOTE_PLACEHOLDER = "${openNoteIds[0]}";
const POOL_ADDRESS_PLACEHOLDER = "${poolAddress}";
const ANY_PLACEHOLDER = /\$\{(openNoteIds\[\d+\]|poolAddress)\}/;

/** Parses a felt string to bigint, or null if it is not a plain numeric felt. */
function feltOrNull(v: unknown): bigint | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

/**
 * Scan one flat calldata array for `[before, X, after]` and return X (non-zero
 * felt) or null. Kept for the known-position case and its unit tests.
 */
export function findResolvedOpenNoteId(applyActionsCalldata: string[]): bigint | null {
  return scanArrayForPair(applyActionsCalldata, PROBE_SENTINEL_BEFORE, PROBE_SENTINEL_AFTER);
}

function scanArrayForPair(arr: unknown[], before: bigint, after: bigint): bigint | null {
  for (let i = 0; i + 2 <= arr.length - 1; i++) {
    if (feltOrNull(arr[i]) === before && feltOrNull(arr[i + 2]) === after) {
      const mid = feltOrNull(arr[i + 1]);
      return mid === null || mid === 0n ? null : mid;
    }
  }
  return null;
}

type ArrayVisitor = (arr: unknown[], path: string) => void;

/** Depth-first walk of every array in an arbitrary value, with its dotted path. */
function walkArrays(node: unknown, path: string, visit: ArrayVisitor): void {
  if (Array.isArray(node)) {
    visit(node, path);
    node.forEach((v, i) => walkArrays(v, `${path}[${i}]`, visit));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walkArrays((node as Record<string, unknown>)[key], path ? `${path}.${key}` : key, visit);
    }
  }
}

/**
 * Search the ENTIRE prepare response for the sentinel-wrapped resolved id,
 * wherever the wallet put the assembled server actions (`call.calldata`,
 * `proof.output`, or a nested field). First match wins.
 */
export function findResolvedOpenNoteIdDeep(
  built: unknown,
): { id: bigint | null; foundAt: string | null } {
  let hit: { id: bigint; foundAt: string } | null = null;
  walkArrays(built, "", (arr, path) => {
    if (hit) return;
    for (let i = 0; i + 2 <= arr.length - 1; i++) {
      if (
        feltOrNull(arr[i]) === PROBE_SENTINEL_BEFORE &&
        feltOrNull(arr[i + 2]) === PROBE_SENTINEL_AFTER
      ) {
        const mid = feltOrNull(arr[i + 1]);
        if (mid !== null && mid !== 0n) {
          hit = { id: mid, foundAt: `${path}[${i}..${i + 2}]` };
          return;
        }
      }
    }
  });
  return hit ?? { id: null, foundAt: null };
}

/** SAFE structural fingerprint of a `wallet_strk20PrepareInvoke` response. */
export interface PrepareInspection {
  ok: boolean;
  /** Error message/code only — never a stack trace. */
  error: string | null;
  /** true if a retry was needed to get this response. */
  retried: boolean;
  topKeys: string[];
  call: {
    keys: string[];
    calldataLength: number | null;
    itemKinds: string[];
    hasPlaceholderLiteral: boolean;
  } | null;
  proof: {
    keys: string[];
    /** length of `proof.data` — the value itself is never recorded. */
    dataLength: number;
    outputLength: number;
    proofFactsLength: number;
  } | null;
  /** Paths where `[BEFORE, X, AFTER]` was found (open-note sentinel). */
  sentinelPairPaths: string[];
  /** The X values found, hex. These are public on-chain calldata, safe to record. */
  resolvedIdCandidatesHex: string[];
  /** Paths where an unresolved `${openNoteIds…}` / `${poolAddress}` string appears. */
  placeholderLiteralPaths: string[];
  /** Control: did the wallet resolve `${poolAddress}` (⇒ it does substitution at all)? */
  poolAddressPlaceholderResolved: boolean | null;
}

function formatErr(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.name ? `${error.name}: ${error.message}` : error.message;
  if (typeof error === "object") {
    const o = error as Record<string, unknown>;
    const parts: string[] = [];
    if (o.code !== undefined) parts.push(`code ${String(o.code)}`);
    if (typeof o.message === "string" && o.message) parts.push(o.message);
    if (typeof o.data === "string" && o.data) parts.push(o.data);
    if (parts.length) return parts.join(": ");
    try {
      return JSON.stringify(error);
    } catch {
      return "unserialisable error object";
    }
  }
  return String(error);
}

function itemKind(v: unknown): string {
  if (typeof v !== "string") return typeof v;
  if (ANY_PLACEHOLDER.test(v)) return "placeholder";
  if (/^0x[0-9a-fA-F]+$/.test(v)) return "hex";
  if (/^\d+$/.test(v)) return "dec";
  return "other-string";
}

export function inspectPrepareResponse(
  built: unknown,
  error?: unknown,
  retried = false,
): PrepareInspection {
  const errStr = formatErr(error);
  const isObj = built !== null && typeof built === "object";
  const topKeys = isObj ? Object.keys(built as Record<string, unknown>) : [];

  let call: PrepareInspection["call"] = null;
  const callNode = isObj ? (built as Record<string, unknown>).call : undefined;
  if (callNode && typeof callNode === "object") {
    const cd = (callNode as Record<string, unknown>).calldata;
    const cdArr = Array.isArray(cd) ? cd : null;
    call = {
      keys: Object.keys(callNode as Record<string, unknown>),
      calldataLength: cdArr ? cdArr.length : null,
      itemKinds: cdArr ? cdArr.map(itemKind) : [],
      hasPlaceholderLiteral: cdArr
        ? cdArr.some((x) => typeof x === "string" && ANY_PLACEHOLDER.test(x))
        : false,
    };
  }

  let proof: PrepareInspection["proof"] = null;
  const proofNode = isObj ? (built as Record<string, unknown>).proof : undefined;
  if (proofNode && typeof proofNode === "object") {
    const p = proofNode as Record<string, unknown>;
    proof = {
      keys: Object.keys(p),
      dataLength: typeof p.data === "string" ? p.data.length : 0,
      outputLength: Array.isArray(p.output) ? p.output.length : 0,
      proofFactsLength: Array.isArray(p.proof_facts) ? p.proof_facts.length : 0,
    };
  }

  const sentinelPairPaths: string[] = [];
  const resolvedIdCandidatesHex: string[] = [];
  const placeholderLiteralPaths: string[] = [];
  let poolResolved: boolean | null = null;

  walkArrays(built, "", (arr, path) => {
    for (let i = 0; i + 2 <= arr.length - 1; i++) {
      if (
        feltOrNull(arr[i]) === PROBE_SENTINEL_BEFORE &&
        feltOrNull(arr[i + 2]) === PROBE_SENTINEL_AFTER
      ) {
        const mid = feltOrNull(arr[i + 1]);
        sentinelPairPaths.push(`${path}[${i}..${i + 2}]`);
        if (mid !== null && mid !== 0n) resolvedIdCandidatesHex.push(`0x${mid.toString(16)}`);
      }
      if (
        feltOrNull(arr[i]) === PROBE_POOL_SENTINEL_BEFORE &&
        feltOrNull(arr[i + 2]) === PROBE_POOL_SENTINEL_AFTER
      ) {
        const mid = feltOrNull(arr[i + 1]);
        poolResolved = mid !== null && mid !== 0n;
      }
    }
    arr.forEach((v, i) => {
      if (typeof v === "string" && ANY_PLACEHOLDER.test(v)) {
        placeholderLiteralPaths.push(`${path}[${i}]`);
        if (v.includes("poolAddress")) poolResolved = false;
      }
    });
  });

  return {
    ok: errStr === null && isObj,
    error: errStr,
    retried,
    topKeys,
    call,
    proof,
    sentinelPairPaths,
    resolvedIdCandidatesHex,
    placeholderLiteralPaths,
    poolAddressPlaceholderResolved: poolResolved,
  };
}

const felt = (v: string): string => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`felt must be non-negative: ${v}`);
  return `0x${n.toString(16)}`;
};

/**
 * The probe's STRK20 actions: open one note to self, then a single invoke whose
 * calldata carries a sentinel-wrapped `${openNoteIds[0]}` (the value we care
 * about) and a sentinel-wrapped `${poolAddress}` (a control — if THIS resolves
 * but the note id does not, the wallet does substitution but cannot compute the
 * note id, e.g. no self-subchannel for the token yet).
 */
export function buildProbeActions(args: {
  token: string;
  selfAddress: string;
  probeContract: string;
}): STRK20_ACTION[] {
  return [
    { type: "transfer", token: felt(args.token), amount: "OPEN", recipient: felt(args.selfAddress) },
    {
      type: "invoke",
      contract: felt(args.probeContract),
      calldata: [
        `0x${PROBE_SENTINEL_BEFORE.toString(16)}`,
        OPEN_NOTE_PLACEHOLDER,
        `0x${PROBE_SENTINEL_AFTER.toString(16)}`,
        `0x${PROBE_POOL_SENTINEL_BEFORE.toString(16)}`,
        POOL_ADDRESS_PLACEHOLDER,
        `0x${PROBE_POOL_SENTINEL_AFTER.toString(16)}`,
      ],
    },
  ];
}

export type ProbeVerdict =
  | "PASS"
  | "PARTIAL_STABLE_PENDING_SHIFT"
  | "REJECT_UNSTABLE"
  | "REJECT_NO_RESOLVED_ID"
  | "INCONCLUSIVE_ID_DID_NOT_SHIFT"
  | "INCONSISTENT_ACROSS_RUNS"
  | "WALLET_UNSUPPORTED";

export interface ProbeObservation {
  walletSupportsStrk20: boolean;
  first: bigint | null;
  second: bigint | null;
  afterInterveningNote: bigint | null;
  /**
   * One entry per `wallet_strk20PrepareInvoke` call actually made this run.
   * Always present on `CompletedProbe.observed`; optional on the bare type so
   * `classifyProbe` can be called with a plain observation in tests.
   */
  inspections?: PrepareInspection[];
}

export interface ProbeResult {
  verdict: ProbeVerdict;
  detail?: string;
  observed?: ProbeObservation;
}

export interface CompletedProbe extends ProbeResult {
  observed: ProbeObservation & { inspections: PrepareInspection[] };
}

export interface ClassifyOpts {
  /** A resolved id a PRIOR run confirmed as stable, if any. */
  priorStableId?: bigint | null;
}

const idHex = (v: bigint | null): string => (v === null ? "none" : `0x${v.toString(16)}`);

/** Turn the observed ids into the A1 verdict. */
export function classifyProbe(o: ProbeObservation, opts: ClassifyOpts = {}): ProbeResult {
  if (!o.walletSupportsStrk20) {
    return {
      verdict: "WALLET_UNSUPPORTED",
      detail:
        "the connected wallet does not report Wallet API >= 0.10.3 / the STRK20 methods; " +
        "Candidate P cannot be verified with this wallet",
    };
  }

  const prior = opts.priorStableId ?? null;
  if (prior !== null) {
    if (o.first === null || o.second === null) {
      return {
        verdict: "INCONSISTENT_ACROSS_RUNS",
        detail:
          `a prior run resolved a stable id ${idHex(prior)} but this run's prepare returned none. ` +
          "This is a transient wallet/backend state, NOT a Candidate P property. " +
          "Re-run the no-transaction capture; do not spend on a deposit yet.",
      };
    }
    if (o.first === o.second && o.first !== prior && o.afterInterveningNote === null) {
      return {
        verdict: "INCONSISTENT_ACROSS_RUNS",
        detail:
          `this run resolved ${idHex(o.first)} vs the prior run's ${idHex(prior)}, with no note ` +
          "created. Investigate wallet caching / channel-discovery state before proceeding.",
      };
    }
  }

  if (o.first === null || o.second === null) {
    return {
      verdict: "REJECT_NO_RESOLVED_ID",
      detail:
        "wallet_strk20PrepareInvoke did not return a resolved open-note id anywhere in the " +
        "prepared response. If this is repeatable, Candidate P cannot use this wallet as-is.",
    };
  }
  if (o.first !== o.second) {
    return {
      verdict: "REJECT_UNSTABLE",
      detail:
        "two back-to-back prepare(simulate) calls resolved DIFFERENT open-note ids with no note " +
        "created between them; the precommitted-destination flow is not safe on this wallet",
    };
  }
  if (o.afterInterveningNote === null) {
    return {
      verdict: "PARTIAL_STABLE_PENDING_SHIFT",
      detail:
        "id is stable across two prepares; run the intervening-note step to confirm the id then " +
        "shifts before declaring PASS",
    };
  }
  if (o.afterInterveningNote === o.first) {
    return {
      verdict: "INCONCLUSIVE_ID_DID_NOT_SHIFT",
      detail:
        "a real note was created in the subchannel but the resolved id did not change; the note-id " +
        "model in the research doc does not match this wallet — investigate before proceeding",
    };
  }
  return { verdict: "PASS" };
}

// ---------------------------------------------------------------------------
// Wallet-driving orchestrator (human-run only; not unit-tested against a real
// wallet).
// ---------------------------------------------------------------------------

export interface ProbeWallet {
  supportedWalletApi?: () => Promise<string[]>;
  strk20PrepareInvoke: (
    actions: STRK20_ACTION[],
    simulate?: boolean,
  ) => Promise<unknown>;
  strk20InvokeTransaction: (
    actions: STRK20_ACTION[],
  ) => Promise<{ transaction_hash: string }>;
}

export interface RunProbeArgs {
  wallet: ProbeWallet;
  token: string;
  selfAddress: string;
  probeContract: string;
  requiredWalletApiVersion: string;
  /** A resolved id a prior run confirmed. Skips re-deriving #1/#2. */
  priorStableId?: bigint | null;
  /** Step 8: create a real intervening note (deposit) and wait for discovery. */
  createInterveningNote?: () => Promise<void>;
  onStep?: (message: string) => void;
  /** ms between a failed prepare and its single retry (default 1500). */
  retryDelayMs?: number;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface PrepareOutcome {
  id: bigint | null;
  foundAt: string | null;
  inspection: PrepareInspection;
}

async function preparePlusInspect(
  wallet: ProbeWallet,
  actions: STRK20_ACTION[],
  retryDelayMs: number,
  say: (m: string) => void,
): Promise<PrepareOutcome> {
  const attempt = async (retried: boolean): Promise<PrepareOutcome> => {
    try {
      const built = await wallet.strk20PrepareInvoke(actions, true);
      const { id, foundAt } = findResolvedOpenNoteIdDeep(built);
      return { id, foundAt, inspection: inspectPrepareResponse(built, undefined, retried) };
    } catch (e) {
      return { id: null, foundAt: null, inspection: inspectPrepareResponse(undefined, e, retried) };
    }
  };
  const first = await attempt(false);
  if (first.id !== null) return first;
  say(
    `prepare returned no resolved id (${first.inspection.error ?? "shape mismatch"}); ` +
      `retrying once in ${retryDelayMs}ms`,
  );
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return attempt(true);
}

export async function runNoteIdStabilityProbe(args: RunProbeArgs): Promise<CompletedProbe> {
  const step = args.onStep ?? (() => {});
  const retryDelayMs = args.retryDelayMs ?? 1500;
  const prior = args.priorStableId ?? null;

  let versions: string[] = [];
  try {
    versions = (await args.wallet.supportedWalletApi?.()) ?? [];
  } catch {
    versions = [];
  }
  const supported =
    versions.some((v) => compareVersions(v, args.requiredWalletApiVersion) >= 0) &&
    typeof args.wallet.strk20PrepareInvoke === "function";
  if (!supported) {
    const observed: CompletedProbe["observed"] = {
      walletSupportsStrk20: false,
      first: null,
      second: null,
      afterInterveningNote: null,
      inspections: [],
    };
    return { ...classifyProbe(observed, { priorStableId: prior }), observed };
  }

  const actions = buildProbeActions({
    token: args.token,
    selfAddress: args.selfAddress,
    probeContract: args.probeContract,
  });

  const inspections: PrepareInspection[] = [];
  let first: bigint | null;
  let second: bigint | null;
  let afterInterveningNote: bigint | null = null;

  if (prior !== null && args.createInterveningNote) {
    // Trust the prior run's baseline; do only the shift test.
    step(`using prior baseline id ${idHex(prior)} for #1/#2`);
    first = prior;
    second = prior;
    step("intervening note: creating a real note in this subchannel");
    await args.createInterveningNote();
    step("prepare(simulate) #3 (after the intervening note)");
    const p3 = await preparePlusInspect(args.wallet, actions, retryDelayMs, step);
    inspections.push(p3.inspection);
    afterInterveningNote = p3.id;
    step(`#3 resolved id: ${idHex(p3.id)}${p3.foundAt ? ` at ${p3.foundAt}` : ""}`);
  } else if (prior !== null) {
    // Re-verify the baseline with one prepare, no transaction.
    step(`re-verifying prior baseline id ${idHex(prior)}`);
    const rv = await preparePlusInspect(args.wallet, actions, retryDelayMs, step);
    inspections.push(rv.inspection);
    first = rv.id;
    second = rv.id;
    step(
      `re-verify resolved id: ${idHex(rv.id)}${rv.foundAt ? ` at ${rv.foundAt}` : ""}` +
        (rv.id === prior ? " (matches prior)" : " (DIFFERS from prior)"),
    );
  } else {
    step("prepare(simulate) #1");
    const p1 = await preparePlusInspect(args.wallet, actions, retryDelayMs, step);
    inspections.push(p1.inspection);
    first = p1.id;
    step(`#1 resolved id: ${idHex(p1.id)}${p1.foundAt ? ` at ${p1.foundAt}` : ""}`);

    step("prepare(simulate) #2 (no note created in between)");
    const p2 = await preparePlusInspect(args.wallet, actions, retryDelayMs, step);
    inspections.push(p2.inspection);
    second = p2.id;
    step(`#2 resolved id: ${idHex(p2.id)}${p2.foundAt ? ` at ${p2.foundAt}` : ""}`);

    if (args.createInterveningNote && first !== null && first === second) {
      step("intervening note: creating a real note in this subchannel");
      await args.createInterveningNote();
      step("prepare(simulate) #3 (after the intervening note)");
      const p3 = await preparePlusInspect(args.wallet, actions, retryDelayMs, step);
      inspections.push(p3.inspection);
      afterInterveningNote = p3.id;
      step(`#3 resolved id: ${idHex(p3.id)}${p3.foundAt ? ` at ${p3.foundAt}` : ""}`);
    }
  }

  const observed: CompletedProbe["observed"] = {
    walletSupportsStrk20: true,
    first,
    second,
    afterInterveningNote,
    inspections,
  };
  return { ...classifyProbe(observed, { priorStableId: prior }), observed };
}

/** One prepare(simulate) + a safe structural fingerprint. No verdict, no tx. */
export async function captureShape(
  wallet: ProbeWallet,
  args: { token: string; selfAddress: string; probeContract: string },
): Promise<{ id: bigint | null; foundAt: string | null; inspection: PrepareInspection }> {
  const actions = buildProbeActions(args);
  return preparePlusInspect(wallet, actions, 0, () => {});
}

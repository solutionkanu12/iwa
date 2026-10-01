import { CairoOption, CairoOptionVariant, CallData } from "starknet";

import { PrivacyPoolABI } from "../../../../scripts/demo/vendor/starknet-privacy-sdk/dist/internal/abi.js";

const MAX_SERVER_ACTION_FELTS = 8_192;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const SERVER_ACTION_VARIANTS = [
  "WriteOnce",
  "Append",
  "TransferFrom",
  "TransferTo",
  "EmitViewingKeySet",
  "EmitWithdrawal",
  "EmitDeposit",
  "EmitOpenNoteCreated",
  "EmitEncNoteCreated",
  "EmitNoteUsed",
  "Invoke",
  "InvokeWithComputation",
] as const;

/**
 * Exact action discriminants in the vendored STRK20 v0.14.3-rc.5 ABI. An Iwa
 * intent supplies a complete ordered transcript from this closed set; it is
 * not an open-ended list supplied by a caller or inferred from calldata.
 */
export type PinnedStrk20ServerActionType = (typeof SERVER_ACTION_VARIANTS)[number];

export type PinnedStrk20PassiveServerActionType = Exclude<PinnedStrk20ServerActionType, "TransferFrom" | "TransferTo" | "Invoke" | "InvokeWithComputation">;

export type PinnedStrk20ServerAction =
  | { readonly type: PinnedStrk20PassiveServerActionType }
  | { readonly type: "TransferFrom"; readonly fromAddress: string; readonly token: string; readonly amount: string }
  | { readonly type: "TransferTo"; readonly toAddress: string; readonly token: string; readonly amount: string }
  | { readonly type: "Invoke" | "InvokeWithComputation"; readonly contractAddress: string; readonly calldata: readonly string[] };

const decoder = new CallData(PrivacyPoolABI);

function fail(): never {
  throw new Error("Iwa STRK20 pool action encoding rejected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalFelt(value: unknown, allowZero = true): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail();
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    fail();
  }
  if ((!allowZero && parsed === 0n) || parsed < 0n || parsed >= STARK_FIELD_PRIME || `0x${parsed.toString(16)}` !== value.toLowerCase()) fail();
  return `0x${parsed.toString(16)}`;
}

function encodedFelt(value: unknown, allowZero = true): string {
  if (typeof value !== "bigint" || (!allowZero && value === 0n) || value < 0n || value >= STARK_FIELD_PRIME) fail();
  return `0x${value.toString(16)}`;
}

function compilerFelt(value: unknown): string {
  if (typeof value !== "string") fail();
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    fail();
  }
  if (parsed < 0n || parsed >= STARK_FIELD_PRIME) fail();
  return `0x${parsed.toString(16)}`;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail();
}

function decodeTransfer(type: "TransferFrom" | "TransferTo", value: unknown): PinnedStrk20ServerAction {
  if (!isRecord(value)) fail();
  if (type === "TransferFrom") {
    exactKeys(value, ["from_addr", "token", "amount"]);
    return {
      type,
      fromAddress: encodedFelt(value.from_addr, false),
      token: encodedFelt(value.token, false),
      amount: encodedFelt(value.amount, false),
    };
  }
  exactKeys(value, ["to_addr", "token", "amount"]);
  return {
    type,
    toAddress: encodedFelt(value.to_addr, false),
    token: encodedFelt(value.token, false),
    amount: encodedFelt(value.amount, false),
  };
}

function decodeInvoke(type: "Invoke" | "InvokeWithComputation", value: unknown): PinnedStrk20ServerAction {
  if (!isRecord(value)) fail();
  exactKeys(value, ["contract_address", "calldata"]);
  if (!Array.isArray(value.calldata) || value.calldata.length > MAX_SERVER_ACTION_FELTS) fail();
  return {
    type,
    contractAddress: encodedFelt(value.contract_address, false),
    calldata: value.calldata.map((felt) => encodedFelt(felt)),
  };
}

function decodeAction(value: unknown): PinnedStrk20ServerAction {
  if (!isRecord(value) || !isRecord(value.variant)) fail();
  const variant = value.variant;
  exactKeys(variant, SERVER_ACTION_VARIANTS);
  const populated = SERVER_ACTION_VARIANTS.filter((name) => variant[name] !== undefined);
  if (populated.length !== 1) fail();
  const [type] = populated;
  if (type === undefined) fail();
  if (type === "TransferFrom" || type === "TransferTo") return decodeTransfer(type, variant[type]);
  if (type === "Invoke" || type === "InvokeWithComputation") return decodeInvoke(type, variant[type]);
  return { type };
}

function decodeCanonicalSpan(serialized: readonly string[]): unknown[] {
  if (serialized.length === 0 || serialized.length > MAX_SERVER_ACTION_FELTS) fail();
  const raw = serialized.map((felt) => canonicalFelt(felt));
  let decoded: unknown;
  try {
    decoded = decoder.decodeParameters("core::array::Span::<privacy::actions::ServerAction>", raw);
  } catch {
    fail();
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_SERVER_ACTION_FELTS) fail();

  // Decode alone is insufficient because a permissive ABI decoder could leave
  // a trailing field unread. Round-trip through the pinned ABI and require the
  // exact canonical span, excluding only the separately encoded screening None.
  let reencoded: readonly string[];
  try {
    reencoded = decoder.compile("apply_actions", [decoded, new CairoOption(CairoOptionVariant.None)]).slice(0, -1);
  } catch {
    fail();
  }
  if (reencoded.length !== raw.length || reencoded.some((felt, index) => compilerFelt(felt) !== raw[index])) fail();
  return decoded;
}

/**
 * Decodes the exact `Span<ServerAction>` carried in the pinned SDK proof
 * output. The ABI is the vendored v0.14.3-rc.5 artifact, not a hand-written
 * positional parser. Unknown, malformed, non-canonical, or trailing action
 * data is rejected before it can reach a Starknet account submission.
 */
export function decodePinnedStrk20ServerActions(serialized: readonly string[]): readonly PinnedStrk20ServerAction[] {
  return decodeCanonicalSpan(serialized).map(decodeAction);
}

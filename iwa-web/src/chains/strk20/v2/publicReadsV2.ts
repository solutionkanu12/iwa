// chains/strk20/v2/publicReadsV2.ts — read-only IwaCircleV2 access.
//
// View calls only. Nothing here can sign, approve, or send. Struct layouts are
// transcribed from contracts/starknet/src/iwa_types_v2.cairo; enum discriminants
// are Cairo declaration order. Nothing in this file depends on V1's
// publicReads.ts so the two version paths cannot entangle.

import { RpcProvider } from "starknet";

import { sameAddress } from "../../starknetProduction";

/** `iwa_types_v2::PayoutStatusV2`, in declaration order. */
export const PAYOUT_STATUS_V2 = [
  "Scheduled",
  "DeferredLocked",
  "PrivateSettlementAuthorized",
  "PrivatelyPaid",
  "RecoveryPending",
  "PrivatelyRecovered",
  "NoFundedRecovery",
] as const;

export type PayoutStatusV2Name = (typeof PAYOUT_STATUS_V2)[number];

const asInt = (f: string): number => Number(BigInt(f));

function variant(felt: string): PayoutStatusV2Name {
  const i = asInt(felt);
  if (i < 0 || i >= PAYOUT_STATUS_V2.length) {
    throw new Error(`unknown PayoutStatusV2 discriminant ${i}`);
  }
  return PAYOUT_STATUS_V2[i];
}

export function makeProvider(nodeUrl: string): RpcProvider {
  return new RpcProvider({ nodeUrl });
}

async function view(
  provider: RpcProvider,
  contractAddress: string,
  entrypoint: string,
  calldata: string[] = [],
): Promise<string[]> {
  return provider.callContract({ contractAddress, entrypoint, calldata }, "latest");
}

export interface PayoutStateV2View {
  circleId: number;
  round: number;
  /** The scheduled recipient's member_ref, as a 0x felt string. */
  scheduledMemberRef: string;
  /** Base units. The whole pot for the round. State-derived; never a UI input. */
  amount: bigint;
  status: PayoutStatusV2Name;
}

/** The short string `get_payout_state_v2` reverts with when no payout exists yet. */
const PAYOUT_LOCKED = "IWA: payout locked";
/** The short string the destination reads revert with when none is registered. */
const DEST_NOT_REGISTERED = "IWA2: no destination";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "";
}

export function isPayoutNotPreparedV2(e: unknown): boolean {
  return errText(e).includes(PAYOUT_LOCKED);
}

export function isDestinationNotRegistered(e: unknown): boolean {
  return errText(e).includes(DEST_NOT_REGISTERED);
}

/**
 * A round's V2 payout accounting, or null when the contract holds none yet.
 */
export async function getPayoutStateV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  round: number,
): Promise<PayoutStateV2View | null> {
  let r: string[];
  try {
    r = await view(provider, circleV2Address, "get_payout_state_v2", [
      String(circleId),
      String(round),
    ]);
  } catch (e) {
    if (isPayoutNotPreparedV2(e)) return null;
    throw e;
  }
  if (r.length < 5) throw new Error(`get_payout_state_v2 returned ${r.length} felts, expected 5`);
  return {
    circleId: asInt(r[0]),
    round: asInt(r[1]),
    scheduledMemberRef: `0x${BigInt(r[2]).toString(16)}`,
    amount: BigInt(r[3]),
    status: variant(r[4]),
  };
}

export interface RegisteredDestinationV2View {
  noteId: bigint;
  amount: bigint;
  destEpoch: bigint;
  expiry: bigint;
}

/** The registered private destination for a round, or null when none is set. */
export async function getRegisteredPayoutDestinationV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  round: number,
): Promise<RegisteredDestinationV2View | null> {
  let r: string[];
  try {
    r = await view(provider, circleV2Address, "get_registered_payout_destination", [
      String(circleId),
      String(round),
    ]);
  } catch (e) {
    if (isDestinationNotRegistered(e)) return null;
    throw e;
  }
  if (r.length < 4) {
    throw new Error(`get_registered_payout_destination returned ${r.length} felts, expected 4`);
  }
  return {
    noteId: BigInt(r[0]),
    amount: BigInt(r[1]),
    destEpoch: BigInt(r[2]),
    expiry: BigInt(r[3]),
  };
}

/** The member's current monotonic destination epoch (0 if never registered). */
export async function getDestEpoch(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  memberRef: string,
): Promise<bigint> {
  const r = await view(provider, circleV2Address, "get_dest_epoch", [String(circleId), memberRef]);
  return BigInt(r[0]);
}

export async function isDestNonceConsumed(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  memberRef: string,
  nonce: string,
): Promise<boolean> {
  const r = await view(provider, circleV2Address, "is_dest_nonce_consumed", [
    String(circleId),
    memberRef,
    nonce,
  ]);
  return asInt(r[0]) === 1;
}

/** The terminal on-chain fact: this round's pot was privately collected. */
export async function isPayoutPrivatelySettled(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  round: number,
): Promise<boolean> {
  const r = await view(provider, circleV2Address, "is_payout_privately_settled", [
    String(circleId),
    String(round),
  ]);
  return asInt(r[0]) === 1;
}

export async function getRoundUnresolvedDeficitV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  round: number,
): Promise<bigint> {
  const r = await view(provider, circleV2Address, "get_round_unresolved_deficit", [
    String(circleId),
    String(round),
  ]);
  return BigInt(r[0]);
}

export interface CircleViewV2 {
  id: number;
  asset: "Usdc" | "Strk";
  contributionAmount: bigint;
  memberLimit: number;
  currentRound: number;
  status: string;
  joinedCount: number;
}

const CIRCLE_STATUS_V2 = [
  "Created",
  "OpenForMembers",
  "Active",
  "PausedForNewActions",
  "SettlementPending",
  "Completed",
] as const;

export async function getCircleV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
): Promise<CircleViewV2> {
  const r = await view(provider, circleV2Address, "get_circle", [String(circleId)]);
  if (r.length < 12) throw new Error(`get_circle returned ${r.length} felts, expected 12`);
  const s = asInt(r[7]);
  return {
    id: asInt(r[0]),
    asset: asInt(r[1]) === 0 ? "Usdc" : "Strk",
    contributionAmount: BigInt(r[2]),
    memberLimit: asInt(r[5]),
    currentRound: asInt(r[6]),
    status: s >= 0 && s < CIRCLE_STATUS_V2.length ? CIRCLE_STATUS_V2[s] : `#${s}`,
    joinedCount: asInt(r[11]),
  };
}

export async function getPayoutOrderV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
): Promise<string[]> {
  const r = await view(provider, circleV2Address, "get_payout_order", [String(circleId)]);
  return r.slice(1, 1 + asInt(r[0])).map((f) => `0x${BigInt(f).toString(16)}`);
}

export async function isMemberV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  memberRef: string,
): Promise<boolean> {
  const r = await view(provider, circleV2Address, "is_member", [String(circleId), memberRef]);
  return asInt(r[0]) === 1;
}

export async function getMemberAuthKeyV2(
  provider: RpcProvider,
  circleV2Address: string,
  circleId: number,
  memberRef: string,
): Promise<bigint> {
  const r = await view(provider, circleV2Address, "get_member_auth_key", [
    String(circleId),
    memberRef,
  ]);
  return BigInt(r[0]);
}

/** Latest block timestamp (Unix seconds) — the clock the contract's expiry uses. */
export async function latestBlockTimestamp(provider: RpcProvider): Promise<number> {
  const b = (await provider.getBlock("latest")) as unknown as { timestamp: number };
  return b.timestamp;
}

/**
 * The scheduled recipient for a round: is the connected member the one whose
 * turn it is? Compared as felts, so `0x0abc` and `0xabc` match.
 */
export function isScheduledRecipient(
  payout: PayoutStateV2View,
  memberRef: string,
): boolean {
  return sameAddress(payout.scheduledMemberRef, memberRef);
}

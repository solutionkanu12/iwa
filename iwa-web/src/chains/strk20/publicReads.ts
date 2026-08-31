// chains/strk20/publicReads.ts — read-only chain access for the console.
//
// Everything here is a view call or a receipt fetch. Nothing in this module can
// sign, approve, or send. Struct layouts are transcribed from
// contracts/starknet/src/iwa_types.cairo at the deployed revision; enum
// discriminants are Cairo's declaration order.

import { RpcProvider, hash } from "starknet";

import { STARKNET_MAINNET, sameAddress } from "../starknetProduction";

export const CIRCLE_STATUS = [
  "Created",
  "OpenForMembers",
  "Active",
  "PausedForNewActions",
  "SettlementPending",
  "Completed",
] as const;

export const CONTRIBUTION_STATUS = [
  "Pending",
  "OnTime",
  "LateWithinGrace",
  "MissedDefault",
] as const;

export type CircleStatus = (typeof CIRCLE_STATUS)[number];
export type ContributionStatus = (typeof CONTRIBUTION_STATUS)[number];

const asInt = (f: string): number => Number(BigInt(f));
const u256 = (lo: string, hi: string): bigint => BigInt(lo) + (BigInt(hi) << 128n);

function variant<T extends readonly string[]>(table: T, felt: string, what: string): T[number] {
  const i = asInt(felt);
  if (i < 0 || i >= table.length) throw new Error(`unknown ${what} discriminant ${i}`);
  return table[i];
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

// --- ERC-20 ---

export async function erc20Balance(
  provider: RpcProvider,
  token: string,
  owner: string,
): Promise<bigint> {
  const r = await view(provider, token, "balanceOf", [owner]);
  return u256(r[0], r[1]);
}

export async function erc20Allowance(
  provider: RpcProvider,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const r = await view(provider, token, "allowance", [owner, spender]);
  return u256(r[0], r[1]);
}

// --- Pool ---

export async function poolFeeAmount(provider: RpcProvider): Promise<bigint> {
  const r = await view(provider, STARKNET_MAINNET.privacyPool, "get_fee_amount");
  return BigInt(r[0]);
}

/**
 * The pool refuses open-note credits from a blocked depositor. Read live: it is
 * an operational dependency on the pool operator, not something IWA controls.
 */
export async function helperBlocked(provider: RpcProvider): Promise<boolean> {
  const r = await view(provider, STARKNET_MAINNET.privacyPool, "is_open_note_depositor_blocked", [
    STARKNET_MAINNET.iwaHelper,
  ]);
  return asInt(r[0]) === 1;
}

/**
 * Registration status, read straight from the pool.
 *
 * An account must publish its public viewing key before it can hold or move
 * anything privately. The pool stores it per address; zero means unregistered.
 * This is the read that explains a NOT_REGISTERED rejection without guessing.
 */
export async function registeredPublicKey(
  provider: RpcProvider,
  address: string,
): Promise<bigint> {
  const r = await view(provider, STARKNET_MAINNET.privacyPool, "get_public_key", [address]);
  return BigInt(r[0]);
}

export async function isRegistered(provider: RpcProvider, address: string): Promise<boolean> {
  return (await registeredPublicKey(provider, address)) !== 0n;
}

/** Confirms the address really runs the pinned class, not merely that it exists. */
export async function classHashMatches(
  provider: RpcProvider,
  address: string,
  expectedClass: string,
): Promise<boolean> {
  try {
    const actual = await provider.getClassHashAt(address, "latest");
    return sameAddress(actual, expectedClass);
  } catch {
    return false;
  }
}

// --- IWA circle ---

export interface CircleView {
  id: number;
  asset: "Usdc" | "Strk";
  contributionAmount: bigint;
  memberLimit: number;
  currentRound: number;
  status: CircleStatus;
  organizer: string;
  joinedCount: number;
}

export async function getCircle(provider: RpcProvider, circleId: number): Promise<CircleView> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "get_circle", [String(circleId)]);
  if (r.length < 12) throw new Error(`get_circle returned ${r.length} felts, expected 12`);
  return {
    id: asInt(r[0]),
    asset: asInt(r[1]) === 0 ? "Usdc" : "Strk",
    contributionAmount: BigInt(r[2]),
    memberLimit: asInt(r[5]),
    currentRound: asInt(r[6]),
    status: variant(CIRCLE_STATUS, r[7], "CircleStatus"),
    organizer: r[9],
    joinedCount: asInt(r[11]),
  };
}

export async function getPayoutOrder(
  provider: RpcProvider,
  circleId: number,
): Promise<string[]> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "get_payout_order", [
    String(circleId),
  ]);
  return r.slice(1, 1 + asInt(r[0]));
}

export async function isMember(
  provider: RpcProvider,
  circleId: number,
  memberRef: string,
): Promise<boolean> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "is_member", [
    String(circleId),
    memberRef,
  ]);
  return asInt(r[0]) === 1;
}

export interface ObligationView {
  round: number;
  requiredAmount: bigint;
  status: ContributionStatus;
}

export async function getContributionObligation(
  provider: RpcProvider,
  circleId: number,
  round: number,
  memberRef: string,
): Promise<ObligationView> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "get_contribution_obligation", [
    String(circleId),
    String(round),
    memberRef,
  ]);
  if (r.length < 8) throw new Error(`get_contribution_obligation returned ${r.length} felts`);
  return {
    round: asInt(r[1]),
    requiredAmount: BigInt(r[4]),
    status: variant(CONTRIBUTION_STATUS, r[7], "ContributionStatus"),
  };
}

export interface RoundLiabilityView {
  settledInflows: bigint;
  settledOutflows: bigint;
  outstanding: bigint;
}

export async function getRoundLiability(
  provider: RpcProvider,
  circleId: number,
  round: number,
): Promise<RoundLiabilityView> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "get_round_liability", [
    String(circleId),
    String(round),
  ]);
  if (r.length < 9) throw new Error(`get_round_liability returned ${r.length} felts`);
  return {
    settledInflows: u256(r[3], r[4]),
    settledOutflows: u256(r[5], r[6]),
    outstanding: u256(r[7], r[8]),
  };
}

export async function isContributionNonceConsumed(
  provider: RpcProvider,
  circleId: number,
  memberRef: string,
  nonce: string,
): Promise<boolean> {
  const r = await view(provider, STARKNET_MAINNET.iwaCircle, "is_contribution_nonce_consumed", [
    String(circleId),
    memberRef,
    nonce,
  ]);
  return asInt(r[0]) === 1;
}

/** Unaccounted surplus held by the helper. Non-zero blocks exact inbound settlement. */
export async function helperSurplus(provider: RpcProvider, token: string): Promise<bigint> {
  const r = await view(provider, STARKNET_MAINNET.iwaHelper, "get_surplus", [token]);
  return u256(r[0], r[1]);
}

export async function helperTokenLiability(
  provider: RpcProvider,
  token: string,
): Promise<bigint> {
  const r = await view(provider, STARKNET_MAINNET.iwaHelper, "get_token_liability", [token]);
  return u256(r[0], r[1]);
}

// --- Transaction verification ---

export interface TxVerification {
  hash: string;
  found: boolean;
  succeeded: boolean;
  executionStatus: string;
  finalityStatus: string;
  touchesPool: boolean;
  poolEvents: number;
  helperEvents: number;
  circleEvents: number;
  blockNumber: number | null;
}

/**
 * A hash that exists is not evidence. Each transaction is checked for the four
 * properties the sprint actually requires: it succeeded, it is accepted, it
 * emitted an event from the official pool, and (for settlements) the IWA
 * circle recorded a transition in the same transaction.
 */
export async function verifyTransaction(
  provider: RpcProvider,
  hash: string,
): Promise<TxVerification> {
  const empty: TxVerification = {
    hash,
    found: false,
    succeeded: false,
    executionStatus: "",
    finalityStatus: "",
    touchesPool: false,
    poolEvents: 0,
    helperEvents: 0,
    circleEvents: 0,
    blockNumber: null,
  };

  let receipt: Record<string, unknown>;
  try {
    receipt = (await provider.getTransactionReceipt(hash)) as unknown as Record<string, unknown>;
  } catch {
    return empty;
  }

  const inner = (receipt.value ?? receipt) as Record<string, unknown>;
  const events = (inner.events ?? []) as { from_address: string }[];
  const count = (addr: string) => events.filter((e) => sameAddress(e.from_address, addr)).length;

  const executionStatus = String(inner.execution_status ?? "");
  const poolEvents = count(STARKNET_MAINNET.privacyPool);

  return {
    hash,
    found: true,
    succeeded: executionStatus === "SUCCEEDED",
    executionStatus,
    finalityStatus: String(inner.finality_status ?? ""),
    touchesPool: poolEvents > 0,
    poolEvents,
    helperEvents: count(STARKNET_MAINNET.iwaHelper),
    circleEvents: count(STARKNET_MAINNET.iwaCircle),
    blockNumber: typeof inner.block_number === "number" ? inner.block_number : null,
  };
}

export async function currentBlock(provider: RpcProvider): Promise<number> {
  return provider.getBlockNumber();
}

/**
 * Recovers the transaction hash of a contribution that settled on chain but
 * whose wallet call never returned one.
 *
 * A wallet submission can time out after the transaction has already been
 * accepted — the network took it, the client stopped waiting. The chain is the
 * record, not the client: `ContributionStateUpdated` names the circle, round,
 * and member, so the settling transaction can be identified from state alone.
 *
 * Read-only, and it can never invent a hash: it returns only what the circle
 * contract actually emitted.
 */
export async function findContributionTransaction(
  provider: RpcProvider,
  args: { circleId: number; round: number; memberRef: string; fromBlock: number; toBlock?: number },
): Promise<{ hash: string; blockNumber: number; status: ContributionStatus } | null> {
  const selector = hash.getSelectorFromName("ContributionStateUpdated");
  const toBlock = args.toBlock ?? (await provider.getBlockNumber());

  let continuationToken: string | undefined;
  do {
    const page = await provider.getEvents({
      address: STARKNET_MAINNET.iwaCircle,
      from_block: { block_number: args.fromBlock },
      to_block: { block_number: toBlock },
      // keys[0] is the event selector; keys[1] is the indexed circle_id.
      keys: [[selector]],
      chunk_size: 100,
      ...(continuationToken ? { continuation_token: continuationToken } : {}),
    });

    for (const event of page.events) {
      const circleId = Number(BigInt(event.keys[1] ?? "0x0"));
      if (event.block_number === undefined) continue;
      // data = [round, member_ref, status]
      const [round, memberRef, status] = event.data;
      if (circleId !== args.circleId) continue;
      if (Number(BigInt(round)) !== args.round) continue;
      if (!sameAddress(memberRef, args.memberRef)) continue;
      return {
        hash: event.transaction_hash,
        blockNumber: event.block_number,
        status: variant(CONTRIBUTION_STATUS, status, "ContributionStatus"),
      };
    }
    continuationToken = page.continuation_token;
  } while (continuationToken);

  return null;
}

export interface ShieldVerification extends TxVerification {
  /** The transaction emitted at least one event from the USDC contract. */
  movedUsdc: boolean;
  /** A USDC event in this transaction references the privacy pool. */
  usdcReachedPool: boolean;
  /** Every requirement met: a real, successful USDC shield into the pool. */
  isUsdcShield: boolean;
  reasons: string[];
}

/**
 * Verifies that a transaction really shielded USDC into the pool.
 *
 * Touching the pool is not enough — a registration transaction touches the
 * pool too, and accepting one as the shield would put a transaction in
 * strk20.json that moved no value. So this additionally requires the USDC
 * contract itself to have emitted an event in the same transaction, with the
 * pool named in that event.
 *
 * The pool reference is matched across the event's keys and data rather than
 * decoding a specific ERC-20 event layout, because Cairo ERC-20s differ in
 * whether `from`/`to` sit in keys or data. That is a deliberately loose read of
 * a deliberately strict question: did USDC move, in this transaction, in a way
 * that involves the pool.
 */
export async function verifyShieldTransaction(
  provider: RpcProvider,
  hash: string,
): Promise<ShieldVerification> {
  const base = await verifyTransaction(provider, hash);
  const reasons: string[] = [];

  let movedUsdc = false;
  let usdcReachedPool = false;

  if (!base.found) {
    reasons.push("transaction not found");
  } else {
    if (!base.succeeded) reasons.push(`execution status is ${base.executionStatus}`);
    if (!base.touchesPool) reasons.push("no event from the STRK20 pool");

    let receipt: Record<string, unknown> | null = null;
    try {
      receipt = (await provider.getTransactionReceipt(hash)) as unknown as Record<string, unknown>;
    } catch {
      receipt = null;
    }
    const inner = (receipt?.value ?? receipt ?? {}) as Record<string, unknown>;
    const events = (inner.events ?? []) as { from_address: string; keys?: string[]; data?: string[] }[];

    const usdcEvents = events.filter((e) => sameAddress(e.from_address, STARKNET_MAINNET.usdcToken));
    movedUsdc = usdcEvents.length > 0;
    if (!movedUsdc) {
      reasons.push("no USDC token event — this transaction moved no USDC");
    }

    usdcReachedPool = usdcEvents.some((e) =>
      [...(e.keys ?? []), ...(e.data ?? [])].some((f) =>
        sameAddress(f, STARKNET_MAINNET.privacyPool),
      ),
    );
    if (movedUsdc && !usdcReachedPool) {
      reasons.push("USDC moved but the privacy pool is not named in the transfer");
    }
  }

  const isUsdcShield =
    base.found && base.succeeded && base.touchesPool && movedUsdc && usdcReachedPool;

  return { ...base, movedUsdc, usdcReachedPool, isUsdcShield, reasons };
}

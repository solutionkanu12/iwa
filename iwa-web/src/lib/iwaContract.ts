// lib/iwaContract.ts — the single seam between the UI and Soroban.
//
// The read getters (get_circle, get_members, get_reputation) are now live:
// read-only Soroban simulations against the deployed savings contract on Stellar
// testnet, no signing and no transactions. The writes (pay_contribution,
// collect_pot) and the proof verify (verify_proof) stay mocked until later
// stages. The UI return shapes are unchanged, so screens keep rendering; where
// the real Circle struct is thinner than the UI shape (no pot, member slots, or
// streak) we compose those fields from get_members and get_reputation.

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import {
  NETWORK_PASSPHRASE,
  SAVINGS_CONTRACT_ID,
  SOROBAN_RPC_URL,
} from "./stellarConfig";
import { bytesToHex } from "./convert";
import type { Circle, CircleConfig, CircleStatus, Reputation } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fake but well-formed identifiers so UI formatting (mono, truncation) is real.
// Still used by the write/proof mocks below.
const fakeHex = (len: number): string => {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};
const fakeTxHash = () => fakeHex(64);

// --- Soroban read-only plumbing -------------------------------------------

let server: rpc.Server | null = null;
function rpcServer(): rpc.Server {
  if (!server) server = new rpc.Server(SOROBAN_RPC_URL);
  return server;
}

// Thrown when a getter reverts (for example CircleNotFound) so callers can fall
// back to an empty/zero state instead of surfacing a raw host error.
class ContractRevert extends Error {}

const u32Arg = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const bytesArg = (b: Uint8Array): xdr.ScVal =>
  nativeToScVal(Buffer.from(b), { type: "bytes" });

// Invoke a contract getter through simulation only: build the call with a
// throwaway source account (simulation needs no funded account and no
// signature), simulate, and decode the ScVal return into a native JS value.
async function simulateRead(
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const contract = new Contract(SAVINGS_CONTRACT_ID);
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await rpcServer().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractRevert(sim.error);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new ContractRevert("no return value");
  return scValToNative(retval);
}

// The Circle struct as the contract returns it (thinner than the UI shape):
// amount/frequency/round_start decode to BigInt, the unit enum status decodes
// to a single-element array like ["Open"].
interface RawCircle {
  id: number;
  amount: bigint;
  frequency: bigint;
  size: number;
  current_round: number;
  status: string[] | string;
  members: number;
  round_start: bigint;
}

interface RawReputation {
  completed_cycles: number;
  on_time_count: number;
  default_count: number;
}

function mapStatus(status: string[] | string): CircleStatus {
  const tag = Array.isArray(status) ? status[0] : status;
  if (tag === "Active") return "active";
  if (tag === "Completed") return "complete";
  return "forming"; // Open, or anything unexpected
}

// A circle that does not exist yet: a real zero state, never fake data.
function emptyCircle(circleId: number): Circle {
  return {
    id: circleId,
    amount: 0,
    frequency: 0,
    size: 0,
    current_round: 0,
    status: "forming",
    pot: 0,
    members: [],
    yourStreak: 0,
  };
}

/** Create a savings circle (still mocked; no create flow in the UI yet). */
export async function create_circle(
  _cfg: CircleConfig,
): Promise<{ circleId: string }> {
  await delay(500);
  return { circleId: "circle_" + fakeHex(8) };
}

/** Join a circle (still mocked). Returns the anonymous slot you were given. */
export async function join_circle(
  _circleId: number,
): Promise<{ ok: boolean; slot: number }> {
  await delay(500);
  return { ok: true, slot: 2 };
}

/**
 * Read the real membership commitments for a circle, in slot order, as hex
 * strings. An absent circle reads as no members rather than an error.
 */
export async function get_members(circleId: number): Promise<string[]> {
  try {
    const raw = (await simulateRead("get_members", [
      u32Arg(circleId),
    ])) as Uint8Array[];
    return raw.map(bytesToHex);
  } catch (e) {
    if (e instanceof ContractRevert) return [];
    throw e;
  }
}

/**
 * Read the current circle state and compose the UI shape from it. The contract
 * Circle has no pot, member slots, or streak, so: pot is amount * size, the
 * member slots come from get_members (filled up to how many have joined, the
 * rest empty, and yours flagged when your commitment matches a slot), and the
 * streak comes from your on-chain reputation. A missing circle returns a zero
 * state so the screen still renders.
 */
export async function get_circle(
  circleId: number,
  memberCommitment?: Uint8Array,
): Promise<Circle> {
  let raw: RawCircle;
  try {
    raw = (await simulateRead("get_circle", [u32Arg(circleId)])) as RawCircle;
  } catch (e) {
    if (e instanceof ContractRevert) return emptyCircle(circleId);
    throw e;
  }

  const amount = Number(raw.amount);
  const size = raw.size;
  const memberHex = await get_members(circleId);
  const yourHex = memberCommitment ? bytesToHex(memberCommitment) : null;

  const members = Array.from({ length: size }, (_, slot) => {
    const filled = slot < memberHex.length;
    const isYou = filled && yourHex !== null && memberHex[slot] === yourHex;
    return { slot, filled, isYou };
  });

  // Streak comes from your reputation on this circle, when we know your
  // commitment. Never blocks the circle read if it is unavailable.
  let yourStreak = 0;
  if (memberCommitment) {
    try {
      const rep = await get_reputation(circleId, memberCommitment);
      yourStreak = rep.completedCycles;
    } catch {
      yourStreak = 0;
    }
  }

  return {
    id: raw.id,
    amount,
    frequency: Number(raw.frequency),
    size,
    current_round: raw.current_round,
    status: mapStatus(raw.status),
    pot: amount * size,
    members,
    yourStreak,
  };
}

/**
 * Read the saver's own reputation for a circle, derived on chain from their
 * contribution records. Private to the saver. on_time_rate is composed here
 * (on_time_count / completed_cycles), guarding divide-by-zero. A member with no
 * record yet reads as an all-zero standing.
 */
export async function get_reputation(
  circleId: number,
  memberCommitment: Uint8Array,
): Promise<Reputation> {
  let raw: RawReputation;
  try {
    raw = (await simulateRead("get_reputation", [
      u32Arg(circleId),
      bytesArg(memberCommitment),
    ])) as RawReputation;
  } catch (e) {
    if (e instanceof ContractRevert) {
      return { completedCycles: 0, onTimeRate: 0, defaultCount: 0 };
    }
    throw e;
  }

  const completed = raw.completed_cycles ?? 0;
  const onTime = raw.on_time_count ?? 0;
  const onTimeRate = completed > 0 ? Math.round((onTime / completed) * 100) : 0;
  return {
    completedCycles: completed,
    onTimeRate,
    defaultCount: raw.default_count ?? 0,
  };
}

/** Pay this round's contribution (still mocked; write, later stage). */
export async function pay_contribution(
  _circleId: number,
  _round: number,
): Promise<{ ok: boolean; onTime: boolean; txHash: string }> {
  await delay(650);
  return { ok: true, onTime: true, txHash: fakeTxHash() };
}

/** Advance the circle to the next round (still mocked; write, later stage). */
export async function advance_round(
  _circleId: number,
): Promise<{ ok: boolean }> {
  await delay(500);
  return { ok: true };
}

/** Collect the pot (still mocked; write, later stage). */
export async function collect_pot(
  _circleId: number,
): Promise<{ ok: boolean; amount: number; txHash: string }> {
  await delay(650);
  return { ok: true, amount: 400, txHash: fakeTxHash() };
}

/** Verify a proof on Stellar. Output is valid or invalid, nothing personal. */
export async function verify_proof(
  _proof: string,
  _publicSignals: string[],
): Promise<{ verified: boolean; txHash: string; ledger: number }> {
  await delay(900);
  return {
    verified: true,
    txHash: fakeTxHash(),
    ledger: 1_200_000 + Math.floor(Math.random() * 100_000),
  };
}

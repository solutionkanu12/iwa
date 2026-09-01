// lib/iwaContract.ts — the single seam between the UI and Soroban.
//
// Everything here is real. The read getters (get_circle, get_members,
// get_reputation) are read-only Soroban simulations against the deployed
// savings contract on Stellar testnet. The writes (join_circle,
// pay_contribution, collect_pot) are real signed transactions: built, signed by
// the connected wallet, submitted, and polled to confirmation. verify_proof is
// a real simulation against the deployed verifier contract. The real Circle
// struct is thinner than the UI shape (no pot, member slots, or streak), so we
// compose those fields from get_members and get_reputation.

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
  VERIFIER_CONTRACT_ID,
} from "./stellarConfig";
import {
  bytesToHex,
  proofToSorobanBytes,
  signalsToBytes,
  type SnarkProof,
} from "./convert";
import { signTransaction } from "./wallet";
import type { Circle, CircleStatus, Reputation } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Soroban read-only plumbing -------------------------------------------

let server: rpc.Server | null = null;
function rpcServer(): rpc.Server {
  if (!server) server = new rpc.Server(SOROBAN_RPC_URL);
  return server;
}

// Thrown when a getter reverts (for example CircleNotFound) so callers can fall
// back to an empty/zero state instead of surfacing a raw host error.
class ContractRevert extends Error {}

// Thrown by a write when simulation reverts or the submit fails. It carries the
// raw host-error string (which includes the "Error(Contract, #N)" code) so the
// UI can classify it into an honest, specific message.
export class ContractCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractCallError";
  }
}

// A classified reason for a failed write, so callers can pick a clear message
// without parsing host-error strings themselves.
export type ContractErrorKind =
  | "InvalidConfig"
  | "CircleFull"
  | "AlreadyMember"
  | "AlreadyPaid"
  | "NotMember"
  | "WrongRound"
  | "NotCollector"
  | "AlreadyCollected"
  | "RoundNotFunded"
  | "TrustProofRequired"
  | "InvalidTrustProof"
  | "InsufficientBalance"
  | "Declined"
  | "Unknown";

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Classify a failed write into a specific reason. Reads the wallet rejection
 * text, then a token insufficient-balance signal, then the savings contract
 * error code from an "Error(Contract, #N)" host error. Falls back to "Unknown"
 * so the caller shows a plain retry message rather than guessing.
 */
export function classifyContractError(err: unknown): ContractErrorKind {
  const text = describeError(err).toLowerCase();
  if (/declin|reject|denied|cancel|did not consent/.test(text)) return "Declined";
  if (/insufficient|balance is not sufficient|not enough balance/.test(text)) {
    return "InsufficientBalance";
  }
  const match = text.match(/error\(contract,\s*#(\d+)\)/);
  if (match) {
    switch (match[1]) {
      case "2":
        return "InvalidConfig";
      case "3":
        return "CircleFull";
      case "4":
        return "AlreadyMember";
      case "5":
        return "NotMember";
      case "6":
        return "AlreadyPaid";
      case "7":
        return "WrongRound";
      case "8":
        return "NotCollector";
      case "9":
        return "AlreadyCollected";
      case "11":
        return "RoundNotFunded";
      case "12":
        return "TrustProofRequired";
      case "13":
        return "InvalidTrustProof";
    }
  }
  return "Unknown";
}

const u32Arg = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const u64Arg = (n: number): xdr.ScVal =>
  nativeToScVal(BigInt(n), { type: "u64" });
const i128Arg = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
const bytesArg = (b: Uint8Array): xdr.ScVal =>
  nativeToScVal(Buffer.from(b), { type: "bytes" });
const addressArg = (a: string): xdr.ScVal => nativeToScVal(a, { type: "address" });

// The contract's `Option<TrustProof>` argument: None encodes as scvVoid; Some
// encodes as the TrustProof struct's own map (Soroban Option is transparent,
// no wrapper). Field keys are the contract's struct field names.
function trustProofArg(proof: SnarkProof, publicSignals: string[]): xdr.ScVal {
  const proofEntry = new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("proof"),
    val: bytesArg(proofToSorobanBytes(proof)),
  });
  const signalsEntry = new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("public_signals"),
    val: xdr.ScVal.scvVec(
      signalsToBytes(publicSignals).map((s) => xdr.ScVal.scvBytes(Buffer.from(s))),
    ),
  });
  return xdr.ScVal.scvMap([proofEntry, signalsEntry]);
}

// Invoke a contract getter through simulation only: build the call with a
// throwaway source account (simulation needs no funded account and no
// signature), simulate, and decode the ScVal return into a native JS value.
async function simulateRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const contract = new Contract(contractId);
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

// Build, sign, submit, and confirm a contract write. The connected wallet is the
// transaction source: it signs the envelope and pays the network fee (only the
// commitment goes on chain, never an identity). Returns the confirmed tx hash
// and the decoded return value. Throws if the submit fails, the transaction
// reverts, or confirmation times out, so callers can show an honest error.
async function signAndSubmit(
  method: string,
  args: xdr.ScVal[],
  address: string,
): Promise<{ txHash: string; returnValue: unknown }> {
  const server = rpcServer();
  const account = await server.getAccount(address);
  const contract = new Contract(SAVINGS_CONTRACT_ID);
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  // Simulate first so a contract revert surfaces as a classifiable error (the
  // host-error string carries the "Error(Contract, #N)" code) rather than an
  // opaque failure, then assemble the footprint, fee, and auth from the sim.
  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractCallError(sim.error);
  }
  const prepared = rpc.assembleTransaction(built, sim).build();

  const signedXdr = await signTransaction(prepared.toXDR(), address);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

  const sent = await server.sendTransaction(signedTx);
  if (String(sent.status) === "ERROR") {
    throw new ContractCallError(`submit failed: ${JSON.stringify(sent)}`);
  }

  // Poll until the network confirms (or fails) the transaction.
  let got = await server.getTransaction(sent.hash);
  const startedAt = Date.now();
  while (String(got.status) === "NOT_FOUND") {
    if (Date.now() - startedAt > 30_000) {
      throw new ContractCallError("timed out waiting for confirmation");
    }
    await delay(1500);
    got = await server.getTransaction(sent.hash);
  }
  if (String(got.status) !== "SUCCESS") {
    throw new ContractCallError(`transaction failed: ${got.status}`);
  }

  const rv = (got as { returnValue?: xdr.ScVal }).returnValue;
  return { txHash: sent.hash, returnValue: rv ? scValToNative(rv) : undefined };
}

// The Circle struct as the contract returns it (thinner than the UI shape):
// amount/frequency/round_start decode to BigInt, the unit enum status decodes
// to a single-element array like ["Open"].
interface RawCircle {
  id: number;
  amount: bigint;
  token: string; // Soroban Address decodes to its "C..." string
  trust_required: boolean;
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
    token: "",
    trust_required: false,
    amount: 0n,
    frequency: 0,
    size: 0,
    current_round: 0,
    status: "forming",
    pot: 0n,
    members: [],
    joinedCount: 0,
    reserved: false,
    youJoined: false,
    yourStreak: 0,
  };
}

/**
 * Create a circle for real: a signed create_circle submitted to the savings
 * contract with the connected wallet as source. amount is in the token's base
 * units, frequency in seconds. Returns the new circle id (a u32) and the
 * confirmed tx hash. Throws on failure so the UI can show an honest error.
 */
export async function create_circle(
  token: string,
  amount: bigint,
  frequency: number,
  size: number,
  address: string,
): Promise<{ circleId: number; txHash: string }> {
  const { txHash, returnValue } = await signAndSubmit(
    "create_circle",
    [addressArg(token), i128Arg(amount), u64Arg(frequency), u32Arg(size)],
    address,
  );
  return { circleId: Number(returnValue ?? 0), txHash };
}

/**
 * Join a circle for real: a signed join_circle submitted to the savings
 * contract, with the connected wallet as source. Only the member commitment
 * goes on chain, never an identity. When the circle requires trust,
 * `trustProof` (the real Groth16 proof + public signals, generated exactly as
 * the My standing / prove flow does) is sent along and verified on chain by
 * the savings contract's own cross-call to the verifier; omit it for open
 * circles. Returns the assigned slot and the confirmed tx hash. Throws on
 * failure (including TrustProofRequired / InvalidTrustProof) so the UI can
 * show an honest error.
 */
export async function join_circle(
  circleId: number,
  memberCommitment: Uint8Array,
  address: string,
  trustProof?: { proof: SnarkProof; publicSignals: string[] },
): Promise<{ ok: boolean; slot: number; txHash: string }> {
  const proofArg = trustProof
    ? trustProofArg(trustProof.proof, trustProof.publicSignals)
    : xdr.ScVal.scvVoid();
  const { txHash, returnValue } = await signAndSubmit(
    "join_circle",
    [u32Arg(circleId), bytesArg(memberCommitment), proofArg],
    address,
  );
  const res = returnValue as { ok?: boolean; slot?: number } | undefined;
  return { ok: res?.ok ?? true, slot: Number(res?.slot ?? 0), txHash };
}

/**
 * Read the real membership commitments for a circle, in slot order, as hex
 * strings. An absent circle reads as no members rather than an error.
 */
export async function get_members(circleId: number): Promise<string[]> {
  try {
    const raw = (await simulateRead(SAVINGS_CONTRACT_ID, "get_members", [
      u32Arg(circleId),
    ])) as Uint8Array[];
    return raw.map(bytesToHex);
  } catch (e) {
    if (e instanceof ContractRevert) return [];
    throw e;
  }
}

// A lightweight circle summary for the discovery list (no member slots or
// streak, just what a browse row needs). amount is in the token's base units.
export interface CircleSummary {
  id: number;
  amount: number;
  token: string;
  trust_required: boolean;
  size: number;
  current_round: number;
  members: number; // how many have joined
  status: CircleStatus;
}

/**
 * Discover circles by scanning ids from 0 up. The contract has no list call, but
 * ids are assigned sequentially with no gaps, so we read get_circle per id and
 * stop at the first one that does not exist (a CircleNotFound revert). A per-id
 * read failure that is not a revert is skipped so one bad read cannot abort the
 * whole scan, and the scan is capped so it can never loop forever.
 */
export async function listCircles(max = 50): Promise<CircleSummary[]> {
  const out: CircleSummary[] = [];
  for (let id = 0; id < max; id++) {
    let raw: RawCircle;
    try {
      raw = (await simulateRead(SAVINGS_CONTRACT_ID, "get_circle", [
        u32Arg(id),
      ])) as RawCircle;
    } catch (e) {
      // A revert means this id does not exist; since ids are sequential, the
      // list ends here. Any other error is a transient read failure: skip it.
      if (e instanceof ContractRevert) break;
      console.warn(`listCircles: get_circle(${id}) failed`, e);
      continue;
    }
    out.push({
      id: raw.id,
      amount: Number(raw.amount),
      token: raw.token,
      trust_required: raw.trust_required,
      size: raw.size,
      current_round: raw.current_round,
      members: raw.members,
      status: mapStatus(raw.status),
    });
  }
  return out;
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
    raw = (await simulateRead(SAVINGS_CONTRACT_ID, "get_circle", [
      u32Arg(circleId),
    ])) as RawCircle;
  } catch (e) {
    if (e instanceof ContractRevert) return emptyCircle(circleId);
    throw e;
  }

  const amount = BigInt(raw.amount);
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
    token: raw.token,
    trust_required: raw.trust_required,
    amount,
    frequency: Number(raw.frequency),
    size,
    current_round: raw.current_round,
    status: mapStatus(raw.status),
    pot: amount * BigInt(size),
    members,
    // The Soroban circle had no separate join step: a filled seat was a member.
    joinedCount: members.filter((m) => m.filled).length,
    reserved: members.some((m) => m.isYou),
    youJoined: members.some((m) => m.isYou),
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
    raw = (await simulateRead(SAVINGS_CONTRACT_ID, "get_reputation", [
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

/**
 * Has this member already contributed for the given round? Read-only. The
 * contract returns Option<Contribution>: Some -> already paid, None -> not yet.
 */
export async function has_contributed(
  circleId: number,
  round: number,
  memberCommitment: Uint8Array,
): Promise<boolean> {
  try {
    const raw = await simulateRead(SAVINGS_CONTRACT_ID, "get_contribution", [
      u32Arg(circleId),
      u32Arg(round),
      bytesArg(memberCommitment),
    ]);
    return raw != null; // None decodes to null; Some decodes to the record
  } catch (e) {
    if (e instanceof ContractRevert) return false;
    throw e;
  }
}

/**
 * Pay this round's contribution for real: a signed pay_contribution submitted to
 * the savings contract with the connected wallet as `from`. The wallet signs
 * once, which both authorizes the contract call and the token transfer (native
 * XLM) of circle.amount from the wallet into the contract, and pays the network
 * fee. Only the member commitment identifies the payer on chain. Returns whether
 * it was on time and the confirmed tx hash. Throws on failure (for example
 * insufficient balance or declined authorization) so the UI can show an honest
 * error instead of a fake success.
 */
export async function pay_contribution(
  circleId: number,
  round: number,
  memberCommitment: Uint8Array,
  address: string,
): Promise<{ ok: boolean; onTime: boolean; txHash: string }> {
  const { txHash, returnValue } = await signAndSubmit(
    "pay_contribution",
    [u32Arg(circleId), u32Arg(round), bytesArg(memberCommitment), addressArg(address)],
    address,
  );
  const res = returnValue as { ok?: boolean; on_time?: boolean } | undefined;
  return { ok: res?.ok ?? true, onTime: res?.on_time ?? true, txHash };
}

/**
 * Collect the pot for real: a signed collect_pot submitted to the savings
 * contract with the connected wallet as the `to` payout address. The contract
 * pays out amount * size of the circle's token (native XLM) to `to`, but only
 * when every member has funded the round (else it reverts with RoundNotFunded)
 * and this member is the round's collector and has not already collected. Only
 * the member commitment identifies the collector on chain. Returns the payout
 * amount (base units) and the confirmed tx hash. Throws on failure so the UI can
 * show an honest error; success means the pot actually moved to the collector.
 */
export async function collect_pot(
  circleId: number,
  memberCommitment: Uint8Array,
  address: string,
): Promise<{ ok: boolean; amount: number; txHash: string }> {
  const { txHash, returnValue } = await signAndSubmit(
    "collect_pot",
    [u32Arg(circleId), bytesArg(memberCommitment), addressArg(address)],
    address,
  );
  const res = returnValue as { ok?: boolean; amount?: bigint | number } | undefined;
  return { ok: res?.ok ?? true, amount: Number(res?.amount ?? 0), txHash };
}

/**
 * Verify a proof on Stellar. Real, read-only: convert the snarkjs proof and
 * public signals to the verifier's Soroban byte layout (via convert.ts), then
 * simulate VerifierContract.verify_proof against the deployed verifier. The
 * verifier is a pure pairing check, so simulation returns the real bool without
 * signing or submitting a transaction. The reference returned is the verifier
 * contract the proof was checked against. Output is valid or invalid, nothing
 * personal. Returns verified: false (never throws) so the UI can show an honest
 * failure state.
 */
export async function verify_proof(
  proof: SnarkProof,
  publicSignals: string[],
): Promise<{ verified: boolean; reference: string }> {
  const proofArg = nativeToScVal(Buffer.from(proofToSorobanBytes(proof)), {
    type: "bytes",
  });
  const signalsArg = xdr.ScVal.scvVec(
    signalsToBytes(publicSignals).map((s) =>
      xdr.ScVal.scvBytes(Buffer.from(s)),
    ),
  );

  let verified = false;
  try {
    verified = (await simulateRead(VERIFIER_CONTRACT_ID, "verify_proof", [
      proofArg,
      signalsArg,
    ])) as boolean;
  } catch (e) {
    console.warn("verify_proof simulation failed", e);
    verified = false;
  }

  return { verified, reference: VERIFIER_CONTRACT_ID };
}

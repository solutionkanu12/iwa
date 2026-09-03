// lib/iwaStarknet.ts — the single seam between the UI and Starknet.
//
// Drop-in replacement for the Soroban seam (lib/iwaContract.ts): identical
// exported names and signatures, so the circle screens keep working unchanged.
// Everything here is real — read-only view calls against the deployed IwaCircle
// on Starknet mainnet, and contributions settled privately through the STRK20
// pool via the user's wallet.
//
// Money never moves through this module. A contribution is a wallet action:
// the wallet holds the viewing key, discovers the notes, generates the proof
// and submits. This module describes what should happen and signs the IWA
// settlement authorization with the member's own key.

import type { SnarkProof } from "./convert";
import type { Circle, CircleStatus } from "./types";
import type { Standing } from "./standing";
import type { ObligationFacts } from "./roundState";
import {
  DEMO_CIRCLE_ID,
  IWA_CIRCLE,
  IWA_HELPER,
  PRIVACY_POOL,
  RPC_URL,

  USDC_TOKEN,
} from "./starknetConfig";
import { bytes32ToFelt, currentWallet, deriveMemberCommitment } from "./starknetWallet";
import {
  getCircle as readCircle,
  getContributionObligation,
  getPayoutOrder,
  helperSurplus,
  isContributionNonceConsumed,
  isMember as readIsMember,
  makeProvider,
} from "../chains/strk20/publicReads";
import { memberSlots, potFor } from "../chains/strk20/circleState";
import { standingFrom, type ObligationOutcome } from "./standing";
import { buildContributionActions } from "../chains/strk20/strk20Actions";
import { submit as submitPoolTx, toStrk20Error } from "../chains/strk20/iwaStrk20Client";
import {
  contributionNonce,
  contributionSettlementHash,
  feltHex,
  signChecked,
} from "../chains/strk20/iwaSigning";
import { CREDENTIAL_VERIFICATION, POT_COLLECTION } from "./features";
import { hash as snhash } from "starknet";

const provider = makeProvider(RPC_URL);

export class ContractCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractCallError";
  }
}

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
 * Classify a failure into a reason the UI can phrase humanly. Reads the wallet
 * rejection first, then the STRK20 error names, then the IWA contract's own
 * short-string errors.
 */
export function classifyContractError(err: unknown): ContractErrorKind {
  const text = describeError(err).toLowerCase();
  if (/declin|reject|denied|cancel|user_refused|did not consent/.test(text)) return "Declined";
  if (/insufficient_private_balance|insufficient|not enough/.test(text)) {
    return "InsufficientBalance";
  }
  if (/already.*contribut|nonce_used|contribution_nonce/.test(text)) return "AlreadyPaid";
  if (/not_member|wrong_member|no obligation/.test(text)) return "NotMember";
  if (/already_member/.test(text)) return "AlreadyMember";
  if (/join_closed|circle full|member_limit/.test(text)) return "CircleFull";
  if (/wrong_round|wrong_state|not pending/.test(text)) return "WrongRound";
  if (/invalid_config|invalid_auth_key/.test(text)) return "InvalidConfig";
  if (/not_registered/.test(text)) return "InsufficientBalance";
  return "Unknown";
}

// --- Reads ---



function mapStatus(status: string, joined: number, limit: number): CircleStatus {
  if (status === "Active") return "active";
  if (status === "Completed" || status === "SettlementPending") return "complete";
  return joined >= limit ? "active" : "forming";
}

/**
 * The circle as the UI models it. Membership stays anonymous: slots are
 * positions in the locked payout order, and only the connected member's own
 * slot is ever marked.
 */
export async function get_circle(
  circleId: number,
  memberCommitment?: Uint8Array,
): Promise<Circle> {
  let view;
  try {
    view = await readCircle(provider, circleId);
  } catch (e) {
    throw new ContractCallError(`This circle could not be loaded. ${describeError(e)}`);
  }

  const order = await getPayoutOrder(provider, circleId);
  const mine = memberCommitment ? bytes32ToFelt(memberCommitment) : null;

  const members = memberSlots(order, mine);
  const reserved = members.some((m) => m.isYou);

  // A reserved place is not a membership: the payout order is written in full
  // at creation, so the contract is the only thing that can say whether this
  // wallet has actually joined.
  let youJoined = false;
  if (mine !== null && reserved) {
    try {
      youJoined = await readIsMember(provider, circleId, feltHex(mine));
    } catch {
      // Unreadable membership stays false: the join attempt itself is
      // authoritative, and offering it again is safe.
      youJoined = false;
    }
  }

  // Base units, unconverted. formatAmount does the one conversion, at display.
  const amount = view.contributionAmount;

  return {
    id: view.id,
    token: USDC_TOKEN,
    trust_required: false,
    amount,
    frequency: view.cadenceSeconds,
    size: view.memberLimit,
    current_round: view.currentRound,
    status: mapStatus(view.status, view.joinedCount, view.memberLimit),
    pot: potFor(amount, view.memberLimit),
    members,
    joinedCount: view.joinedCount,
    reserved,
    youJoined,
    yourStreak: 0,
  };
}

/**
 * This member's obligation for one round, with the deadlines the contract set.
 *
 * Returns null when there is no obligation, which is the ordinary state of a
 * round that has not begun. An absent obligation is not a debt, so it must not
 * be reported as one.
 */
export async function get_round_obligation(
  circleId: number,
  round: number,
  memberCommitment: Uint8Array,
): Promise<ObligationFacts | null> {
  const ref = feltHex(bytes32ToFelt(memberCommitment));
  try {
    const o = await getContributionObligation(provider, circleId, round, ref);
    return {
      status: o.status as ObligationFacts["status"],
      requiredAmount: o.requiredAmount,
      dueAt: o.dueAt,
      graceEndsAt: o.graceEndsAt,
    };
  } catch {
    // No obligation for this round yet.
    return null;
  }
}

/** When the circle was created on chain, in unix seconds, or null if unreadable. */
export async function get_circle_created_at(circleId: number): Promise<number | null> {
  try {
    return (await readCircle(provider, circleId)).createdAt;
  } catch {
    return null;
  }
}

export async function get_members(circleId: number): Promise<string[]> {
  try {
    return await getPayoutOrder(provider, circleId);
  } catch {
    return [];
  }
}

export interface CircleSummary {
  id: number;
  /** Contribution per round in BASE UNITS. */
  amount: bigint;
  token: string;
  trust_required: boolean;
  size: number;
  current_round: number;
  members: number;
  status: CircleStatus;
}

/**
 * Circles the app offers. IwaCircle assigns ids sequentially from 1 and has no
 * list call, so ids are read upward until one does not exist.
 */
export async function listCircles(max = 20): Promise<CircleSummary[]> {
  const out: CircleSummary[] = [];
  for (let id = 1; id <= max; id += 1) {
    let view;
    try {
      view = await readCircle(provider, id);
    } catch {
      break; // first missing id ends the sequence
    }
    out.push({
      id: view.id,
      amount: view.contributionAmount,
      token: USDC_TOKEN,
      trust_required: false,
      size: view.memberLimit,
      current_round: view.currentRound,
      members: view.joinedCount,
      status: mapStatus(view.status, view.joinedCount, view.memberLimit),
    });
  }
  return out;
}

export async function has_contributed(
  circleId: number,
  round: number,
  memberCommitment: Uint8Array,
): Promise<boolean> {
  const ref = feltHex(bytes32ToFelt(memberCommitment));
  try {
    const obligation = await getContributionObligation(provider, circleId, round, ref);
    return obligation.status === "OnTime" || obligation.status === "LateWithinGrace";
  } catch {
    // No obligation yet (the circle has not activated) means nothing is due.
    return false;
  }
}

/**
 * The member's own record in one circle, counted from the obligations the
 * contract holds. Private to them, and shown to nobody else.
 */
export async function get_reputation(
  circleId: number,
  memberCommitment: Uint8Array,
): Promise<Standing> {
  const ref = feltHex(bytes32ToFelt(memberCommitment));
  const outcomes: ObligationOutcome[] = [];

  const view = await readCircle(provider, circleId);
  for (let round = 1; round <= view.currentRound; round += 1) {
    try {
      const o = await getContributionObligation(provider, circleId, round, ref);
      outcomes.push(o.status as ObligationOutcome);
    } catch {
      // No obligation for this round. An absent round is not an outcome, and
      // counting it as one would invent a record.
    }
  }

  return standingFrom(outcomes);
}

export async function is_member(circleId: number, memberCommitment: Uint8Array): Promise<boolean> {
  try {
    return await readIsMember(provider, circleId, feltHex(bytes32ToFelt(memberCommitment)));
  } catch {
    return false;
  }
}

// --- Writes ---

/**
 * Joins a circle the organizer already reserved a place in.
 *
 * IwaCircle is invite-bound: the organizer commits each member's
 * `poseidon([tag, invite_secret, auth_public_key])` when creating the circle,
 * so joining only succeeds if this wallet's derived identity matches a
 * reserved slot. That is what keeps a leaked invite secret useless on its own.
 */
export async function join_circle(
  circleId: number,
  _memberCommitment: Uint8Array,
  address: string,
  _trustProof?: { proof: SnarkProof; publicSignals: string[] },
): Promise<{ ok: boolean; slot: number; txHash: string }> {
  const wallet = currentWallet();
  if (wallet === null) throw new ContractCallError("Connect your wallet first.");

  const commitment = await deriveMemberCommitment(address);
  const order = await getPayoutOrder(provider, circleId);
  const slot = order.findIndex((ref) => {
    try {
      return BigInt(ref) === commitment.commitment;
    } catch {
      return false;
    }
  });
  if (slot < 0) {
    throw new ContractCallError(
      "This circle has no place reserved for you. Ask the organizer for an invite.",
    );
  }

  try {
    const res = await wallet.account.execute({
      contractAddress: IWA_CIRCLE,
      entrypoint: "join_circle",
      calldata: [
        String(circleId),
        feltHex(commitment.identity.inviteSecret),
        feltHex(commitment.identity.authPublicKeyX),
      ],
    });
    await provider.waitForTransaction(res.transaction_hash);
    return { ok: true, slot, txHash: res.transaction_hash };
  } catch (e) {
    throw new ContractCallError(describeError(e));
  }
}

/**
 * Contributes privately: one STRK20 transaction that withdraws the exact
 * obligation from the member's shielded balance to the IWA helper and invokes
 * it, atomically.
 *
 * The settlement signature is produced with the member's own key and checked
 * against the contract's acceptance predicate before it is put in the
 * transaction, so a signature the chain would reject never reaches the wallet.
 */
export async function pay_contribution(
  circleId: number,
  round: number,
  memberCommitment: Uint8Array,
  address: string,
): Promise<{ ok: boolean; onTime: boolean; txHash: string }> {
  const wallet = currentWallet();
  if (wallet === null) throw new ContractCallError("Connect your wallet first.");

  const commitment = await deriveMemberCommitment(address);
  const ref = feltHex(bytes32ToFelt(memberCommitment));

  const obligation = await getContributionObligation(provider, circleId, round, ref);
  if (obligation.status !== "Pending") {
    throw new ContractCallError(
      obligation.status === "OnTime" || obligation.status === "LateWithinGrace"
        ? "You have already contributed this round."
        : `This contribution can no longer be made (${obligation.status}).`,
    );
  }

  // One value for this round: the precheck below, the signed hash and the
  // calldata all read it, so they cannot drift apart.
  const nonce = contributionNonce(round);

  if (await isContributionNonceConsumed(provider, circleId, ref, nonce)) {
    throw new ContractCallError("You have already contributed this round.");
  }

  // A stray transfer to the helper breaks its exact inbound accounting, and the
  // settlement would revert. Surface it before the user is asked to sign.
  const surplus = await helperSurplus(provider, USDC_TOKEN);
  if (surplus !== 0n) {
    throw new ContractCallError(
      "Contributions are paused while an unexpected balance on the settlement helper is cleared.",
    );
  }

  const messageHash = contributionSettlementHash({
    circleId,
    round,
    memberRef: commitment.commitment,
    helper: BigInt(IWA_HELPER),
    pool: BigInt(PRIVACY_POOL),
    token: BigInt(USDC_TOKEN),
    amount: obligation.requiredAmount,
    nonce,
  });
  const raw = signChecked(commitment.identity, messageHash, "contribution settlement");

  const actions = buildContributionActions({
    circleId,
    round,
    memberRef: ref,
    token: USDC_TOKEN,
    amount: obligation.requiredAmount.toString(),
    nonce,
    signature: { r: feltHex(raw.r), s: feltHex(raw.s) },
  });

  try {
    const { transactionHash } = await submitPoolTx(wallet, actions);
    // The wallet can time out after the network accepted the transaction, so
    // the settled state — not the client — is the source of truth.
    const after = await getContributionObligation(provider, circleId, round, ref);
    return {
      ok: after.status !== "Pending",
      onTime: after.status === "OnTime",
      txHash: transactionHash,
    };
  } catch (e) {
    throw new ContractCallError(toStrk20Error(e).message);
  }
}

// --- Not available on Starknet yet ---

/**
 * Creates the circle on chain from a completed draft.
 *
 * IwaCircle is invite-bound: create_circle takes the locked payout order, and
 * every entry is a member commitment that depends on that member own
 * settlement key. So the order must be final and fully accepted before this
 * runs — which is exactly what the draft coordination produces.
 *
 * The new circle id is recovered from the CircleCreated event in the receipt,
 * so nobody has to read an id off a block explorer.
 */
export async function create_circle_from_order(
  payoutOrder: string[],
  contributionAmountBaseUnits: string,
  cadenceSeconds: number,
  graceSeconds: number,
): Promise<{ circleId: number; txHash: string }> {
  const wallet = currentWallet();
  if (wallet === null) throw new ContractCallError("Connect your wallet first.");
  if (payoutOrder.length < 2) {
    throw new ContractCallError("A circle needs at least two members.");
  }
  const unique = new Set(payoutOrder.map((r) => BigInt(r).toString()));
  if (unique.size !== payoutOrder.length) {
    throw new ContractCallError("Each member can hold only one place in a circle.");
  }

  let res;
  try {
    res = await wallet.account.execute({
      contractAddress: IWA_CIRCLE,
      entrypoint: "create_circle",
      calldata: [
        USDC_TOKEN,
        contributionAmountBaseUnits,
        String(cadenceSeconds),
        String(graceSeconds),
        String(payoutOrder.length),
        String(payoutOrder.length),
        ...payoutOrder.map((r) => feltHex(BigInt(r))),
      ],
    });
  } catch (e) {
    throw new ContractCallError(describeError(e));
  }

  const receipt = await provider.waitForTransaction(res.transaction_hash);
  const circleId = circleIdFromReceipt(receipt);
  if (circleId === null) {
    throw new ContractCallError(
      "The circle was created but its id could not be read back. Refresh in a moment.",
    );
  }
  return { circleId, txHash: res.transaction_hash };
}

/**
 * Reads the new circle id out of the CircleCreated event. The id is the first
 * indexed key after the event selector.
 */
export function circleIdFromReceipt(receipt: unknown): number | null {
  const inner = (receipt as { value?: unknown }).value ?? receipt;
  const events = ((inner as { events?: { from_address: string; keys: string[] }[] }).events ?? []);
  const selector = feltHex(BigInt(snhash.getSelectorFromName("CircleCreated")));
  for (const e of events) {
    try {
      if (BigInt(e.from_address) !== BigInt(IWA_CIRCLE)) continue;
      if (BigInt(e.keys[0]) !== BigInt(selector)) continue;
      return Number(BigInt(e.keys[1]));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Kept for the legacy call shape. Circle creation now goes through the draft
 * flow, which is the only way to obtain a valid payout order.
 */
export async function create_circle(
  _token: string,
  _amount: bigint,
  _frequency: number,
  _size: number,
  _address: string,
): Promise<{ circleId: number; txHash: string }> {
  throw new ContractCallError(
    "Start a circle from the invite flow so every member can reserve their place first.",
  );
}

/**
 * Collecting the pot is not wired yet.
 *
 * Payout settlement binds the open note the pool creates, and the note id only
 * exists once the wallet has assembled the transaction — so the authorizing
 * signature cannot be produced in advance through the Wallet API. Left
 * deliberately unavailable rather than half-working.
 */
export async function collect_pot(
  _circleId: number,
  _memberCommitment: Uint8Array,
  _address: string,
): Promise<{ ok: boolean; amount: number; txHash: string }> {
  throw new ContractCallError(POT_COLLECTION.reason);
}

/**
 * On-chain credential verification has no Starknet verifier deployed. Proofs
 * are still generated and checked locally; nothing is claimed on chain.
 */
export async function verify_proof(
  _proof: SnarkProof,
  _publicSignals: string[],
): Promise<{ verified: boolean; reference: string }> {
  throw new ContractCallError(CREDENTIAL_VERIFICATION.reason);
}

export { DEMO_CIRCLE_ID };

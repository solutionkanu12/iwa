// chains/strk20/v2/privatePotCollection.ts — the browser flow for the scheduled
// member to privately collect their round's pot (Candidate P).
//
// This is a pure state machine over injected dependencies: every chain read,
// every wallet call, and the clock and nonce source are parameters, so the
// whole flow is unit-testable without a browser or a wallet. The dev screen
// (DevV2PotCollectionView) supplies the real wallet, RPC provider, and
// deployment addresses.
//
// Invariants enforced here (the contract enforces them again — this layer just
// fails earlier and more legibly):
//   * the connected member must BE the scheduled recipient (state, not input);
//   * the amount comes ONLY from get_payout_state_v2 — there is no amount
//     parameter on any exported function;
//   * the registered note id is the wallet's resolved ${openNoteIds[0]}, and
//     settlement re-checks it is unchanged — an arbitrary note id is never
//     accepted;
//   * "paid" is emitted ONLY after a fresh read shows status PrivatelyPaid AND
//     is_payout_privately_settled == true — never from a transaction receipt
//     alone;
//   * every failure path re-reads contract state and reports whether a retry is
//     still possible (it is, unless the pot is already PrivatelyPaid).
//
// There is NO public-ERC20 fallback anywhere in this module.

import type { STRK20_ACTION } from "@starknet-io/types-js";
import { RpcProvider } from "starknet";

import { assertActionsWellFormed } from "../strk20Actions";
import { feltHex, type MemberIdentity } from "../iwaSigning";
import { signPayoutDestinationV2 } from "./iwaSigningV2";
import {
  buildPayoutSettlementActionsV2,
  buildRegisterPayoutDestinationCall,
  extractResolvedOpenNoteId,
  V2_SETTLE_PAYOUT,
  type StarknetCall,
} from "./payoutActionsV2";
import {
  getDestEpoch,
  getPayoutStateV2,
  getRegisteredPayoutDestinationV2,
  getRoundUnresolvedDeficitV2,
  isPayoutPrivatelySettled,
  isScheduledRecipient,
  latestBlockTimestamp,
  type PayoutStateV2View,
} from "./publicReadsV2";

export type PotCollectionPhase =
  | "checking-state"
  | "already-collected"
  | "not-your-turn"
  | "not-collectable"
  | "preparing-note-id"
  | "awaiting-registration-signature"
  | "registering"
  | "registered"
  | "assembling-settlement"
  | "awaiting-settlement-approval"
  | "settling"
  | "confirming"
  | "paid"
  | "failed";

export const TERMINAL_PHASES: readonly PotCollectionPhase[] = [
  "already-collected",
  "not-your-turn",
  "not-collectable",
  "paid",
  "failed",
];

export interface PotCollectionState {
  phase: PotCollectionPhase;
  detail?: string;
  noteId?: bigint;
  amount?: bigint;
  destEpoch?: bigint;
  registrationTxHash?: string;
  settlementTxHash?: string;
  /**
   * On a `failed` phase: true when the on-chain payout state still permits
   * another attempt (it always does unless the pot is already PrivatelyPaid).
   */
  retryable?: boolean;
  chainStatus?: PayoutStateV2View["status"] | null;
}

export interface WalletBridge {
  strk20PrepareInvoke: (actions: STRK20_ACTION[], simulate: boolean) => Promise<unknown>;
  strk20InvokeTransaction: (actions: STRK20_ACTION[]) => Promise<{ transaction_hash: string }>;
  /** Plain Starknet execute — for register_payout_destination only. */
  execute: (calls: StarknetCall[]) => Promise<{ transaction_hash: string }>;
  /** Resolves when the tx is accepted; rejects if it reverted. */
  waitForTransaction: (hash: string) => Promise<void>;
}

export interface PotCollectionDeps {
  provider: RpcProvider;
  circleV2Address: string;
  helperV2Address: string;
  poolAddress: string;
  circleId: number;
  round: number;
  /** The circle's settlement token. */
  token: string;
  /** The connected member's identity. The private key never leaves it. */
  identity: MemberIdentity;
  /** The member's wallet address — the open-note recipient. */
  selfAddress: string;
  wallet: WalletBridge;
  onState?: (s: PotCollectionState) => void;
  /** Seconds added to the current block timestamp for the registration expiry. */
  expiryWindowSeconds?: number;
  /** Clock-skew slack (seconds) when reusing an existing registration. */
  expirySkewSeconds?: number;
  /** Test seam: a deterministic single-use nonce. */
  nonce?: () => bigint;
}

const DEFAULT_EXPIRY_WINDOW = 3600;
const DEFAULT_EXPIRY_SKEW = 120;

function randomFelt(): bigint {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(31); // < 2^248, safely inside the Stark field
    g.crypto.getRandomValues(bytes);
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    return acc === 0n ? 1n : acc;
  }
  // Non-crypto fallback for non-browser contexts; tests inject `nonce`.
  return BigInt(Date.now()) * 1_000_003n + BigInt(Math.floor(Math.random() * 1_000_003));
}

/**
 * Runs the full collection flow and returns the terminal state. Progress is also
 * streamed through `deps.onState`. Never throws for an expected failure — every
 * one is reported as a `PotCollectionState` with `phase: "failed"` (or a
 * refusal phase) and a `retryable` flag.
 */
export async function collectPrivatePot(deps: PotCollectionDeps): Promise<PotCollectionState> {
  const emit = (s: PotCollectionState): PotCollectionState => {
    deps.onState?.(s);
    return s;
  };

  const memberRefHex = feltHex(deps.identity.memberRef);

  const settlementActions = (): STRK20_ACTION[] => {
    const actions = buildPayoutSettlementActionsV2({
      helperV2Address: deps.helperV2Address,
      circleId: deps.circleId,
      round: deps.round,
      memberRef: deps.identity.memberRef,
      token: deps.token,
      selfAddress: deps.selfAddress,
    });
    assertActionsWellFormed(actions);
    return actions;
  };

  const anchors = {
    operation: V2_SETTLE_PAYOUT,
    circleId: deps.circleId,
    round: deps.round,
    memberRef: deps.identity.memberRef,
    token: deps.token,
  } as const;

  const prepareResolvedNoteId = async (): Promise<bigint | null> => {
    const built = await deps.wallet.strk20PrepareInvoke(settlementActions(), true);
    return extractResolvedOpenNoteId(built, anchors);
  };

  const readPayoutStatus = async (): Promise<PayoutStateV2View | null> =>
    getPayoutStateV2(deps.provider, deps.circleV2Address, deps.circleId, deps.round);

  const failed = async (detail: string): Promise<PotCollectionState> => {
    let chainStatus: PayoutStateV2View["status"] | null = null;
    let retryable = true;
    try {
      const p = await readPayoutStatus();
      chainStatus = p?.status ?? null;
      const settled = await isPayoutPrivatelySettled(
        deps.provider,
        deps.circleV2Address,
        deps.circleId,
        deps.round,
      );
      retryable = !(p?.status === "PrivatelyPaid" || settled);
    } catch {
      // If we cannot re-read state, be conservative: still retryable, but say so.
      retryable = true;
    }
    return emit({ phase: "failed", detail, retryable, chainStatus });
  };

  // 1. Is there a payout to collect, and is it ours, and can it be collected?
  emit({ phase: "checking-state" });
  let payout: PayoutStateV2View | null;
  try {
    payout = await readPayoutStatus();
  } catch (e) {
    return failed(`could not read the round's payout state: ${describe(e)}`);
  }
  if (payout === null) {
    return emit({
      phase: "not-collectable",
      detail: "this round's payout accounting has not been prepared on chain yet",
    });
  }

  const alreadySettled = await safe(() =>
    isPayoutPrivatelySettled(deps.provider, deps.circleV2Address, deps.circleId, deps.round),
  );
  if (payout.status === "PrivatelyPaid" || alreadySettled === true) {
    return emit({
      phase: "already-collected",
      detail: "this round's pot has already been privately collected on chain",
      amount: payout.amount,
      chainStatus: payout.status,
    });
  }

  if (!isScheduledRecipient(payout, memberRefHex)) {
    return emit({
      phase: "not-your-turn",
      detail: "the connected member is not the scheduled recipient for this round",
    });
  }

  if (payout.status === "DeferredLocked") {
    const deficit = await safe(() =>
      getRoundUnresolvedDeficitV2(deps.provider, deps.circleV2Address, deps.circleId, deps.round),
    );
    if (deficit === undefined) {
      return failed("could not read the round's unresolved deficit");
    }
    if (deficit > 0n) {
      return emit({
        phase: "not-collectable",
        detail:
          "this round has an unresolved contribution deficit; the pot cannot be collected " +
          "until it is cured",
        chainStatus: payout.status,
      });
    }
  } else if (
    payout.status === "RecoveryPending" ||
    payout.status === "PrivatelyRecovered" ||
    payout.status === "NoFundedRecovery"
  ) {
    return emit({
      phase: "not-collectable",
      detail: `this round is on the recovery path (${payout.status}), not the payout path`,
      chainStatus: payout.status,
    });
  } else if (payout.status !== "Scheduled" && payout.status !== "PrivateSettlementAuthorized") {
    return emit({
      phase: "not-collectable",
      detail: `unexpected payout status ${payout.status}`,
      chainStatus: payout.status,
    });
  }

  const amount = payout.amount; // STATE-DERIVED. The only source of the amount.

  // 2. Resolve the open-note id the wallet will create.
  emit({ phase: "preparing-note-id" });
  let noteId: bigint | null;
  try {
    noteId = await prepareResolvedNoteId();
  } catch (e) {
    return failed(`wallet_strk20PrepareInvoke(simulate) rejected: ${describe(e)}`);
  }
  if (noteId === null || noteId === 0n) {
    return failed(
      "the wallet did not resolve an open-note id from prepare(simulate); nothing was sent",
    );
  }

  // 3. Do we need to (re-)register the destination?
  let blockTs: number;
  try {
    blockTs = await latestBlockTimestamp(deps.provider);
  } catch (e) {
    return failed(`could not read the chain clock: ${describe(e)}`);
  }
  const skew = BigInt(deps.expirySkewSeconds ?? DEFAULT_EXPIRY_SKEW);

  const existing = await safe(() =>
    getRegisteredPayoutDestinationV2(deps.provider, deps.circleV2Address, deps.circleId, deps.round),
  );

  const existingIsUsable =
    payout.status === "PrivateSettlementAuthorized" &&
    existing !== undefined &&
    existing !== null &&
    existing.noteId === noteId &&
    existing.amount === amount &&
    existing.expiry > BigInt(blockTs) + skew;

  if (existingIsUsable) {
    emit({
      phase: "registered",
      detail: "an existing registration for this exact note and amount is still valid",
      noteId,
      amount,
      destEpoch: existing!.destEpoch,
    });
  } else {
    const currentEpoch = await safe(() =>
      getDestEpoch(deps.provider, deps.circleV2Address, deps.circleId, memberRefHex),
    );
    if (currentEpoch === undefined) return failed("could not read the member's destination epoch");
    const destEpoch = currentEpoch + 1n;
    const expiry = BigInt(blockTs + (deps.expiryWindowSeconds ?? DEFAULT_EXPIRY_WINDOW));
    const nonce = deps.nonce ? deps.nonce() : randomFelt();

    emit({ phase: "awaiting-registration-signature", noteId, amount, destEpoch });
    let signed;
    try {
      signed = signPayoutDestinationV2(deps.identity, {
        circleContract: deps.circleV2Address,
        helper: deps.helperV2Address,
        pool: deps.poolAddress,
        token: deps.token,
        circleId: deps.circleId,
        round: deps.round,
        memberRef: deps.identity.memberRef,
        noteId,
        amount,
        destEpoch,
        expiry,
        nonce,
      });
    } catch (e) {
      return failed(`could not produce a chain-valid registration signature: ${describe(e)}`);
    }

    let regCall: StarknetCall;
    try {
      regCall = buildRegisterPayoutDestinationCall(deps.circleV2Address, {
        circleId: deps.circleId,
        round: deps.round,
        noteId,
        amount,
        destEpoch,
        expiry,
        nonce,
        signature: { r: signed.r, s: signed.s },
      });
    } catch (e) {
      return failed(`could not build the registration call: ${describe(e)}`);
    }

    emit({ phase: "registering", noteId, amount, destEpoch });
    let regHash: string;
    try {
      regHash = (await deps.wallet.execute([regCall])).transaction_hash;
    } catch (e) {
      return failed(`the registration transaction was rejected: ${describe(e)}`);
    }
    emit({ phase: "registering", noteId, amount, destEpoch, registrationTxHash: regHash });
    try {
      await deps.wallet.waitForTransaction(regHash);
    } catch (e) {
      return failed(`the registration transaction reverted (${regHash}): ${describe(e)}`);
    }

    // Confirm the chain recorded exactly what we signed.
    const after = await safe(() => readPayoutStatus());
    const reg = await safe(() =>
      getRegisteredPayoutDestinationV2(
        deps.provider,
        deps.circleV2Address,
        deps.circleId,
        deps.round,
      ),
    );
    if (
      after === undefined ||
      after === null ||
      after.status !== "PrivateSettlementAuthorized" ||
      reg === undefined ||
      reg === null ||
      reg.noteId !== noteId ||
      reg.amount !== amount
    ) {
      return failed(
        "registration did not land as expected on chain (status / note / amount mismatch)",
      );
    }
    emit({
      phase: "registered",
      detail: "private destination registered on chain",
      noteId,
      amount,
      destEpoch,
      registrationTxHash: regHash,
    });
  }

  // 4. Assemble and submit the STRK20 settlement.
  emit({ phase: "assembling-settlement", noteId, amount });
  let noteId2: bigint | null;
  try {
    noteId2 = await prepareResolvedNoteId();
  } catch (e) {
    return failed(`re-preparing the settlement rejected: ${describe(e)}`);
  }
  if (noteId2 !== noteId) {
    return failed(
      "the wallet-resolved open-note id changed after registration (a note was created in " +
        "between); re-run to re-register the new destination",
    );
  }

  emit({ phase: "awaiting-settlement-approval", noteId, amount });
  let settleHash: string;
  try {
    settleHash = (await deps.wallet.strk20InvokeTransaction(settlementActions())).transaction_hash;
  } catch (e) {
    return failed(`the settlement transaction was rejected: ${describe(e)}`);
  }
  emit({ phase: "settling", noteId, amount, settlementTxHash: settleHash });
  try {
    await deps.wallet.waitForTransaction(settleHash);
  } catch (e) {
    return failed(`the settlement transaction reverted (${settleHash}): ${describe(e)}`);
  }

  // 5. Confirm from a FRESH chain read — never from the receipt alone.
  emit({ phase: "confirming", noteId, amount, settlementTxHash: settleHash });
  const finalState = await safe(() => readPayoutStatus());
  const settledNow = await safe(() =>
    isPayoutPrivatelySettled(deps.provider, deps.circleV2Address, deps.circleId, deps.round),
  );
  if (finalState !== undefined && finalState?.status === "PrivatelyPaid" && settledNow === true) {
    return emit({
      phase: "paid",
      detail: "the pot was privately collected — confirmed on chain",
      noteId,
      amount,
      settlementTxHash: settleHash,
      chainStatus: "PrivatelyPaid",
    });
  }
  return failed(
    `the settlement transaction (${settleHash}) did not move the payout to PrivatelyPaid on chain`,
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

// Chain evidence for circle creation.
//
// The backend records which circle a draft became. That record must not rest
// on the organizer's word: an address is public, and a request body is just a
// claim. So the claim is checked against the chain, and the check is a
// comparison the chain itself can settle.
//
// THE EVIDENCE. A circle's payout order is the list of member commitments,
// written once at creation and immutable afterwards. A draft holds exactly the
// same list, built from the invitations people accepted. If the two match, in
// order, that circle is this draft's circle: the commitments are unguessable,
// each is derived from a member's own wallet signature, and a draft may not
// hold the same commitment twice. Nothing else needs to be trusted.
//
// The terms are compared too, so a circle created with different money or a
// different size is not silently accepted as this draft's.
//
// WHY DISCOVERY EXISTS. Creation is irreversible and the record of it is not
// part of the same transaction. If the browser closes between the two, the
// circle exists and nothing points to it. Because the payout order identifies
// the circle, the backend can find it again from the chain alone, with no
// stored intent and no second transaction.
//
// This module holds no keys, signs nothing, and only ever reads.

import { RpcProvider } from "starknet";

import type { CircleDraft } from "./store.js";
import { normalizeFelt, SN_MAIN } from "./validation.js";

export type VerifyOutcome =
  | { status: "verified" }
  /** The chain answered, and the answer contradicts the claim. Final. */
  | { status: "rejected"; reason: string }
  /** The chain could not be reached or did not answer. Retryable, not a verdict. */
  | { status: "unavailable" };

export type DiscoveryOutcome =
  | { status: "found"; circleId: number }
  /** The chain answered and no circle matches this draft yet. */
  | { status: "absent" }
  | { status: "unavailable" };

export interface VerifyCreatedInput {
  draft: CircleDraft;
  circleId: number;
  /** The creating transaction, when the caller still has it. */
  txHash: string | null;
}

export interface CircleVerifier {
  /** Confirms that `circleId` on chain really is the circle this draft became. */
  verifyCreated(input: VerifyCreatedInput): Promise<VerifyOutcome>;
  /** Finds the circle this draft created, if one exists. */
  findCircleForDraft(draft: CircleDraft): Promise<DiscoveryOutcome>;
}

/** The payout order a draft expects on chain: its member commitments, in order. */
export function expectedPayoutOrder(draft: CircleDraft): string[] | null {
  const refs = [...draft.slots]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((s) => s.memberRef);
  if (refs.some((r) => r === null)) return null;
  return (refs as string[]).map(normalizeFelt);
}

/** How far to look when searching for a draft's circle. Ids start at 1. */
const MAX_CIRCLE_SCAN = 500;

/**
 * A read that failed because the chain said no, as opposed to one that failed
 * because the chain was not reachable. Only the first is a verdict.
 *
 * Starknet answers a call on a missing entity with a contract revert, so a
 * revert is an answer. A transport or timeout error is not.
 */
function isChainAnswer(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /revert|entry ?point|not found|invalid|out of range|assert|failed to deserialize/i.test(
    text,
  );
}

class Unavailable extends Error {}

export class OnChainCircleVerifier implements CircleVerifier {
  constructor(
    private readonly provider: RpcProvider,
    private readonly iwaCircle: string,
    private readonly chainId: string = SN_MAIN,
  ) {}

  /** A read call. Distinguishes a refusal from an outage; never conflates them. */
  private async call(entrypoint: string, calldata: string[]): Promise<string[] | null> {
    try {
      return await this.provider.callContract(
        { contractAddress: this.iwaCircle, entrypoint, calldata },
        "latest",
      );
    } catch (e) {
      if (isChainAnswer(e)) return null;
      throw new Unavailable(entrypoint);
    }
  }

  private async payoutOrderOf(circleId: number): Promise<string[] | null> {
    const raw = await this.call("get_payout_order", [String(circleId)]);
    if (raw === null) return null;
    // An Array<felt252> returns as a length followed by that many elements.
    const length = Number(BigInt(raw[0] ?? "0x0"));
    if (!Number.isInteger(length) || length < 0 || raw.length < length + 1) return null;
    return raw.slice(1, length + 1).map(normalizeFelt);
  }

  /** Terms as the circle contract reports them, for comparison with the draft. */
  private async termsOf(
    circleId: number,
  ): Promise<{ contributionAmount: string; memberLimit: number } | null> {
    const raw = await this.call("get_circle", [String(circleId)]);
    if (raw === null || raw.length < 6) return null;
    return {
      // u128 as a decimal string: never through a float.
      contributionAmount: BigInt(raw[2]).toString(),
      memberLimit: Number(BigInt(raw[5])),
    };
  }

  private async onExpectedChain(): Promise<boolean> {
    try {
      return normalizeFelt(await this.provider.getChainId()) === normalizeFelt(this.chainId);
    } catch {
      throw new Unavailable("chainId");
    }
  }

  /**
   * Whether the transaction exists, succeeded, and touched the circle contract.
   * Supporting evidence: the payout order is what actually ties circle to
   * draft, but a hash the organizer supplies should still be real.
   */
  private async transactionTouchedCircle(txHash: string): Promise<string | null> {
    let receipt: unknown;
    try {
      receipt = await this.provider.getTransactionReceipt(txHash);
    } catch (e) {
      if (isChainAnswer(e)) return "transaction not found";
      throw new Unavailable("receipt");
    }
    const r = receipt as {
      execution_status?: string;
      events?: { from_address: string }[];
    };
    if (r.execution_status !== undefined && r.execution_status !== "SUCCEEDED") {
      return "transaction did not succeed";
    }
    const target = normalizeFelt(this.iwaCircle);
    const touched = (r.events ?? []).some((e) => {
      try {
        return normalizeFelt(e.from_address) === target;
      } catch {
        return false;
      }
    });
    return touched ? null : "transaction did not call the circle contract";
  }

  async verifyCreated({ draft, circleId, txHash }: VerifyCreatedInput): Promise<VerifyOutcome> {
    const expected = expectedPayoutOrder(draft);
    if (expected === null) {
      return { status: "rejected", reason: "the draft still has places nobody has accepted" };
    }
    if (!Number.isInteger(circleId) || circleId < 1) {
      return { status: "rejected", reason: "not a circle id" };
    }

    try {
      if (!(await this.onExpectedChain())) {
        return { status: "rejected", reason: "the provider is not on the expected network" };
      }

      const order = await this.payoutOrderOf(circleId);
      if (order === null) return { status: "rejected", reason: "no such circle" };
      if (order.length !== expected.length || order.some((ref, i) => ref !== expected[i])) {
        return { status: "rejected", reason: "the payout order does not match this draft" };
      }

      const terms = await this.termsOf(circleId);
      if (terms === null) return { status: "rejected", reason: "no such circle" };
      if (terms.contributionAmount !== draft.contributionAmount) {
        return { status: "rejected", reason: "the contribution amount does not match this draft" };
      }
      if (terms.memberLimit !== draft.memberCount) {
        return { status: "rejected", reason: "the number of places does not match this draft" };
      }

      if (txHash !== null) {
        const problem = await this.transactionTouchedCircle(txHash);
        if (problem !== null) return { status: "rejected", reason: problem };
      }

      return { status: "verified" };
    } catch (e) {
      if (e instanceof Unavailable) return { status: "unavailable" };
      throw e;
    }
  }

  /**
   * Looks for the circle this draft created. Circle ids are assigned in
   * sequence from 1, so the search walks upward and stops at the first id that
   * does not exist.
   */
  async findCircleForDraft(draft: CircleDraft): Promise<DiscoveryOutcome> {
    const expected = expectedPayoutOrder(draft);
    if (expected === null) return { status: "absent" };

    try {
      if (!(await this.onExpectedChain())) return { status: "absent" };

      for (let circleId = 1; circleId <= MAX_CIRCLE_SCAN; circleId += 1) {
        const order = await this.payoutOrderOf(circleId);
        if (order === null) break; // past the last circle
        if (order.length !== expected.length) continue;
        if (order.some((ref, i) => ref !== expected[i])) continue;

        const terms = await this.termsOf(circleId);
        if (terms === null) continue;
        if (terms.contributionAmount !== draft.contributionAmount) continue;
        if (terms.memberLimit !== draft.memberCount) continue;

        return { status: "found", circleId };
      }
      return { status: "absent" };
    } catch (e) {
      if (e instanceof Unavailable) return { status: "unavailable" };
      throw e;
    }
  }
}

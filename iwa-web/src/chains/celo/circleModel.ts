// chains/celo/circleModel.ts — the Celo execution context for the UI.
//
// Bridges IwaCircleCelo's on-chain, address-keyed state to IWA Core's
// chain-neutral domain model. A member is a wallet address on chain, but
// Core never sees an address: each slot gets a derived, opaque memberRef
// (`celo:<contract>:<slot>`), and the durable account-binding record (not
// this module) is what a signature-authenticated invite ties to a real
// wallet. This module only ever reads; it never caches a financial fact as
// truth across a reload — callers re-read after every confirmed action.

import type { Circle, ContributionObligation } from "../../core/domain/types";
import { CELO_MAINNET } from "./config";
import type {
  CeloCircleReader,
  CeloCircleStatus,
  CeloContributionStatus,
  CeloPayoutStatus,
} from "./circleReader";
import { normalizeAddress, sameAddress } from "./erc20";

export function celoCircleId(circleContract: string): string {
  return `celo:${normalizeAddress(circleContract)}`;
}

export function celoMemberRef(circleContract: string, slot: number): string {
  return `${celoCircleId(circleContract)}:${slot}`;
}

export interface CeloCircleContext {
  circleContract: string;
  circleId: string;
  chainId: number;
  asset: "cNGN";
  organizer: string;
  status: CeloCircleStatus;
  currentRound: number;
  memberCount: number;
  contributionAmount: bigint;
  cadenceSeconds: number;
  gracePeriodSeconds: number;
  dueAt: number;
  graceEndsAt: number;
  members: string[];
  scheduledMember: string;
  payoutStatus: CeloPayoutStatus;
  connectedAddress: string | null;
  isOrganizer: boolean;
  mySlot: number | null;
  myMemberRef: string | null;
  myContributionStatus: CeloContributionStatus | null;
  isScheduledRecipient: boolean;
  /**
   * Past rounds the connected member paid, that were later locked
   * (DEFERRED_LOCKED), and that this wallet has not already recovered.
   * Always empty with no connected member wallet; never includes the
   * current round, since a round is only ever locked after `_advance()`
   * has already moved past it.
   */
  recoverableRounds: number[];
}

/**
 * Scans every past round for one this member paid into but that was later
 * locked and never recovered. There is no getter for "already recovered"
 * (the contract's `_recovered` mapping is private), so this reads the
 * Recovered event log instead of guessing or requiring a transaction
 * attempt to find out (see CeloCircleReader.readRecovered).
 */
async function findRecoverableRounds(
  reader: CeloCircleReader,
  currentRound: number,
  member: string,
): Promise<number[]> {
  if (currentRound <= 1) return [];
  const pastRounds = Array.from({ length: currentRound - 1 }, (_, i) => i + 1);
  const payoutStatuses = await Promise.all(pastRounds.map((round) => reader.readPayoutStatus(round)));
  const lockedRounds = pastRounds.filter((_, i) => payoutStatuses[i] === "DEFERRED_LOCKED");
  if (lockedRounds.length === 0) return [];
  const eligible = await Promise.all(
    lockedRounds.map(async (round) => {
      const [status, recovered] = await Promise.all([
        reader.readContributionStatus(round, member),
        reader.readRecovered(round, member),
      ]);
      const paid = status === "ON_TIME" || status === "LATE_WITHIN_GRACE";
      return paid && !recovered ? round : null;
    }),
  );
  return eligible.filter((round): round is number => round !== null);
}

/** Reads every fact the Celo circle screens need, in one pass. */
export async function loadCeloCircleContext(
  reader: CeloCircleReader,
  circleContract: string,
  connectedAddress: string | null,
): Promise<CeloCircleContext> {
  const snapshot = await reader.readSnapshot();
  const [members, cadenceSeconds, gracePeriodSeconds] = await Promise.all([
    Promise.all(
      Array.from({ length: snapshot.memberCount }, (_, i) => reader.readMemberAt(i)),
    ),
    reader.readCadenceSeconds(),
    reader.readGracePeriodSeconds(),
  ]);

  const normalizedConnected = connectedAddress === null ? null : normalizeAddress(connectedAddress);
  const mySlot =
    normalizedConnected === null
      ? null
      : (() => {
          const i = members.findIndex((m) => sameAddress(m, normalizedConnected));
          return i === -1 ? null : i;
        })();
  const myMemberRef = mySlot === null ? null : celoMemberRef(circleContract, mySlot);
  const myContributionStatus =
    mySlot === null ? null : await reader.readContributionStatus(snapshot.currentRound, members[mySlot]);
  const recoverableRounds =
    mySlot === null ? [] : await findRecoverableRounds(reader, snapshot.currentRound, members[mySlot]);

  return {
    circleContract: normalizeAddress(circleContract),
    circleId: celoCircleId(circleContract),
    chainId: CELO_MAINNET.chainIdNumber,
    asset: "cNGN",
    organizer: snapshot.organizer,
    status: snapshot.status,
    currentRound: snapshot.currentRound,
    memberCount: snapshot.memberCount,
    contributionAmount: snapshot.contributionAmount,
    cadenceSeconds,
    gracePeriodSeconds,
    dueAt: snapshot.dueAt,
    graceEndsAt: snapshot.graceEndsAt,
    members,
    scheduledMember: snapshot.scheduledMember,
    payoutStatus: snapshot.payoutStatus,
    connectedAddress: normalizedConnected,
    isOrganizer: normalizedConnected !== null && sameAddress(normalizedConnected, snapshot.organizer),
    mySlot,
    myMemberRef,
    myContributionStatus,
    isScheduledRecipient:
      normalizedConnected !== null && sameAddress(normalizedConnected, snapshot.scheduledMember),
    recoverableRounds,
  };
}

/** The chain-neutral Circle for IwaSavingsAgent/CeloContributionService. */
export function celoDomainCircle(ctx: CeloCircleContext): Circle {
  return {
    id: ctx.circleId,
    asset: ctx.asset,
    contributionAmount: ctx.contributionAmount.toString(),
    cadenceSeconds: ctx.cadenceSeconds,
    gracePeriodSeconds: ctx.gracePeriodSeconds,
    memberLimit: ctx.memberCount,
    currentRound: ctx.currentRound,
    status: ctx.status === "COMPLETED" ? "COMPLETED" : "ACTIVE",
    payoutOrder: ctx.members.map((_, i) => celoMemberRef(ctx.circleContract, i)),
  };
}

/** The connected wallet's own obligation for the current round, or null if it is not a member. */
export function celoMyObligation(ctx: CeloCircleContext): ContributionObligation | null {
  if (ctx.myMemberRef === null || ctx.myContributionStatus === null) return null;
  return {
    circleId: ctx.circleId,
    round: ctx.currentRound,
    memberRef: ctx.myMemberRef,
    dueAt: ctx.dueAt,
    graceEndsAt: ctx.graceEndsAt,
    status: ctx.myContributionStatus,
  };
}

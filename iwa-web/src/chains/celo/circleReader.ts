// chains/celo/circleReader.ts — read-only IwaCircleCelo state for the UI.
//
// The contract is the authoritative source for round, contribution, and
// payout state (ARCHITECTURE.md/SECURITY.md): this module only ever reads
// view functions, never writes, and never caches a financial fact as truth
// across a reload — callers re-read on mount and after every confirmed
// transaction, exactly as the existing circle screens do with their own
// chain's read calls.

import { id as keccakId } from "ethers";

import { CELO_MAINNET } from "./config";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";
import { wrapCeloProvider } from "./transactions";

export type CeloContributionStatus = "PENDING" | "ON_TIME" | "LATE_WITHIN_GRACE" | "MISSED_DEFAULT";
export type CeloPayoutStatus = "SCHEDULED" | "PAID" | "DEFERRED_LOCKED";
export type CeloCircleStatus = "ACTIVE" | "COMPLETED";

const CONTRIBUTION_STATUS: CeloContributionStatus[] = [
  "PENDING",
  "ON_TIME",
  "LATE_WITHIN_GRACE",
  "MISSED_DEFAULT",
];
const PAYOUT_STATUS: CeloPayoutStatus[] = ["SCHEDULED", "PAID", "DEFERRED_LOCKED"];
const CIRCLE_STATUS: CeloCircleStatus[] = ["ACTIVE", "COMPLETED"];

function selector(signature: string): string {
  return keccakId(signature).slice(0, 10);
}

function encodeAddressArg(addr: string): string {
  return normalizeAddress(addr).slice(2).padStart(64, "0");
}

function encodeUint32Arg(value: number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function decodeUint(data: string): bigint {
  if (data === "0x" || data.length === 0) return 0n;
  return BigInt(data);
}

function decodeAddress(data: string): string {
  const hex = data.slice(2).slice(-40);
  return normalizeAddress(`0x${hex}`);
}

function decodeEnum<T>(data: string, values: readonly T[]): T {
  const index = Number(decodeUint(data));
  const value = values[index];
  if (value === undefined) throw new Error(`Celo read refused: enum index ${index} out of range`);
  return value;
}

export interface CeloCircleSnapshot {
  status: CeloCircleStatus;
  currentRound: number;
  memberCount: number;
  organizer: string;
  contributionAmount: bigint;
  dueAt: number;
  graceEndsAt: number;
  scheduledMember: string;
  payoutStatus: CeloPayoutStatus;
}

export class CeloCircleReader {
  private readonly provider: CeloProviderLike;

  constructor(private readonly circleContract: string, provider: CeloProviderLike) {
    normalizeAddress(circleContract);
    this.provider = wrapCeloProvider(provider);
  }

  private async call(data: string): Promise<string> {
    return (await this.provider.request({
      method: "eth_call",
      params: [{ to: normalizeAddress(this.circleContract), data }, "latest"],
    })) as string;
  }

  async readStatus(): Promise<CeloCircleStatus> {
    return decodeEnum(await this.call(selector("status()")), CIRCLE_STATUS);
  }

  async readCurrentRound(): Promise<number> {
    return Number(decodeUint(await this.call(selector("currentRound()"))));
  }

  async readMemberCount(): Promise<number> {
    return Number(decodeUint(await this.call(selector("memberCount()"))));
  }

  async readOrganizer(): Promise<string> {
    return decodeAddress(await this.call(selector("organizer()")));
  }

  async readContributionAmount(): Promise<bigint> {
    return decodeUint(await this.call(selector("contributionAmount()")));
  }

  async readDueAt(): Promise<number> {
    return Number(decodeUint(await this.call(selector("dueAt()"))));
  }

  async readGraceEndsAt(): Promise<number> {
    return Number(decodeUint(await this.call(selector("graceEndsAt()"))));
  }

  async readMemberAt(index: number): Promise<string> {
    const data = `0x${selector("memberAt(uint256)").slice(2)}${encodeUint32Arg(index)}`;
    return decodeAddress(await this.call(data));
  }

  async readIsMember(account: string): Promise<boolean> {
    const data = `0x${selector("isMember(address)").slice(2)}${encodeAddressArg(account)}`;
    return decodeUint(await this.call(data)) !== 0n;
  }

  async readCadenceSeconds(): Promise<number> {
    return Number(decodeUint(await this.call(selector("cadenceSeconds()"))));
  }

  async readGracePeriodSeconds(): Promise<number> {
    return Number(decodeUint(await this.call(selector("gracePeriodSeconds()"))));
  }

  async readScheduledMember(round: number): Promise<string> {
    const data = `0x${selector("scheduledMember(uint32)").slice(2)}${encodeUint32Arg(round)}`;
    return decodeAddress(await this.call(data));
  }

  async readContributionStatus(round: number, member: string): Promise<CeloContributionStatus> {
    const data =
      `0x${selector("contributionStatus(uint32,address)").slice(2)}` +
      `${encodeUint32Arg(round)}${encodeAddressArg(member)}`;
    return decodeEnum(await this.call(data), CONTRIBUTION_STATUS);
  }

  async readPayoutStatus(round: number): Promise<CeloPayoutStatus> {
    const data = `0x${selector("payoutStatus(uint32)").slice(2)}${encodeUint32Arg(round)}`;
    return decodeEnum(await this.call(data), PAYOUT_STATUS);
  }

  /**
   * Whether `member` has already recovered `round`. There is no public
   * getter for the contract's private `_recovered` mapping, so this reads
   * the authoritative on-chain fact a different way: the `Recovered` event
   * it emits on success is indexed by both member and round, so a match on
   * that filter is as reliable as a getter would be, without guessing and
   * without needing a transaction attempt to find out.
   */
  async readRecovered(round: number, member: string): Promise<boolean> {
    const topic0 = keccakId("Recovered(address,uint32,uint256)");
    const topic1 = `0x${encodeAddressArg(member)}`;
    const topic2 = `0x${encodeUint32Arg(round)}`;
    const logs = (await this.provider.request({
      method: "eth_getLogs",
      params: [
        {
          address: normalizeAddress(this.circleContract),
          topics: [topic0, topic1, topic2],
          fromBlock: "earliest",
          toBlock: "latest",
        },
      ],
    })) as unknown[];
    return Array.isArray(logs) && logs.length > 0;
  }

  /** Every fact a circle screen needs, read fresh in one pass. */
  async readSnapshot(): Promise<CeloCircleSnapshot> {
    const [status, currentRound, memberCount, organizer, contributionAmount, dueAt, graceEndsAt] =
      await Promise.all([
        this.readStatus(),
        this.readCurrentRound(),
        this.readMemberCount(),
        this.readOrganizer(),
        this.readContributionAmount(),
        this.readDueAt(),
        this.readGraceEndsAt(),
      ]);
    const [scheduledMember, payoutStatus] = await Promise.all([
      this.readScheduledMember(currentRound),
      this.readPayoutStatus(currentRound),
    ]);
    return {
      status,
      currentRound,
      memberCount,
      organizer,
      contributionAmount,
      dueAt,
      graceEndsAt,
      scheduledMember,
      payoutStatus,
    };
  }
}

export { CELO_MAINNET };

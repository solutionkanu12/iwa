// lib/credential/credentialChainReader.ts — the RPC adapter that lets the pure
// verifier (`verify.ts`) re-derive every credential fact from IwaCircleV2.
//
// View calls only. Nothing here can sign, approve, or send. It does NOT import
// or modify the pot-collection reader (`chains/strk20/v2/publicReadsV2.ts`);
// the credential path stays self-contained so a change to one cannot silently
// alter the other. Struct/enum layouts are transcribed from
// contracts/starknet/src/iwa_types*.cairo (Cairo declaration order).
//
// Error mapping is deliberately narrow: only the exact "not found" reverts map
// to `null`. Every other error propagates so the verifier fails closed
// ("Unable to verify"), never open.

import { RpcProvider } from "starknet";

import type { CredentialChainReader } from "./verify";

/** A single read-only contract call: entrypoint + calldata -> felt results. */
export type RawCall = (entrypoint: string, calldata: string[]) => Promise<string[]>;

/** `iwa_types::ContributionStatus`, in Cairo declaration order. */
const CONTRIBUTION_STATUS = ["Pending", "OnTime", "LateWithinGrace", "MissedDefault"] as const;

/** `iwa_types_v2::PayoutStatusV2`, in Cairo declaration order. */
const PAYOUT_STATUS_V2 = [
  "Scheduled",
  "DeferredLocked",
  "PrivateSettlementAuthorized",
  "PrivatelyPaid",
  "RecoveryPending",
  "PrivatelyRecovered",
  "NoFundedRecovery",
] as const;

/** `iwa_types::CircleStatus`, in Cairo declaration order. */
const CIRCLE_STATUS = [
  "Created",
  "OpenForMembers",
  "Active",
  "PausedForNewActions",
  "SettlementPending",
  "Completed",
] as const;

/** The exact revert short strings that mean "the record simply does not exist". */
const OBLIGATION_NOT_FOUND = "IWA: obligation not found";
const PAYOUT_LOCKED = "IWA: payout locked";

const asInt = (f: string): number => Number(BigInt(f));
const feltHex = (f: string): string => `0x${BigInt(f).toString(16)}`;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "";
}

function variant<T extends readonly string[]>(table: T, felt: string, what: string): T[number] {
  const i = asInt(felt);
  if (i < 0 || i >= table.length) throw new Error(`unknown ${what} discriminant ${i}`);
  return table[i];
}

export interface CredentialChainReaderConfig {
  circleV2Address: string;
  /** Inject a call for tests. In production, pass `nodeUrl` instead. */
  call?: RawCall;
  nodeUrl?: string;
}

export function makeCredentialChainReader(cfg: CredentialChainReaderConfig): CredentialChainReader {
  const call: RawCall =
    cfg.call ??
    (() => {
      if (!cfg.nodeUrl) throw new Error("credential chain reader needs a call or a nodeUrl");
      const provider = new RpcProvider({ nodeUrl: cfg.nodeUrl });
      return (entrypoint: string, calldata: string[]) =>
        provider.callContract(
          { contractAddress: cfg.circleV2Address, entrypoint, calldata },
          "latest",
        );
    })();

  return {
    async getMemberAuthKey(circleId, memberRef) {
      const r = await call("get_member_auth_key", [String(circleId), memberRef]);
      return BigInt(r[0]);
    },

    async isMember(circleId, memberRef) {
      const r = await call("is_member", [String(circleId), memberRef]);
      return asInt(r[0]) === 1;
    },

    async getCircle(circleId) {
      const r = await call("get_circle", [String(circleId)]);
      if (r.length < 12) throw new Error(`get_circle returned ${r.length} felts, expected 12`);
      const s = asInt(r[7]);
      return {
        memberLimit: asInt(r[5]),
        currentRound: asInt(r[6]),
        status: s >= 0 && s < CIRCLE_STATUS.length ? CIRCLE_STATUS[s] : `#${s}`,
      };
    },

    async getContributionStatus(circleId, round, memberRef) {
      let r: string[];
      try {
        r = await call("get_contribution_obligation", [
          String(circleId),
          String(round),
          memberRef,
        ]);
      } catch (e) {
        if (errText(e).includes(OBLIGATION_NOT_FOUND)) return null;
        throw e;
      }
      if (r.length < 8) {
        throw new Error(`get_contribution_obligation returned ${r.length} felts, expected 8`);
      }
      return variant(CONTRIBUTION_STATUS, r[7], "ContributionStatus");
    },

    async isFinalSettlementPrepared(circleId) {
      const r = await call("is_final_settlement_prepared", [String(circleId)]);
      return asInt(r[0]) === 1;
    },

    async getPayoutOrder(circleId) {
      const r = await call("get_payout_order", [String(circleId)]);
      return r.slice(1, 1 + asInt(r[0])).map(feltHex);
    },

    async getPayoutStatusV2(circleId, round) {
      let r: string[];
      try {
        r = await call("get_payout_state_v2", [String(circleId), String(round)]);
      } catch (e) {
        if (errText(e).includes(PAYOUT_LOCKED)) return null;
        throw e;
      }
      if (r.length < 5) {
        throw new Error(`get_payout_state_v2 returned ${r.length} felts, expected 5`);
      }
      return variant(PAYOUT_STATUS_V2, r[4], "PayoutStatusV2");
    },
  };
}

// Decoding cover for IwaCircleV2 view calls — the felt layouts and the
// revert-string matchers the flow relies on.

import { describe, expect, it } from "vitest";

import {
  PAYOUT_STATUS_V2,
  getDestEpoch,
  getPayoutStateV2,
  getRegisteredPayoutDestinationV2,
  isDestinationNotRegistered,
  isPayoutNotPreparedV2,
  isPayoutPrivatelySettled,
  isScheduledRecipient,
} from "./publicReadsV2";

const CIRCLE_V2 = "0x0c1";

function providerReturning(map: Record<string, string[] | (() => never)>) {
  return {
    callContract: async ({ entrypoint }: { entrypoint: string }) => {
      const v = map[entrypoint];
      if (typeof v === "function") return v();
      if (!v) throw new Error(`no stub for ${entrypoint}`);
      return v;
    },
  } as unknown as Parameters<typeof getPayoutStateV2>[0];
}

describe("PAYOUT_STATUS_V2 ordering matches the Cairo enum", () => {
  it("has the seven variants in declaration order", () => {
    expect([...PAYOUT_STATUS_V2]).toEqual([
      "Scheduled",
      "DeferredLocked",
      "PrivateSettlementAuthorized",
      "PrivatelyPaid",
      "RecoveryPending",
      "PrivatelyRecovered",
      "NoFundedRecovery",
    ]);
  });
});

describe("getPayoutStateV2", () => {
  it("decodes the five felts and maps the status discriminant", async () => {
    const provider = providerReturning({
      get_payout_state_v2: ["0x7", "0x3", "0xabc", "0x989680", "0x2"],
    });
    const s = await getPayoutStateV2(provider, CIRCLE_V2, 7, 3);
    expect(s).toEqual({
      circleId: 7,
      round: 3,
      scheduledMemberRef: "0xabc",
      amount: 10_000_000n,
      status: "PrivateSettlementAuthorized",
    });
  });

  it("returns null when the contract reverts with 'IWA: payout locked'", async () => {
    const provider = providerReturning({
      get_payout_state_v2: () => {
        throw new Error("Contract error: IWA: payout locked");
      },
    });
    expect(await getPayoutStateV2(provider, CIRCLE_V2, 7, 3)).toBeNull();
  });

  it("rethrows any other error", async () => {
    const provider = providerReturning({
      get_payout_state_v2: () => {
        throw new Error("RPC timeout");
      },
    });
    await expect(getPayoutStateV2(provider, CIRCLE_V2, 7, 3)).rejects.toThrow(/RPC timeout/);
  });
});

describe("getRegisteredPayoutDestinationV2", () => {
  it("decodes the four felts", async () => {
    const provider = providerReturning({
      get_registered_payout_destination: ["0x9001", "0x989680", "0x5", "0x713fb300"],
    });
    expect(await getRegisteredPayoutDestinationV2(provider, CIRCLE_V2, 7, 3)).toEqual({
      noteId: 0x9001n,
      amount: 10_000_000n,
      destEpoch: 5n,
      expiry: 0x713fb300n,
    });
  });

  it("returns null when none is registered", async () => {
    const provider = providerReturning({
      get_registered_payout_destination: () => {
        throw new Error("Contract error: IWA2: no destination");
      },
    });
    expect(await getRegisteredPayoutDestinationV2(provider, CIRCLE_V2, 7, 3)).toBeNull();
  });
});

describe("scalar reads", () => {
  it("getDestEpoch returns a bigint", async () => {
    const provider = providerReturning({ get_dest_epoch: ["0x4"] });
    expect(await getDestEpoch(provider, CIRCLE_V2, 7, "0xabc")).toBe(4n);
  });

  it("isPayoutPrivatelySettled decodes the bool", async () => {
    expect(
      await isPayoutPrivatelySettled(providerReturning({ is_payout_privately_settled: ["0x1"] }), CIRCLE_V2, 7, 3),
    ).toBe(true);
    expect(
      await isPayoutPrivatelySettled(providerReturning({ is_payout_privately_settled: ["0x0"] }), CIRCLE_V2, 7, 3),
    ).toBe(false);
  });
});

describe("revert-string matchers", () => {
  it("isPayoutNotPreparedV2 matches only the payout-locked string", () => {
    expect(isPayoutNotPreparedV2(new Error("... IWA: payout locked ..."))).toBe(true);
    expect(isPayoutNotPreparedV2(new Error("IWA2: no destination"))).toBe(false);
    expect(isPayoutNotPreparedV2("random")).toBe(false);
  });

  it("isDestinationNotRegistered matches only the no-destination string", () => {
    expect(isDestinationNotRegistered(new Error("x IWA2: no destination y"))).toBe(true);
    expect(isDestinationNotRegistered(new Error("IWA: payout locked"))).toBe(false);
  });
});

describe("isScheduledRecipient", () => {
  const payout = {
    circleId: 7,
    round: 3,
    scheduledMemberRef: "0x0abc",
    amount: 1n,
    status: "Scheduled" as const,
  };

  it("compares as felts (leading zeros do not matter)", () => {
    expect(isScheduledRecipient(payout, "0xabc")).toBe(true);
    expect(isScheduledRecipient(payout, "0x0abc")).toBe(true);
  });

  it("rejects a different member", () => {
    expect(isScheduledRecipient(payout, "0xabd")).toBe(false);
  });
});

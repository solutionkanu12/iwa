import { describe, expect, it } from "vitest";

import { makeCredentialChainReader, type RawCall } from "./credentialChainReader";

const CIRCLE_V2 = "0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a";
const MEMBER_REF = "0xabc123";

/** Build a reader over a scripted call table. */
function readerFrom(table: Record<string, string[] | (() => never)>) {
  const call: RawCall = async (entrypoint, calldata) => {
    const v = table[entrypoint];
    if (!v) throw new Error(`no scripted response for ${entrypoint}(${calldata.join(",")})`);
    return typeof v === "function" ? v() : v;
  };
  return makeCredentialChainReader({ circleV2Address: CIRCLE_V2, call });
}

const revertWith = (short: string) => () => {
  throw new Error(`RPC: Contract error ... ${short} ... execution failed`);
};

describe("makeCredentialChainReader", () => {
  it("decodes get_member_auth_key as a bigint felt", async () => {
    const r = readerFrom({ get_member_auth_key: ["0x1a2b"] });
    expect(await r.getMemberAuthKey(7, MEMBER_REF)).toBe(0x1a2bn);
  });

  it("decodes is_member as a boolean", async () => {
    expect(await readerFrom({ is_member: ["0x1"] }).isMember(7, MEMBER_REF)).toBe(true);
    expect(await readerFrom({ is_member: ["0x0"] }).isMember(7, MEMBER_REF)).toBe(false);
  });

  it("decodes get_circle into memberLimit / currentRound / status", async () => {
    // 12-felt get_circle layout (see publicReadsV2): [id,asset,contribAmt,?,?,memberLimit,currentRound,status,...]
    const felts = ["0x7", "0x1", "0x64", "0x0", "0x0", "0x5", "0x6", "0x2", "0x0", "0x0", "0x0", "0x3"];
    const c = await readerFrom({ get_circle: felts }).getCircle(7);
    expect(c.memberLimit).toBe(5);
    expect(c.currentRound).toBe(6);
    expect(c.status).toBe("Active");
  });

  it("decodes get_contribution_obligation status (felt index 7)", async () => {
    // [circle_id, round, member_ref, asset, required_amount, due_at, grace_ends_at, status]
    const r = readerFrom({
      get_contribution_obligation: ["0x7", "0x2", MEMBER_REF, "0x0", "0x64", "0x0", "0x0", "0x1"],
    });
    expect(await r.getContributionStatus(7, 2, MEMBER_REF)).toBe("OnTime");
  });

  it("maps 'IWA: obligation not found' to null (no obligation for that round)", async () => {
    const r = readerFrom({ get_contribution_obligation: revertWith("IWA: obligation not found") });
    expect(await r.getContributionStatus(7, 9, MEMBER_REF)).toBeNull();
  });

  it("re-throws any other contribution error (fail closed, never null)", async () => {
    const r = readerFrom({ get_contribution_obligation: revertWith("IWA: circle not found") });
    await expect(r.getContributionStatus(7, 2, MEMBER_REF)).rejects.toThrow(/circle not found/);
  });

  it("decodes is_final_settlement_prepared as a boolean", async () => {
    expect(await readerFrom({ is_final_settlement_prepared: ["0x1"] }).isFinalSettlementPrepared(7)).toBe(true);
    expect(await readerFrom({ is_final_settlement_prepared: ["0x0"] }).isFinalSettlementPrepared(7)).toBe(false);
  });

  it("decodes get_payout_order as normalised 0x-hex member refs", async () => {
    const r = readerFrom({ get_payout_order: ["0x3", "0x0abc", "0xdef", "0x111"] });
    expect(await r.getPayoutOrder(7)).toEqual(["0xabc", "0xdef", "0x111"]);
  });

  it("decodes get_payout_state_v2 status (felt index 4)", async () => {
    // [circle_id, round, scheduled_member_ref, amount, status]
    const r = readerFrom({ get_payout_state_v2: ["0x7", "0x1", MEMBER_REF, "0x3e8", "0x3"] });
    expect(await r.getPayoutStatusV2(7, 1)).toBe("PrivatelyPaid");
  });

  it("maps 'IWA: payout locked' to null (no payout state yet)", async () => {
    const r = readerFrom({ get_payout_state_v2: revertWith("IWA: payout locked") });
    expect(await r.getPayoutStatusV2(7, 1)).toBeNull();
  });

  it("re-throws any other payout error (fail closed)", async () => {
    const r = readerFrom({ get_payout_state_v2: revertWith("IWA: circle not found") });
    await expect(r.getPayoutStatusV2(7, 1)).rejects.toThrow(/circle not found/);
  });

  it("an unknown contribution-status discriminant throws rather than guessing", async () => {
    const r = readerFrom({
      get_contribution_obligation: ["0x7", "0x2", MEMBER_REF, "0x0", "0x64", "0x0", "0x0", "0x9"],
    });
    await expect(r.getContributionStatus(7, 2, MEMBER_REF)).rejects.toThrow(/ContributionStatus/);
  });
});

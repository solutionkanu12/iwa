// The V2 calldata shapes are the whole contract with IwaCircleV2 and the V2
// helper: a wrong felt order or a non-zero nonce/signature is a reverted
// mainnet transaction, not a type error.

import { describe, expect, it } from "vitest";

import { STARKNET_MAINNET, sameAddress } from "../../starknetProduction";
import { FIRST_OPEN_NOTE, assertActionsWellFormed } from "../strk20Actions";
import * as payoutActionsV2 from "./payoutActionsV2";
import {
  V2_PAYOUT_SURFACE,
  V2_SETTLE_PAYOUT,
  buildPayoutSettlementActionsV2,
  buildRegisterPayoutDestinationCall,
  extractResolvedOpenNoteId,
  v2PrivacyInvokeCalldata,
} from "./payoutActionsV2";

const CIRCLE_V2 = "0x0abc";
const HELPER_V2 = "0x0def";
const USDC = STARKNET_MAINNET.usdcToken;
const MEMBER = 0x301473563c9095055be74afaa57bdc8fc13165de2997a759154f30305f23424n;

describe("buildRegisterPayoutDestinationCall", () => {
  const call = buildRegisterPayoutDestinationCall(CIRCLE_V2, {
    circleId: 7,
    round: 3,
    noteId: 0x9001n,
    amount: 10_000_000n,
    destEpoch: 5n,
    expiry: 1_900_000_000n,
    nonce: 0x777n,
    signature: { r: 0x11n, s: 0x22n },
  });

  it("targets IwaCircleV2 register_payout_destination", () => {
    expect(sameAddress(call.contractAddress, CIRCLE_V2)).toBe(true);
    expect(call.entrypoint).toBe("register_payout_destination");
  });

  it("emits the nine scalar felts in contract signature order", () => {
    expect(call.calldata).toEqual([
      "0x7", // circle_id
      "0x3", // round
      "0x9001", // note_id
      "0x989680", // amount (u128)
      "0x5", // dest_epoch (u64)
      "0x713fb300", // expiry (u64)
      "0x777", // nonce
      "0x11", // signature_r
      "0x22", // signature_s
    ]);
  });

  it("rejects a zero note id", () => {
    expect(() =>
      buildRegisterPayoutDestinationCall(CIRCLE_V2, {
        circleId: 1,
        round: 1,
        noteId: 0n,
        amount: 1n,
        destEpoch: 1n,
        expiry: 1n,
        nonce: 1n,
        signature: { r: 1n, s: 1n },
      }),
    ).toThrow(/noteId must be non-zero/);
  });

  it("rejects an amount that does not fit in u128", () => {
    expect(() =>
      buildRegisterPayoutDestinationCall(CIRCLE_V2, {
        circleId: 1,
        round: 1,
        noteId: 1n,
        amount: 1n << 200n,
        destEpoch: 1n,
        expiry: 1n,
        nonce: 1n,
        signature: { r: 1n, s: 1n },
      }),
    ).toThrow(/u128/);
  });
});

describe("v2PrivacyInvokeCalldata", () => {
  it("forces nonce and both signature felts to zero (NO_ASSEMBLY_SIGNATURE)", () => {
    const cd = v2PrivacyInvokeCalldata({
      operation: V2_SETTLE_PAYOUT,
      circleId: 7,
      round: 3,
      memberRef: MEMBER,
      token: USDC,
      openNoteId: FIRST_OPEN_NOTE,
    });
    expect(cd).toHaveLength(9);
    expect(cd[0]).toBe("0x2"); // SettlePayout
    expect(cd[1]).toBe("0x7");
    expect(cd[2]).toBe("0x3");
    expect(sameAddress(cd[3], `0x${MEMBER.toString(16)}`)).toBe(true);
    expect(sameAddress(cd[4], USDC)).toBe(true);
    expect(cd[5]).toBe(FIRST_OPEN_NOTE);
    expect(cd[6]).toBe("0x0"); // nonce
    expect(cd[7]).toBe("0x0"); // signature_r
    expect(cd[8]).toBe("0x0"); // signature_s
  });
});

describe("buildPayoutSettlementActionsV2", () => {
  const actions = buildPayoutSettlementActionsV2({
    helperV2Address: HELPER_V2,
    circleId: 7,
    round: 3,
    memberRef: MEMBER,
    token: USDC,
    selfAddress: "0x1234",
  });

  it("creates exactly one open note, first, to the member's own address", () => {
    expect(actions[0]).toMatchObject({ type: "transfer", amount: "OPEN" });
    expect(actions[0].type === "transfer" && sameAddress(actions[0].recipient, "0x1234")).toBe(true);
  });

  it("has exactly one invoke, to the V2 helper, referencing the first open note", () => {
    const invokes = actions.filter((a) => a.type === "invoke");
    expect(invokes).toHaveLength(1);
    const inv = invokes[0];
    if (inv.type !== "invoke") throw new Error("unreachable");
    expect(sameAddress(inv.contract, HELPER_V2)).toBe(true);
    expect(inv.calldata).toContain(FIRST_OPEN_NOTE);
    expect(inv.calldata[6]).toBe("0x0");
    expect(inv.calldata[7]).toBe("0x0");
    expect(inv.calldata[8]).toBe("0x0");
  });

  it("passes the V1 protocol-rule guard", () => {
    expect(() => assertActionsWellFormed(actions)).not.toThrow();
  });
});

describe("extractResolvedOpenNoteId", () => {
  const anchors = {
    operation: V2_SETTLE_PAYOUT,
    circleId: 7,
    round: 3,
    memberRef: MEMBER,
    token: USDC,
  } as const;

  // A resolved apply-actions calldata: some create-open-note prefix, then our
  // invoke calldata with ${openNoteIds[0]} replaced by a real felt.
  const resolvedId = 0x64c726788e6bbdba21d2d5e6b6fd46d0253d5df12d4c48195aacbd6d0a01076n;
  const resolvedCalldata = [
    "0x1",
    "0x2",
    "0x999", // unrelated prefix
    "0x2", // SettlePayout
    "0x7",
    "0x3",
    `0x${MEMBER.toString(16)}`,
    USDC,
    `0x${resolvedId.toString(16)}`,
    "0x0",
    "0x0",
    "0x0",
    "0xdeadbeef", // trailing
  ];

  it("returns the wallet-resolved id from the anchored run", () => {
    expect(extractResolvedOpenNoteId({ call: { calldata: resolvedCalldata } }, anchors)).toBe(
      resolvedId,
    );
  });

  it("finds it anywhere in a nested response", () => {
    expect(
      extractResolvedOpenNoteId({ proof: { output: [resolvedCalldata] } }, anchors),
    ).toBe(resolvedId);
  });

  it("returns null when the placeholder was NOT substituted", () => {
    const unresolved = [...resolvedCalldata];
    unresolved[8] = FIRST_OPEN_NOTE;
    expect(extractResolvedOpenNoteId({ call: { calldata: unresolved } }, anchors)).toBeNull();
  });

  it("returns null when the middle felt is zero", () => {
    const zeroed = [...resolvedCalldata];
    zeroed[8] = "0x0";
    expect(extractResolvedOpenNoteId({ call: { calldata: zeroed } }, anchors)).toBeNull();
  });

  it("returns null when a trailing nonce/signature felt is non-zero (wrong shape)", () => {
    const withSig = [...resolvedCalldata];
    withSig[9] = "0x5"; // a nonce would mean this is not our V2 leg
    expect(extractResolvedOpenNoteId({ call: { calldata: withSig } }, anchors)).toBeNull();
  });

  it("returns null when the anchors do not match (wrong circle/round/member/token)", () => {
    expect(
      extractResolvedOpenNoteId(
        { call: { calldata: resolvedCalldata } },
        { ...anchors, circleId: 8 },
      ),
    ).toBeNull();
    expect(
      extractResolvedOpenNoteId(
        { call: { calldata: resolvedCalldata } },
        { ...anchors, round: 4 },
      ),
    ).toBeNull();
    expect(
      extractResolvedOpenNoteId(
        { call: { calldata: resolvedCalldata } },
        { ...anchors, memberRef: MEMBER + 1n },
      ),
    ).toBeNull();
    expect(
      extractResolvedOpenNoteId(
        { call: { calldata: resolvedCalldata } },
        { ...anchors, token: STARKNET_MAINNET.strkToken },
      ),
    ).toBeNull();
  });
});

describe("V2 payout surface — no public ERC20 fallback", () => {
  it("V2_PAYOUT_SURFACE routes only through IwaCircleV2 or the STRK20 pool", () => {
    expect(V2_PAYOUT_SURFACE.length).toBeGreaterThan(0);
    for (const entry of V2_PAYOUT_SURFACE) {
      expect(["IwaCircleV2", "STRK20-pool"]).toContain(entry.target);
    }
  });

  it("the module exports no transfer / approve / erc20 payout helper", () => {
    const names = Object.keys(payoutActionsV2).map((n) => n.toLowerCase());
    for (const forbidden of ["transfer", "approve", "erc20", "sendtoken", "publicpayout"]) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
  });
});

// The action shapes are the whole contract with the pool and the helper: the
// pool deserializes invoke calldata straight into privacy_invoke, so a wrong
// order or a missing field is a reverted mainnet transaction, not a type error.

import { describe, expect, it } from "vitest";

import {
  FIRST_OPEN_NOTE,
  IWA_OPERATION,
  assertActionsWellFormed,
  buildContributionActions,
  buildPayoutActions,
  buildShieldActions,
  privacyInvokeCalldata,
} from "./strk20Actions";
import { STARKNET_MAINNET, sameAddress } from "../starknetProduction";

const SIG = { r: "0x5bbe7ef0", s: "0x1c0c5f5f" };
const MEMBER = "0x301473563c9095055be74afaa57bdc8fc13165de2997a759154f30305f23424";
const USDC = STARKNET_MAINNET.usdcToken;

describe("privacyInvokeCalldata", () => {
  it("emits the nine felts of privacy_invoke in signature order", () => {
    const calldata = privacyInvokeCalldata({
      operation: IWA_OPERATION.SettleContribution,
      circleId: 1,
      round: 2,
      memberRef: MEMBER,
      token: USDC,
      openNoteId: "0",
      nonce: "3",
      signature: SIG,
    });
    expect(calldata).toHaveLength(9);
    expect(calldata[0]).toBe("0x0"); // SettleContribution
    expect(calldata[1]).toBe("0x1");
    expect(calldata[2]).toBe("0x2");
    expect(sameAddress(calldata[3], MEMBER)).toBe(true);
    expect(sameAddress(calldata[4], USDC)).toBe(true);
    expect(calldata[5]).toBe("0x0");
    expect(calldata[6]).toBe("0x3");
    expect(calldata[7]).toBe(SIG.r);
    expect(calldata[8]).toBe(SIG.s);
  });

  it("passes the open-note placeholder through untouched", () => {
    const calldata = privacyInvokeCalldata({
      operation: IWA_OPERATION.SettlePayout,
      circleId: 1,
      round: 1,
      memberRef: MEMBER,
      token: USDC,
      openNoteId: FIRST_OPEN_NOTE,
      nonce: "4",
      signature: SIG,
    });
    expect(calldata[5]).toBe("${openNoteIds[0]}");
  });

  it("rejects a negative felt rather than silently wrapping", () => {
    expect(() =>
      privacyInvokeCalldata({
        operation: IWA_OPERATION.SettleContribution,
        circleId: -1,
        round: 1,
        memberRef: MEMBER,
        token: USDC,
        openNoteId: "0",
        nonce: "1",
        signature: SIG,
      }),
    ).toThrow(/non-negative/);
  });
});

describe("buildShieldActions", () => {
  it("is a single deposit action", () => {
    const actions = buildShieldActions({ token: USDC, amount: "2000000" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "deposit" });
  });
});

describe("buildContributionActions", () => {
  const actions = buildContributionActions({
    circleId: 1,
    round: 1,
    memberRef: MEMBER,
    token: USDC,
    amount: "1000000",
    nonce: "1",
    signature: SIG,
  });

  it("withdraws to the helper before invoking it", () => {
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe("withdraw");
    expect(actions[1].type).toBe("invoke");
    if (actions[0].type !== "withdraw" || actions[1].type !== "invoke") throw new Error("shape");
    expect(sameAddress(actions[0].recipient, STARKNET_MAINNET.iwaHelper)).toBe(true);
    expect(sameAddress(actions[1].contract, STARKNET_MAINNET.iwaHelper)).toBe(true);
  });

  it("creates no open note — contribution binds no output", () => {
    expect(actions.some((a) => a.type === "transfer" && a.amount === "OPEN")).toBe(false);
  });

  it("passes open_note_id = 0, which the helper asserts for contributions", () => {
    if (actions[1].type !== "invoke") throw new Error("shape");
    expect(actions[1].calldata[5]).toBe("0x0");
    expect(actions[1].calldata[0]).toBe("0x0");
  });

  it("is well formed", () => {
    expect(() => assertActionsWellFormed(actions)).not.toThrow();
  });
});

describe("buildPayoutActions", () => {
  const actions = buildPayoutActions({
    circleId: 1,
    round: 1,
    memberRef: MEMBER,
    token: USDC,
    recipient: "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85",
    nonce: "4",
    signature: SIG,
  });

  it("opens exactly one note, first, then invokes", () => {
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "transfer", amount: "OPEN" });
    expect(actions[1].type).toBe("invoke");
  });

  it("references that note through the wallet placeholder", () => {
    if (actions[1].type !== "invoke") throw new Error("shape");
    expect(actions[1].calldata[5]).toBe(FIRST_OPEN_NOTE);
    expect(actions[1].calldata[0]).toBe("0x2"); // SettlePayout
  });

  it("is well formed", () => {
    expect(() => assertActionsWellFormed(actions)).not.toThrow();
  });
});

describe("assertActionsWellFormed", () => {
  it("rejects an empty action list", () => {
    expect(() => assertActionsWellFormed([])).toThrow(/at least one action/);
  });

  it("rejects two invokes — the pool allows at most one per transaction", () => {
    expect(() =>
      assertActionsWellFormed([
        { type: "invoke", contract: "0x1", calldata: [] },
        { type: "invoke", contract: "0x2", calldata: [] },
      ]),
    ).toThrow(/at most one invoke/);
  });

  it("rejects an open note that nothing fills", () => {
    expect(() =>
      assertActionsWellFormed([
        { type: "transfer", token: USDC, amount: "OPEN", recipient: "0x1" },
      ]),
    ).toThrow(/UNDEPOSITED_OPEN_NOTES/);
  });

  it("rejects a placeholder with no open note to resolve", () => {
    expect(() =>
      assertActionsWellFormed([
        { type: "invoke", contract: "0x1", calldata: [FIRST_OPEN_NOTE] },
      ]),
    ).toThrow(/no open note is created/);
  });
});

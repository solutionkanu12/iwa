// Regression cover for the "dry-build appears to do nothing" class of bug:
// a rejection or an empty result that never reaches the UI.

import { describe, expect, it, vi } from "vitest";
import type { STRK20_ACTION } from "@starknet-io/types-js";

import {
  Strk20WalletError,
  assertStrk20Capable,
  describeUnknownError,
  dryRun,
  toStrk20Error,
} from "./iwaStrk20Client";
import type { ConnectedWallet } from "./walletConnect";
import { STARKNET_MAINNET } from "../starknetProduction";

const ACTIONS: STRK20_ACTION[] = [
  { type: "deposit", token: STARKNET_MAINNET.usdcToken, amount: "2000000" },
];

function fakeWallet(overrides: Record<string, unknown> = {}): ConnectedWallet {
  return {
    account: {
      strk20PrepareInvoke: vi.fn(),
      strk20InvokeTransaction: vi.fn(),
      strk20Balances: vi.fn(),
      ...overrides,
    },
    address: "0x1",
    chainId: STARKNET_MAINNET.chainId,
    walletName: "Fake",
  } as unknown as ConnectedWallet;
}

describe("describeUnknownError", () => {
  it("renders a JSON-RPC error object instead of [object Object]", () => {
    // This is the shape that made a real failure look like nothing happened.
    const text = describeUnknownError({ code: 63, message: "USER_REFUSED_OP" });
    expect(text).toBe("code 63: USER_REFUSED_OP");
    expect(text).not.toContain("[object Object]");
  });

  it("includes the data field when the wallet supplies one", () => {
    expect(describeUnknownError({ code: -32603, message: "internal", data: "prover down" })).toBe(
      "code -32603: internal: prover down",
    );
  });

  it("handles Error, string, null and undefined", () => {
    expect(describeUnknownError(new Error("boom"))).toBe("boom");
    expect(describeUnknownError("plain")).toBe("plain");
    expect(describeUnknownError(null)).toMatch(/empty rejection/);
    expect(describeUnknownError(undefined)).toMatch(/empty rejection/);
  });

  it("falls back to JSON for an object with no recognised fields", () => {
    expect(describeUnknownError({ weird: true })).toBe('{"weird":true}');
  });

  it("never returns an empty string", () => {
    expect(describeUnknownError(new Error(""))).not.toBe("");
    expect(describeUnknownError({})).not.toBe("");
  });
});

describe("toStrk20Error", () => {
  it("classifies a wallet refusal from an error object", () => {
    const err = toStrk20Error({ code: 63, message: "USER_REFUSED_OP" });
    expect(err.kind).toBe("USER_REFUSED_OP");
    expect(err.message).toContain("declined");
  });

  it("classifies an unregistered user", () => {
    expect(toStrk20Error(new Error("NOT_REGISTERED")).kind).toBe("NOT_REGISTERED");
  });

  it("falls back to UNKNOWN_ERROR but still shows the raw text", () => {
    const err = toStrk20Error({ code: 999, message: "something odd" });
    expect(err.kind).toBe("UNKNOWN_ERROR");
    expect(err.message).toContain("something odd");
  });

  it("passes an already-typed error through unchanged", () => {
    const original = new Strk20WalletError("PRIVACY_LEAK", "leak");
    expect(toStrk20Error(original)).toBe(original);
  });
});

describe("assertStrk20Capable", () => {
  it("accepts an account exposing every STRK20 method", () => {
    expect(() => assertStrk20Capable(fakeWallet())).not.toThrow();
  });

  it("rejects an account that lost the methods", () => {
    expect(() => assertStrk20Capable(fakeWallet({ strk20PrepareInvoke: undefined }))).toThrow(
      /does not expose strk20PrepareInvoke/,
    );
  });
});

describe("dryRun", () => {
  it("calls strk20PrepareInvoke with simulate=true", async () => {
    const prepare = vi.fn().mockResolvedValue({
      call: { entry_point: "apply_actions", calldata: ["0x1", "0x2"] },
      proof: { data: "", output: [], proof_facts: [] },
    });
    const wallet = fakeWallet({ strk20PrepareInvoke: prepare });

    const built = await dryRun(wallet, ACTIONS);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(ACTIONS, true);
    expect(built.call.calldata).toHaveLength(2);
  });

  it("emits a trace of the call and its result", async () => {
    const events: string[] = [];
    const wallet = fakeWallet({
      strk20PrepareInvoke: vi.fn().mockResolvedValue({
        call: { entry_point: "apply_actions", calldata: ["0x1"] },
        proof: { data: "", output: [], proof_facts: [] },
      }),
    });

    await dryRun(wallet, ACTIONS, (m) => events.push(m));

    expect(events.some((e) => e.includes("calling strk20PrepareInvoke"))).toBe(true);
    expect(events.some((e) => e.includes("resolved"))).toBe(true);
  });

  it("surfaces a rejection as a typed error and traces it", async () => {
    const events: string[] = [];
    const wallet = fakeWallet({
      strk20PrepareInvoke: vi.fn().mockRejectedValue({ code: 63, message: "USER_REFUSED_OP" }),
    });

    await expect(dryRun(wallet, ACTIONS, (m) => events.push(m))).rejects.toThrow(/declined/);
    expect(events.some((e) => e.includes("rejected"))).toBe(true);
  });

  it("treats a resolved-but-empty result as a failure, not a blank preview", async () => {
    // The silent case: the promise settles, nothing renders, no error shows.
    const wallet = fakeWallet({ strk20PrepareInvoke: vi.fn().mockResolvedValue(undefined) });
    await expect(dryRun(wallet, ACTIONS)).rejects.toThrow(/no call/);
  });

  it("treats a result with no call the same way", async () => {
    const wallet = fakeWallet({ strk20PrepareInvoke: vi.fn().mockResolvedValue({ proof: {} }) });
    await expect(dryRun(wallet, ACTIONS)).rejects.toThrow(/no call/);
  });

  it("refuses before calling the wallet when the actions are malformed", async () => {
    const prepare = vi.fn();
    const wallet = fakeWallet({ strk20PrepareInvoke: prepare });
    await expect(dryRun(wallet, [])).rejects.toThrow(/at least one action/);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("NOT_REGISTERED guidance", () => {
  it("explains that no dapp can register on the user's behalf", () => {
    const err = toStrk20Error({ code: 0, message: "NOT_REGISTERED" });
    expect(err.kind).toBe("NOT_REGISTERED");
    // The Wallet API has no registration action, so the copy must not imply
    // the console can fix this by retrying or by sending something.
    expect(err.message).toMatch(/cannot register on your behalf/i);
    expect(err.message).toMatch(/wallet/i);
  });
});

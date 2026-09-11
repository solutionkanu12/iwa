import { describe, expect, it } from "vitest";

import {
  CELO_AUTH_ACTIONS,
  celoAuthorizationTypedData,
  signOrganizerAuthorization,
} from "./organizerAuthorization";
import type { EthereumProviderLike } from "../ethereum/wallet";

const ORGANIZER = "0x00000000000000000000000000000000000000aa";
const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000ab";

describe("celoAuthorizationTypedData (fixed vector — must match backend/src/celoAuthBinding.ts exactly)", () => {
  it("produces the exact domain and type shape the backend verifies against", () => {
    const typed = celoAuthorizationTypedData({
      action: CELO_AUTH_ACTIONS.accountBindingInvite,
      circleId: "circle-1",
      circleContract: CIRCLE_CONTRACT,
      memberRef: "m1",
      organizer: ORGANIZER,
      nonce: "0x00000000000000000000000000000000000000000000000000000000000001",
      expiresAt: 1_000,
    });

    expect(typed.domain).toEqual({ name: "Iwa-Celo", version: "1", chainId: 42220 });
    expect(typed.types).toEqual({
      AccountBindingInviteAuthorization: [
        { name: "action", type: "string" },
        { name: "circleId", type: "string" },
        { name: "circleContract", type: "address" },
        { name: "memberRef", type: "string" },
        { name: "organizer", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
      ],
    });
    expect(typed.message).toEqual({
      action: "account-binding:invite",
      circleId: "circle-1",
      circleContract: CIRCLE_CONTRACT,
      memberRef: "m1",
      organizer: ORGANIZER,
      nonce: "0x00000000000000000000000000000000000000000000000000000000000001",
      expiresAt: 1_000,
    });
  });

  it("action strings match the backend's CELO_AUTH_ACTIONS exactly", () => {
    expect(CELO_AUTH_ACTIONS.accountBindingInvite).toBe("account-binding:invite");
    expect(CELO_AUTH_ACTIONS.accountBindingStatus).toBe("account-binding:status");
  });
});

describe("signOrganizerAuthorization", () => {
  function mockProvider(): { provider: EthereumProviderLike; calls: unknown[] } {
    const calls: unknown[] = [];
    const provider: EthereumProviderLike = {
      async request(args) {
        calls.push(args);
        return "0xsignature";
      },
    };
    return { provider, calls };
  }

  it("signs eth_signTypedData_v4 with a fresh nonce and a bounded expiry", async () => {
    const { provider, calls } = mockProvider();
    const now = () => 10_000_000; // ms
    const signed = await signOrganizerAuthorization(
      provider,
      { action: CELO_AUTH_ACTIONS.accountBindingInvite, circleId: "c1", circleContract: CIRCLE_CONTRACT, memberRef: "m1", organizer: ORGANIZER },
      now,
    );

    expect(signed.organizer).toBe(ORGANIZER);
    expect(signed.signature).toBe("0xsignature");
    expect(signed.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.expiresAt).toBe(10_000 + 4 * 60); // now/1000 + TTL

    expect(calls).toHaveLength(1);
    const call = calls[0] as { method: string; params: [string, string] };
    expect(call.method).toBe("eth_signTypedData_v4");
    expect(call.params[0]).toBe(ORGANIZER);
    const sentTypedData = JSON.parse(call.params[1]);
    expect(sentTypedData.message.nonce).toBe(signed.nonce);
    expect(sentTypedData.message.expiresAt).toBe(signed.expiresAt);
    expect(sentTypedData.domain).toEqual({ name: "Iwa-Celo", version: "1", chainId: 42220 });
  });

  it("generates a different nonce on every call", async () => {
    const { provider } = mockProvider();
    const first = await signOrganizerAuthorization(provider, {
      action: CELO_AUTH_ACTIONS.accountBindingInvite,
      circleId: "c1",
      circleContract: CIRCLE_CONTRACT,
      memberRef: "m1",
      organizer: ORGANIZER,
    });
    const second = await signOrganizerAuthorization(provider, {
      action: CELO_AUTH_ACTIONS.accountBindingInvite,
      circleId: "c1",
      circleContract: CIRCLE_CONTRACT,
      memberRef: "m1",
      organizer: ORGANIZER,
    });
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("propagates a wallet rejection rather than returning a signature", async () => {
    const provider: EthereumProviderLike = {
      async request() {
        throw new Error("User rejected the request");
      },
    };
    await expect(
      signOrganizerAuthorization(provider, {
        action: CELO_AUTH_ACTIONS.accountBindingInvite,
        circleId: "c1",
        circleContract: CIRCLE_CONTRACT,
        memberRef: "m1",
        organizer: ORGANIZER,
      }),
    ).rejects.toThrow(/rejected/);
  });
});

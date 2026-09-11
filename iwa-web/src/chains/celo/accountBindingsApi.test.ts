import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptAccountBindingInvite,
  createAccountBindingInvite,
  readAccountBindingStatus,
} from "./accountBindingsApi";
import { BackendError } from "../../lib/backend";
import type { SignedCeloAuthorization } from "./organizerAuthorization";

const CIRCLE = "circle-1";
const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000ab";
const MEMBER = "m1";

const AUTHORIZATION: SignedCeloAuthorization = {
  organizer: "0x00000000000000000000000000000000000000aa",
  nonce: "0x00",
  expiresAt: 1_000,
  signature: "0xsig",
};

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAccountBindingInvite", () => {
  it("posts exactly the fields the organizer flow computed", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/api/account-bindings/invites");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        circleId: CIRCLE,
        circleContract: CIRCLE_CONTRACT,
        memberRef: MEMBER,
        chain: "celo:42220",
        authorization: AUTHORIZATION,
      });
      return jsonResponse(200, { inviteToken: "tok123" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAccountBindingInvite({
      circleId: CIRCLE,
      circleContract: CIRCLE_CONTRACT,
      memberRef: MEMBER,
      chain: "celo:42220",
      authorization: AUTHORIZATION,
    });
    expect(result.inviteToken).toBe("tok123");
  });

  it("maps a backend failure to a BackendError with Celo-appropriate copy, not Starknet copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "wrong_signer" })));
    const attempt = createAccountBindingInvite({
      circleId: CIRCLE,
      circleContract: CIRCLE_CONTRACT,
      memberRef: MEMBER,
      chain: "celo:42220",
      authorization: AUTHORIZATION,
    });
    await expect(attempt).rejects.toBeInstanceOf(BackendError);
    await expect(attempt).rejects.toMatchObject({
      code: "wrong_signer",
      message: expect.stringContaining("organizer"),
    });
  });

  it("fails closed with an offline error when the network request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      createAccountBindingInvite({
        circleId: CIRCLE,
        circleContract: CIRCLE_CONTRACT,
        memberRef: MEMBER,
        chain: "celo:42220",
        authorization: AUTHORIZATION,
      }),
    ).rejects.toMatchObject({ code: "offline" });
  });
});

describe("acceptAccountBindingInvite", () => {
  it("posts only the invite token and the caller's own account", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/api/account-bindings/accept");
      expect(JSON.parse(init.body as string)).toEqual({ inviteToken: "tok123", account: "celo:0xaa" });
      return jsonResponse(200, {
        binding: { circleId: CIRCLE, memberRef: MEMBER, chain: "celo:42220", account: "celo:0xaa", boundAt: "now" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await acceptAccountBindingInvite({ inviteToken: "tok123", account: "celo:0xaa" });
    expect(result.binding.account).toBe("celo:0xaa");
  });
});

describe("readAccountBindingStatus", () => {
  it("returns the reported status without expecting any account field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { status: "bound" })));
    const result = await readAccountBindingStatus({
      circleId: CIRCLE,
      circleContract: CIRCLE_CONTRACT,
      memberRef: MEMBER,
      authorization: AUTHORIZATION,
    });
    expect(result.status).toBe("bound");
  });

  it("propagates a non-organizer rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "wrong_signer" })));
    await expect(
      readAccountBindingStatus({
        circleId: CIRCLE,
        circleContract: CIRCLE_CONTRACT,
        memberRef: MEMBER,
        authorization: AUTHORIZATION,
      }),
    ).rejects.toMatchObject({ code: "wrong_signer" });
  });
});

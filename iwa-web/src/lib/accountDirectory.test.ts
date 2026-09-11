import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountBindingLookupError, createHttpMemberAccountDirectory } from "./accountDirectory";

const CIRCLE = "0x00000000000000000000000000000000000123";
const MEMBER = "m1";
const CHAIN = "celo:42220";
const ACCOUNT = "celo:0x00000000000000000000000000000000000000aa";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHttpMemberAccountDirectory", () => {
  it("resolves the binding when the service confirms an exact match", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(`/api/account-bindings/${CIRCLE}/${MEMBER}`);
      expect(url).toContain(`chain=${encodeURIComponent(CHAIN)}`);
      expect(url).toContain(`account=${encodeURIComponent(ACCOUNT)}`);
      return jsonResponse(200, {
        binding: { circleId: CIRCLE, memberRef: MEMBER, chain: CHAIN, account: ACCOUNT },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    const resolved = await dir.resolve(CIRCLE, MEMBER);
    expect(resolved).toEqual({ circleId: CIRCLE, memberRef: MEMBER, chain: CHAIN, account: ACCOUNT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves to null when the service reports 404 (missing binding)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "not_found" })));
    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    expect(await dir.resolve(CIRCLE, MEMBER)).toBeNull();
  });

  it("resolves to null (does not trust the network) if the returned binding does not actually match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          binding: { circleId: CIRCLE, memberRef: MEMBER, chain: CHAIN, account: "celo:0xdifferent" },
        }),
      ),
    );
    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    expect(await dir.resolve(CIRCLE, MEMBER)).toBeNull();
  });

  it("fails closed (throws, does not resolve to null) when the network request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    await expect(dir.resolve(CIRCLE, MEMBER)).rejects.toThrow(AccountBindingLookupError);
  });

  it("fails closed (throws) on an unexpected non-2xx, non-404 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "internal" })));
    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    await expect(dir.resolve(CIRCLE, MEMBER)).rejects.toThrow(AccountBindingLookupError);
  });

  it("fails closed (throws) on a malformed JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("not json");
        },
      })),
    );
    const dir = createHttpMemberAccountDirectory(CHAIN, ACCOUNT);
    await expect(dir.resolve(CIRCLE, MEMBER)).rejects.toThrow(AccountBindingLookupError);
  });
});

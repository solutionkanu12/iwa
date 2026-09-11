// compose.test.ts — proves the real composition root wires the Celo
// contribution flow to the durable, backend-backed directory, not the
// in-memory test stub.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContributionHistory } from "../../core/contributionHistory";
import type { Circle, ContributionObligation } from "../../core/domain/types";
import { composeCeloContributionService } from "./compose";
import { CNGN_MAINNET } from "./config";
import type { CeloCircleBinding } from "./contribution";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";

const PAYER = "0x00000000000000000000000000000000000000aa";
const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000bb";
const AMOUNT = "5000000";

const circle: Circle = {
  id: "circle-1",
  asset: "USDC",
  contributionAmount: AMOUNT,
  cadenceSeconds: 604_800,
  gracePeriodSeconds: 86_400,
  memberLimit: 3,
  currentRound: 1,
  status: "ACTIVE",
  payoutOrder: ["m1", "m2", "m3"],
};

const obligation: ContributionObligation = {
  circleId: "circle-1",
  round: 1,
  memberRef: "m1",
  dueAt: 1_000,
  graceEndsAt: 2_000,
  status: "PENDING",
};

const binding: CeloCircleBinding = {
  circleId: "circle-1",
  chainId: 42220,
  token: CNGN_MAINNET.address,
  circleContract: CIRCLE_CONTRACT,
  contributionAmount: AMOUNT,
};

function mockProvider(): CeloProviderLike {
  return {
    async request(args: { method: string; params?: unknown[] | object }) {
      if (args.method === "eth_chainId") return "0xa4ec";
      if (args.method === "eth_call") return "0x" + (10_000_000n).toString(16).padStart(64, "0");
      throw new Error(`unexpected ${args.method}`);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composeCeloContributionService", () => {
  it("uses the durable HTTP-backed directory, not an in-memory stub", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/api/account-bindings/circle-1/m1");
      expect(url).toContain(`account=${encodeURIComponent(`celo:${normalizeAddress(PAYER)}`)}`);
      return {
        status: 200,
        ok: true,
        json: async () => ({
          binding: {
            circleId: "circle-1",
            memberRef: "m1",
            chain: "celo:42220",
            account: `celo:${normalizeAddress(PAYER)}`,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = composeCeloContributionService(
      binding,
      mockProvider(),
      new ContributionHistory(),
      PAYER,
    );
    await service.prepare(circle, obligation, PAYER);

    // A network call reaching the real coordination service is proof this is
    // not InMemoryMemberAccountDirectory, which never touches the network.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still fails closed through composition when the backend has no binding for this wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 404, ok: false, json: async () => ({ error: "not_found" }) })),
    );
    const service = composeCeloContributionService(
      binding,
      mockProvider(),
      new ContributionHistory(),
      PAYER,
    );
    await expect(service.prepare(circle, obligation, PAYER)).rejects.toThrow(
      /no account is registered/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";

import { CeloRecoverService } from "./recovery";
import { encodeRecover } from "./circleCalldata";
import { IWA_CELO_ATTRIBUTION_TAG } from "./config";
import type { CeloProviderLike } from "./transactions";

const TAG = "celo_448874a99d90";
const CALLER = "0x00000000000000000000000000000000000000aa";
const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000bb";

function mockProvider(opts: { chainId?: string; sendError?: Error; receiptStatus?: string | null } = {}) {
  const sends: { method: string; params?: unknown }[] = [];
  const provider: CeloProviderLike & { sends: typeof sends } = {
    sends,
    async request(args: { method: string; params?: unknown[] | object }) {
      if (args.method === "eth_chainId") return opts.chainId ?? "0xa4ec";
      if (args.method === "eth_sendTransaction") {
        if (opts.sendError) throw opts.sendError;
        sends.push(args);
        return "0x" + "cd".repeat(32);
      }
      if (args.method === "eth_getTransactionReceipt") {
        if (opts.receiptStatus === null) return null;
        return { status: opts.receiptStatus ?? "0x1" };
      }
      throw new Error(`unexpected ${args.method}`);
    },
  };
  return provider;
}

function sentTx(provider: ReturnType<typeof mockProvider>) {
  return (provider.sends[0]?.params as { to: string; data: string; from: string }[])[0];
}

describe("CeloRecoverService", () => {
  it("sends recover(round) to the bound circle contract, tagged exactly once", async () => {
    const provider = mockProvider();
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    const result = await service.recover(CALLER, 3);

    expect(result.status).toBe("CONFIRMED");
    const tx = sentTx(provider);
    expect(tx.to.toLowerCase()).toBe(CIRCLE_CONTRACT.toLowerCase());
    expect(tx.from.toLowerCase()).toBe(CALLER.toLowerCase());
    expect(tx.data.startsWith(encodeRecover(3))).toBe(true);
    const decoded = fromDataSuffix(tx.data as `0x${string}`);
    expect(decoded?.codes.filter((c) => c === TAG)).toEqual([TAG]);
    expect(IWA_CELO_ATTRIBUTION_TAG).toBe(TAG);
  });

  it("encodes the round as the only argument: no destination or amount can be injected", () => {
    expect(encodeRecover(3)).toMatch(/^0x[0-9a-f]{72}$/);
    expect(encodeRecover(3)).not.toBe(encodeRecover(4));
  });

  it("rejects on the wrong network before sending anything", async () => {
    const provider = mockProvider({ chainId: "0xaa36a7" });
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    await expect(service.recover(CALLER, 3)).rejects.toThrow(/Celo mainnet/);
    expect(provider.sends).toHaveLength(0);
  });

  it("does not mark recovery complete when the wallet rejects", async () => {
    const provider = mockProvider({ sendError: new Error("user rejected") });
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    await expect(service.recover(CALLER, 3)).rejects.toThrow(/rejected/);
  });

  it("reports FAILED, not CONFIRMED, for a reverted transaction (e.g. double recovery)", async () => {
    const provider = mockProvider({ receiptStatus: "0x0" });
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    const result = await service.recover(CALLER, 3);
    expect(result.status).toBe("FAILED");
  });

  it("reports PENDING, not CONFIRMED, while no receipt exists yet", async () => {
    const provider = mockProvider({ receiptStatus: null });
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    const result = await service.recover(CALLER, 3);
    expect(result.status).toBe("PENDING");
  });

  it("refuses an untagged raw send through the adapter provider it wraps", async () => {
    const provider = mockProvider();
    const service = new CeloRecoverService({ circleContract: CIRCLE_CONTRACT }, provider);
    await service.recover(CALLER, 3);
    const wrapped = (service as unknown as { provider: CeloProviderLike }).provider;
    await expect(
      wrapped.request({ method: "eth_sendRawTransaction", params: ["0xdead"] }),
    ).rejects.toThrow(/raw/i);
  });

  it("normalizes the circle contract address at construction, refusing a malformed one", () => {
    expect(() => new CeloRecoverService({ circleContract: "not-an-address" }, mockProvider())).toThrow();
  });
});

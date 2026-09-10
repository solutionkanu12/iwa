// chains/celo/transactions.test.ts — the Celo send path must tag every
// transaction before it reaches the wallet. Tests use an in-memory
// provider; nothing is broadcast.

import { describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";

import { IWA_CELO_ATTRIBUTION_TAG } from "./config";
import { CeloTransactionAdapter } from "./adapter";
import {
  prepareCeloTransaction,
  sendCeloTransaction,
  wrapCeloProvider,
  type CeloProviderLike,
} from "./transactions";

const TAG = "celo_448874a99d90";
const TO = "0x0000000000000000000000000000000000000001";

function mockProvider() {
  const calls: { method: string; params?: unknown }[] = [];
  const provider: CeloProviderLike & { calls: typeof calls } = {
    calls,
    async request(args: { method: string; params?: unknown[] | object }) {
      calls.push(args);
      return "0xabc123";
    },
  };
  return provider;
}

function sentData(provider: ReturnType<typeof mockProvider>): string {
  const params = provider.calls[0]?.params as unknown[];
  const tx = params[0] as { data: string };
  return tx.data;
}

describe("prepareCeloTransaction", () => {
  it("writes tagged data and does not mutate the input transaction", () => {
    const tx = { to: TO, data: "0xa9059cbb" };
    const prepared = prepareCeloTransaction(tx);
    expect(tx.data).toBe("0xa9059cbb");
    expect(fromDataSuffix(prepared.data)?.codes).toEqual([TAG]);
    expect(prepared.to).toBe(TO);
    expect(IWA_CELO_ATTRIBUTION_TAG).toBe(TAG);
  });

  it("tags a value-only transfer that has no calldata", () => {
    const prepared = prepareCeloTransaction({ to: TO, value: "0x1" });
    expect(fromDataSuffix(prepared.data)?.codes.filter((c) => c === TAG)).toEqual([
      TAG,
    ]);
  });
});

describe("sendCeloTransaction", () => {
  it("sends only through eth_sendTransaction with the tag present once", async () => {
    const provider = mockProvider();
    const hash = await sendCeloTransaction(provider, { to: TO, data: "0x" });
    expect(hash).toBe("0xabc123");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.method).toBe("eth_sendTransaction");
    const decoded = fromDataSuffix(sentData(provider) as `0x${string}`);
    expect(decoded?.codes.filter((c) => c === TAG)).toHaveLength(1);
  });
});

describe("wrapCeloProvider", () => {
  it("tags eth_sendTransaction even if the caller omitted tagging", async () => {
    const inner = mockProvider();
    const wrapped = wrapCeloProvider(inner);
    await wrapped.request({
      method: "eth_sendTransaction",
      params: [{ to: TO, data: "0xa9059cbb" }],
    });
    expect(fromDataSuffix(sentData(inner) as `0x${string}`)?.codes).toContain(TAG);
  });

  it("tags every call in wallet_sendCalls", async () => {
    const inner = mockProvider();
    const wrapped = wrapCeloProvider(inner);
    await wrapped.request({
      method: "wallet_sendCalls",
      params: [
        {
          calls: [
            { to: TO, data: "0x" },
            { to: TO, data: "0xa9059cbb" },
          ],
        },
      ],
    });
    const batch = (inner.calls[0]?.params as unknown[])[0] as {
      calls: { data: string }[];
    };
    expect(batch.calls).toHaveLength(2);
    for (const call of batch.calls) {
      expect(
        fromDataSuffix(call.data as `0x${string}`)?.codes.filter((c) => c === TAG),
      ).toHaveLength(1);
    }
  });

  it("refuses eth_sendRawTransaction so signed untagged bytes cannot bypass the adapter", async () => {
    const wrapped = wrapCeloProvider(mockProvider());
    await expect(
      wrapped.request({ method: "eth_sendRawTransaction", params: ["0xdead"] }),
    ).rejects.toThrow(/raw/i);
  });

  it("does not tag read methods", async () => {
    const inner = mockProvider();
    const wrapped = wrapCeloProvider(inner);
    await wrapped.request({
      method: "eth_call",
      params: [{ to: TO, data: "0xa9059cbb" }, "latest"],
    });
    const tx = (inner.calls[0]?.params as unknown[])[0] as { data: string };
    expect(tx.data).toBe("0xa9059cbb");
  });
});

describe("CeloTransactionAdapter", () => {
  it("is the send path and always attributes", async () => {
    const inner = mockProvider();
    const adapter = new CeloTransactionAdapter(inner);
    await adapter.send({ to: TO });
    expect(fromDataSuffix(sentData(inner) as `0x${string}`)?.codes).toEqual([TAG]);
  });

  it("does not expose an untagged send method", () => {
    expect(Object.getOwnPropertyNames(CeloTransactionAdapter.prototype)).toEqual(
      expect.arrayContaining(["constructor", "send", "prepare"]),
    );
    expect(Object.getOwnPropertyNames(CeloTransactionAdapter.prototype)).not.toContain(
      "sendRaw",
    );
    expect(Object.getOwnPropertyNames(CeloTransactionAdapter.prototype)).not.toContain(
      "sendUntagged",
    );
  });
});

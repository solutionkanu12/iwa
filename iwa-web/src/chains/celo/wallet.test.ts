import { describe, expect, it, vi } from "vitest";

import {
  connectCeloWallet,
  EXPECTED_CELO_CHAIN_ID,
  switchToCeloMainnet,
} from "./wallet";
import type { EthereumProviderLike } from "../ethereum/wallet";

function mockProvider(chainIdHex: string, accounts: string[] = ["0xabc"]) {
  const calls: { method: string; params?: unknown }[] = [];
  const provider: EthereumProviderLike = {
    async request(args) {
      calls.push(args);
      if (args.method === "eth_requestAccounts") return accounts;
      if (args.method === "eth_chainId") return chainIdHex;
      return null;
    },
  };
  return { provider, calls };
}

describe("EXPECTED_CELO_CHAIN_ID", () => {
  it("is Celo mainnet, 42220", () => {
    expect(EXPECTED_CELO_CHAIN_ID).toBe(42220n);
  });
});

describe("connectCeloWallet", () => {
  it("reports connected when the wallet is already on Celo mainnet", async () => {
    const { provider } = mockProvider("0xa4ec"); // 42220
    vi.stubGlobal("window", { ethereum: provider });
    await expect(connectCeloWallet()).resolves.toBe("connected");
    vi.unstubAllGlobals();
  });

  it("reports wrongNetwork when the wallet is on a different chain", async () => {
    const { provider } = mockProvider("0x1"); // Ethereum mainnet
    vi.stubGlobal("window", { ethereum: provider });
    await expect(connectCeloWallet()).resolves.toBe("wrongNetwork");
    vi.unstubAllGlobals();
  });

  it("throws when no wallet is present", async () => {
    vi.stubGlobal("window", {});
    await expect(connectCeloWallet()).rejects.toThrow(/no wallet/i);
    vi.unstubAllGlobals();
  });
});

describe("switchToCeloMainnet", () => {
  it("asks the wallet to switch to Celo mainnet's chain id", async () => {
    const { provider, calls } = mockProvider("0xa4ec");
    await switchToCeloMainnet(provider);
    expect(calls).toEqual([
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4ec" }] },
    ]);
  });

  it("adds the Celo chain when the wallet does not recognize it (error code 4902)", async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const provider: EthereumProviderLike = {
      async request(args) {
        calls.push(args);
        if (args.method === "wallet_switchEthereumChain") {
          const err = new Error("unrecognized chain") as Error & { code: number };
          err.code = 4902;
          throw err;
        }
        return null;
      },
    };
    await switchToCeloMainnet(provider);
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("wallet_addEthereumChain");
    const params = calls[1].params as { chainId: string; rpcUrls: string[] }[];
    expect(params[0].chainId).toBe("0xa4ec");
    expect(params[0].rpcUrls).toEqual(["https://forno.celo.org"]);
  });

  it("rethrows any other error (e.g. the visitor declined)", async () => {
    const provider: EthereumProviderLike = {
      async request() {
        const err = new Error("User rejected the request") as Error & { code: number };
        err.code = 4001;
        throw err;
      },
    };
    await expect(switchToCeloMainnet(provider)).rejects.toThrow(/rejected/);
  });
});

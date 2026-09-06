// The EVM connection must be reused, not re-prompted.
//
// Ordinary Prize Savings actions — reading the pool, building an encrypted
// deposit, decrypting a balance, claiming, withdrawing — already hold a
// connection. None of them may call eth_requestAccounts, which re-opens the
// wallet's account prompt. Only the explicit connect/switch actions may ask
// for an account, and they live in exactly one place: the wallet manager's
// connect seam.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the EVM connection is reused", () => {
  const prizePaths = [
    "features/prizeSavings/contracts.ts",
    "features/prizeSavings/zama.ts",
    "screens/PrizeSavingsView.tsx",
  ];

  it("the Prize Savings surface never asks for an account itself", () => {
    for (const file of prizePaths) {
      expect(code(read(file)), file).not.toContain("eth_requestAccounts");
    }
  });

  it("account requests live only in the Ethereum adapter", () => {
    const manager = code(read("app/WalletProvider.tsx"));
    const adapter = code(read("chains/ethereum/wallet.ts"));
    expect(manager).not.toContain("eth_requestAccounts");
    expect(adapter).toContain("eth_requestAccounts");
  });

  it("ordinary actions use the connection already held", () => {
    const contracts = code(read("features/prizeSavings/contracts.ts"));
    expect(contracts).toContain("eip1193Provider()");
    expect(contracts).not.toContain("eth_requestAccounts");
  });

  it("decrypting a balance signs typed data, not a fresh account request", () => {
    const zama = code(read("features/prizeSavings/zama.ts"));
    expect(zama).toContain("signTypedDataV4");
    expect(zama).not.toContain("eth_requestAccounts");
  });
});

describe("connecting one chain does not clear the other", () => {
  const manager = code(read("app/WalletProvider.tsx"));

  it("connecting EVM preserves Starknet", () => {
    const fn = manager.slice(manager.indexOf("const connectEthereum"), manager.indexOf("const switchToSepolia"));
    expect(fn.length).toBeGreaterThan(40);
    expect(fn).not.toContain("setSession");
    expect(fn).not.toContain("disconnectWallet");
  });

  it("connecting Starknet preserves EVM", () => {
    const fn = manager.slice(manager.indexOf("const connect ="), manager.indexOf("const disconnect ="));
    expect(fn.length).toBeGreaterThan(40);
    expect(fn).not.toContain("setEvm");
    expect(fn).not.toContain("disconnectEthereum");
  });
});
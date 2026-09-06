// screens/prizeSavingsGate.test.tsx — the Prize Savings EVM gate.
//
// Prize Savings runs on an EVM chain. A Starknet-only saver must be met with
// a clean gate that asks for the EVM wallet without ever touching their
// Starknet connection, and an EVM wallet on the wrong network must be told
// exactly which action fixes it. The gate is driven by the shared wallet
// manager's EVM slot.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/WalletProvider", () => ({
  useWallet: () => mockWallet,
}));

vi.mock("../features/prizeSavings/zama", () => ({
  encryptUint64: vi.fn(),
  userDecryptUint64: vi.fn(),
}));

vi.mock("../features/prizeSavings/contracts", () => ({
  creditedHandleOf: vi.fn(),
  isOperator: vi.fn(),
  isPoolOwner: vi.fn(),
  mintMockUSD: vi.fn(),
  readPool: vi.fn(),
  readUserState: vi.fn(),
  sendPoolNoArg: vi.fn(),
  sendPoolOwnerNoArg: vi.fn(),
  sendPoolOwnerTx: vi.fn(),
  sendPoolTx: vi.fn(),
  setOperator: vi.fn(),
  wrapMockUSD: vi.fn(),
  ZERO_HANDLE: "0x0",
}));

import { PrizeSavingsView } from "./PrizeSavingsView";
import type { WalletState } from "../app/WalletProvider";
import type { EvmWalletState } from "../lib/evmWallet";

const SEPOLIA = 11155111n;

function walletState(evm: EvmWalletState, starknetAddress: string | null): WalletState {
  return {
    address: starknetAddress,
    onExpectedChain: starknetAddress !== null,
    identity: null,
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    ensureIdentity: vi.fn(),
    evm,
    connectEthereum: vi.fn(),
    switchToSepolia: vi.fn(),
    disconnectEthereum: vi.fn(),
  };
}

let mockWallet: WalletState;

beforeEach(() => {
  mockWallet = walletState({ status: "disconnected", address: null, chainId: null }, null);
});

function render(): string {
  return renderToStaticMarkup(<PrizeSavingsView />);
}

describe("the Prize Savings EVM gate", () => {
  it("gates a Starknet-only user behind an EVM connection", () => {
    mockWallet = walletState(
      { status: "disconnected", address: null, chainId: null },
      "0x4099b8ebd6e6c642",
    );
    const html = render();
    expect(html).toContain("Prize Savings uses an EVM-compatible wallet.");
    expect(html).toContain("Connect an EVM wallet to use Prize Savings.");
    expect(html).toContain("Your Starknet wallet will stay connected.");
    expect(html).toContain("Connect EVM wallet");
  });

  it("asks an EVM wallet on the wrong network to switch to Sepolia", () => {
    mockWallet = walletState(
      { status: "wrongNetwork", address: "0xabc", chainId: 1n },
      "0x4099b8ebd6e6c642",
    );
    const html = render();
    expect(html).toContain("Prize Savings currently runs on Ethereum Sepolia.");
    expect(html).toContain("Switch to Sepolia");
  });

  it("shows the feature for a correctly connected EVM wallet", () => {
    mockWallet = walletState(
      { status: "connected", address: "0xabc", chainId: SEPOLIA },
      null,
    );
    const html = render();
    expect(html).not.toContain("Connect EVM wallet");
    expect(html).not.toContain("Switch to Sepolia");
    expect(html).toContain("Reading the pool");
  });

  it("shows the feature when both wallets are connected", () => {
    mockWallet = walletState(
      { status: "connected", address: "0xabc", chainId: SEPOLIA },
      "0x4099b8ebd6e6c642",
    );
    const html = render();
    expect(html).not.toContain("Connect EVM wallet");
    expect(html).not.toContain("Switch to Sepolia");
    expect(html).toContain("Reading the pool");
  });

  it("keeps the Starknet wallet untouched by the gate", () => {
    mockWallet = walletState(
      { status: "disconnected", address: null, chainId: null },
      "0x4099b8ebd6e6c642",
    );
    expect(render()).toContain("Your Starknet wallet will stay connected.");
  });

  it("does not repeat the older connect line once the EVM gate is showing", () => {
    mockWallet = walletState(
      { status: "disconnected", address: null, chainId: null },
      "0x4099b8ebd6e6c642",
    );
    const html = render();
    expect(html).toContain("Connect an EVM wallet to use Prize Savings.");
    expect(html).not.toContain("Connect an Ethereum wallet to take part.");
  });
});
// screens/CeloCircleView.test.tsx — the Celo wallet gate and initial state.
//
// renderToStaticMarkup does not run effects, so only the synchronous render
// is checked here: the gate copy for each disconnected wallet state, and the
// loading state a correctly connected wallet renders before its on-chain
// read resolves. This mirrors the depth of prizeSavingsGate.test.tsx for the
// same reason: a static render cannot observe state that only appears after
// an awaited effect.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/WalletProvider", () => ({
  useWallet: () => mockWallet,
}));

import { CeloCircleView } from "./CeloCircleView";
import type { WalletState } from "../app/WalletProvider";
import type { EvmWalletState } from "../lib/evmWallet";

const CIRCLE_CONTRACT = "0x" + "0".repeat(37) + "abc";

function walletState(celo: EvmWalletState): WalletState {
  return {
    address: null,
    onExpectedChain: false,
    identity: null,
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    ensureIdentity: vi.fn(),
    evm: { status: "disconnected", address: null, chainId: null },
    connectEthereum: vi.fn(),
    switchToSepolia: vi.fn(),
    disconnectEthereum: vi.fn(),
    celo,
    connectCelo: vi.fn(),
    switchToCeloMainnet: vi.fn(),
    disconnectCelo: vi.fn(),
  };
}

let mockWallet: WalletState;

function render(): string {
  return renderToStaticMarkup(<CeloCircleView circleContract={CIRCLE_CONTRACT} />);
}

describe("CeloCircleView wallet gate", () => {
  it("asks for a Celo wallet when none is found in the browser", () => {
    mockWallet = walletState({ status: "missing", address: null, chainId: null });
    const html = render();
    expect(html).toContain("A Celo wallet is needed");
  });

  it("asks a disconnected wallet to connect", () => {
    mockWallet = walletState({ status: "disconnected", address: null, chainId: null });
    const html = render();
    expect(html).toContain("Connect your Celo wallet");
    expect(html).toContain("Connect wallet");
  });

  it("asks a wallet on the wrong network to switch to Celo mainnet", () => {
    mockWallet = walletState({ status: "wrongNetwork", address: "0xabc", chainId: 1n });
    const html = render();
    expect(html).toContain("Switch to Celo mainnet");
    expect(html).toContain("Switch network");
  });

  it("shows a loading state for a correctly connected wallet, not the gate", () => {
    mockWallet = walletState({ status: "connected", address: "0xabc", chainId: 42220n });
    const html = render();
    expect(html).not.toContain("Connect wallet");
    expect(html).not.toContain("Switch network");
    expect(html).toContain("Reading the circle");
  });
});

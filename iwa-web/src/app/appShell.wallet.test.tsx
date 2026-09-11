// app/appShell.wallet.test.tsx — the shell's multichain wallet surface.
//
// The shell owns the chooser and the compact control. This pins the wiring:
// the disconnected visitor meets the Connect to Iwa chooser, the chooser
// offers both chains, and both chains' states render in the shell without one
// disturbing the other. The wallet itself is stubbed; what is asserted is the
// shell's behaviour against a wallet state.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./WalletProvider", () => ({
  useWallet: () => mockWallet,
}));

import { AppShell } from "./AppShell";
import type { Route } from "../lib/router";
import type { WalletState } from "./WalletProvider";
import type { EvmWalletState } from "../lib/evmWallet";

const connectedStarknet: EvmWalletState = { status: "disconnected", address: null, chainId: null };

function walletState(overrides: Partial<WalletState> = {}): WalletState {
  return {
    address: null,
    onExpectedChain: false,
    identity: null,
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    ensureIdentity: vi.fn(),
    evm: connectedStarknet,
    connectEthereum: vi.fn(),
    switchToSepolia: vi.fn(),
    disconnectEthereum: vi.fn(),
    celo: connectedStarknet,
    connectCelo: vi.fn(),
    switchToCeloMainnet: vi.fn(),
    disconnectCelo: vi.fn(),
    ...overrides,
  };
}

let mockWallet: WalletState;
const route: Route = { name: "home" };
const navigate = () => {};

beforeEach(() => {
  mockWallet = walletState();
});

function renderShell(): string {
  return renderToStaticMarkup(
    <AppShell route={route} navigate={navigate}>
      <div />
    </AppShell>,
  );
}

describe("the shell's wallet surface", () => {
  it("offers Connect to Iwa when nothing is connected", () => {
    const html = renderShell();
    expect(html).toContain("Connect to Iwa");
  });

  it("renders both chains once one is connected", () => {
    mockWallet = walletState({ address: "0x4099b8ebd6e6c642", onExpectedChain: true });
    const html = renderShell();
    expect(html).toContain("Starknet");
    expect(html).toContain("EVM");
  });

  it("shows the Starknet address the wallet reports", () => {
    mockWallet = walletState({ address: "0x4099b8ebd6e6c642", onExpectedChain: true });
    expect(renderShell()).toContain("0x409…");
  });

  it("keeps the EVM row independent when Starknet connects", () => {
    mockWallet = walletState({ address: "0x4099b8ebd6e6c642", onExpectedChain: true });
    const html = renderShell();
    expect(html).toContain("EVM");
    expect(html).toContain("Not connected");
  });

  it("keeps the Starknet row independent when EVM connects", () => {
    mockWallet = walletState({
      evm: { status: "connected", address: "0xabc", chainId: 11155111n },
    });
    const html = renderShell();
    expect(html).toContain("EVM");
    expect(html).toContain("Connected");
    expect(html).toContain("Not connected");
  });

  it("shows the EVM address on the phone bar when only EVM is connected", () => {
    mockWallet = walletState({
      evm: { status: "connected", address: "0xabcdef1234567890", chainId: 11155111n },
    });
    expect(renderShell()).toContain("0xabc…7890");
  });
});
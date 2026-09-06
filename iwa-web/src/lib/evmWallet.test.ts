// lib/evmWallet.test.ts — the chain-neutral wallet manager's Ethereum slot.
//
// One Iwa-level wallet manager owns two independent slots. This file pins the
// Ethereum slot: pure state transitions, no browser, no chain code. The
// Starknet slot is pinned by walletSession.test.ts. Both must move without
// touching each other — that independence is what makes Iwa multichain instead
// of two screens that each happen to use a wallet.

import { describe, expect, it } from "vitest";

import {
  DISCONNECTED,
  EXPECTED_SEPOLIA_CHAIN_ID,
  nextEvmState,
  snapshot,
  type EvmEvent,
  type EvmWalletState,
  type MultichainSnapshot,
} from "./evmWallet";

const A = "0xabc";
const B = "0xdef";
const SEPOLIA = 11155111n;
const MAINNET = 1n;

const connected: EvmWalletState = { status: "connected", address: A, chainId: SEPOLIA };

const apply = (state: EvmWalletState, event: EvmEvent): EvmWalletState =>
  nextEvmState(state, event, EXPECTED_SEPOLIA_CHAIN_ID);

describe("initial state", () => {
  it("starts disconnected, before any provider is read", () => {
    expect(DISCONNECTED).toEqual({ status: "disconnected", address: null, chainId: null });
  });

  it("expects the Prize Savings chain to be Sepolia", () => {
    expect(EXPECTED_SEPOLIA_CHAIN_ID).toBe(11155111n);
  });
});

describe("account changes", () => {
  it("follows the wallet to the new account", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(next.status).toBe("connected");
    expect(next.address).toBe(B);
  });

  it("keeps the chain id across an account change", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(next.chainId).toBe(SEPOLIA);
  });

  it("treats an empty account list as a disconnection", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [] });
    expect(next).toEqual(DISCONNECTED);
  });

  it("reports a connected wallet that moved to another network", () => {
    const next = apply(connected, { type: "networkChanged", chainId: MAINNET });
    expect(next.status).toBe("wrongNetwork");
    expect(next.chainId).toBe(MAINNET);
  });

  it("returns to connected when the wallet comes back to Sepolia", () => {
    const wrong = apply(connected, { type: "networkChanged", chainId: MAINNET });
    const back = apply(wrong, { type: "networkChanged", chainId: SEPOLIA });
    expect(back.status).toBe("connected");
    expect(back.address).toBe(A);
  });
});

describe("no auto-connect", () => {
  it("does not treat a network change as connected when no account is held", () => {
    const next = apply(DISCONNECTED, { type: "networkChanged", chainId: SEPOLIA });
    expect(next.status).toBe("disconnected");
    expect(next.address).toBeNull();
  });

  it("does not adopt an extension account until Iwa has connected the slot", () => {
    const next = apply(DISCONNECTED, { type: "accountsChanged", accounts: [A] });
    expect(next.status).toBe("disconnected");
    expect(next.address).toBeNull();
  });
});

describe("disconnection", () => {
  it("clears the address when the wallet disconnects outside the app", () => {
    const next = apply(connected, { type: "disconnected" });
    expect(next).toEqual(DISCONNECTED);
  });

  it("is idempotent", () => {
    expect(apply(DISCONNECTED, { type: "disconnected" })).toEqual(DISCONNECTED);
  });
});

describe("the multichain snapshot", () => {
  it("carries both slots independently", () => {
    const view: MultichainSnapshot = snapshot({
      starknet: {
        address: "0x4099",
        chainId: "0x534e5f4d41494e",
        identityAddress: "0x4099",
        onExpectedChain: true,
      },
      evm: connected,
    });
    expect(view.starknet.address).toBe("0x4099");
    expect(view.evm.status).toBe("connected");
    expect(view.evm.address).toBe(A);
  });

  it("lets one slot disconnect without touching the other", () => {
    const view: MultichainSnapshot = snapshot({
      starknet: {
        address: "0x4099",
        chainId: "0x534e5f4d41494e",
        identityAddress: "0x4099",
        onExpectedChain: true,
      },
      evm: DISCONNECTED,
    });
    expect(view.starknet.address).toBe("0x4099");
    expect(view.evm.status).toBe("disconnected");
    expect(view.evm.address).toBeNull();
  });
});
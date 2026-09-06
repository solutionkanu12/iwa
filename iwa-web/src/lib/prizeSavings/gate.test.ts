// lib/prizeSavings/gate.test.ts — the Prize Savings EVM gate.
//
// Prize Savings runs on Ethereum; circles and standing run on Starknet. A
// Starknet-only saver must be told, cleanly, that Prize Savings needs the EVM
// slot — without ever being asked to disconnect Starknet. A visitor whose EVM
// wallet is on the wrong network must be told exactly which action fixes it.
// This helper is the pure part of that gate: which message and which action,
// from which EVM state.

import { describe, expect, it } from "vitest";

import { evmGate, type EvmGate } from "./gate";

const SEPOLIA = 11155111n;
const MAINNET = 1n;

describe("evmGate", () => {
  it("is ready when the EVM wallet is connected on Sepolia", () => {
    const gate: EvmGate = evmGate({ status: "connected", address: "0xabc", chainId: SEPOLIA });
    expect(gate.kind).toBe("ready");
  });

  it("asks to connect when there is no EVM wallet to switch", () => {
    const gate: EvmGate = evmGate({ status: "missing", address: null, chainId: null });
    expect(gate.kind).toBe("connectEvm");
  });

  it("asks to connect when the EVM wallet is disconnected", () => {
    const gate: EvmGate = evmGate({ status: "disconnected", address: null, chainId: null });
    expect(gate.kind).toBe("connectEvm");
  });

  it("asks to switch to Sepolia when the EVM wallet is on another network", () => {
    const gate: EvmGate = evmGate({ status: "wrongNetwork", address: "0xabc", chainId: MAINNET });
    expect(gate.kind).toBe("switchSepolia");
  });

  it("is total: every EVM state maps to one gate", () => {
    const states: Parameters<typeof evmGate>[0][] = [
      { status: "missing", address: null, chainId: null },
      { status: "disconnected", address: null, chainId: null },
      { status: "wrongNetwork", address: "0xabc", chainId: MAINNET },
      { status: "connected", address: "0xabc", chainId: SEPOLIA },
    ];
    const kinds = states.map((s) => evmGate(s).kind);
    expect(kinds).toContain("connectEvm");
    expect(kinds).toContain("switchSepolia");
    expect(kinds).toContain("ready");
  });

  it("carries no other chain's state", () => {
    const gate: EvmGate = evmGate({ status: "connected", address: "0xabc", chainId: SEPOLIA });
    expect(gate).toEqual({ kind: "ready" });
  });
});
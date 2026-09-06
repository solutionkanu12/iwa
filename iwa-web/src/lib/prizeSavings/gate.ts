// lib/prizeSavings/gate.ts — the Prize Savings EVM gate, pure.
//
// Prize Savings runs on an EVM chain; savings circles and standing run on
// Starknet. A Starknet-only saver opening Prize Savings must be met with a
// clean gate before any feature control, and nothing about that gate may
// disturb the Starknet connection they already have. This module decides which
// gate (and therefore which action) an EVM wallet state calls for.
//
// Chain-neutral by construction: it reads only the wallet manager's EVM slot
// and says what the screen should do.

import type { EvmWalletState } from "../../lib/evmWallet";

export type EvmGate =
  /** The EVM slot is connected on the right network: show the feature. */
  | { kind: "ready" }
  /** No usable EVM connection: ask the visitor to connect one. */
  | { kind: "connectEvm" }
  /** EVM wallet is connected elsewhere: ask the visitor to switch to Sepolia. */
  | { kind: "switchSepolia" };

export function evmGate(evm: EvmWalletState): EvmGate {
  if (evm.status === "connected") return { kind: "ready" };
  if (evm.status === "wrongNetwork") return { kind: "switchSepolia" };
  return { kind: "connectEvm" };
}
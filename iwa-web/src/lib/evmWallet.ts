// lib/evmWallet.ts — the chain-neutral wallet manager's Ethereum slot.
//
// One Iwa-level wallet manager owns two independent connection slots: the
// Starknet slot that the savings circles settle through, and the Ethereum slot
// that Prize Savings runs on. They live side by side. Connecting one never
// requires or disturbs the other, and a change on one chain never re-derives
// the other chain's state.
//
// This module is the pure part of that seam: what the app believes about the
// EVM connection, and how that belief changes when the wallet reports an
// account change, a network change or a disconnection. It is deliberately
// chain-neutral. No RPC call, no provider object and no browser API appears
// here; the adapter that talks to the EIP-1193 provider lives in
// chains/ethereum/wallet.ts and reports through this module's event type.
//
// No private key, seed or viewing material ever passes through this module.

/** The network Iwa Prize Savings is deployed on (Ethereum Sepolia). */
export const EXPECTED_SEPOLIA_CHAIN_ID = 11155111n;

/** What the app believes about the EVM connection right now. */
export interface EvmWalletState {
  status: "missing" | "disconnected" | "wrongNetwork" | "connected";
  /** The connected account, or null until the wallet has been read. */
  address: string | null;
  /** The network the wallet reports, as a bigint chain id, or null. */
  chainId: bigint | null;
}

export const DISCONNECTED: EvmWalletState = {
  status: "disconnected",
  address: null,
  chainId: null,
};

/** Something that happened in the EVM wallet rather than in Iwa. */
export type EvmEvent =
  | { type: "accountsChanged"; accounts: string[] }
  | { type: "networkChanged"; chainId: bigint }
  | { type: "disconnected" };

/**
 * The state after something happened in the EVM wallet.
 *
 * Pure and total: every event maps every state to a state. An empty account
 * list is a disconnection (some wallets report it that way); a network the app
 * does not settle on is wrongNetwork, not a silent connected.
 */
export function nextEvmState(
  state: EvmWalletState,
  event: EvmEvent,
  expectedChainId: bigint,
): EvmWalletState {
  switch (event.type) {
    case "disconnected":
      return DISCONNECTED;

    case "accountsChanged": {
      const address = event.accounts[0] ?? null;
      if (address === null) return DISCONNECTED;
      // The extension reporting an account is not Iwa connecting. A
      // disconnected slot stays disconnected until the visitor asks.
      if (state.status === "disconnected" || state.status === "missing") {
        return state;
      }
      if (state.chainId === null) {
        // An account arrived before any chain was read: report connected only
        // once the network is known, so wrongNetwork is never mislabelled.
        return { ...state, address, status: "disconnected" };
      }
      const status = state.chainId === expectedChainId ? "connected" : "wrongNetwork";
      return { status, address, chainId: state.chainId };
    }

    case "networkChanged": {
      if (state.address === null) {
        return {
          ...state,
          chainId: event.chainId,
          status: state.status === "missing" ? "missing" : "disconnected",
        };
      }
      const status = event.chainId === expectedChainId ? "connected" : "wrongNetwork";
      return { status, address: state.address, chainId: event.chainId };
    }
  }
}

/** The Starknet slot's shape, as the manager sees it: chain-neutral only. */
export interface StarknetSlot {
  address: string | null;
  chainId: string | null;
  /** The account the member identity was derived from, or null. */
  identityAddress: string | null;
  onExpectedChain: boolean;
}

/** One view of both chain connections, independent of each other. */
export interface MultichainSnapshot {
  starknet: StarknetSlot;
  evm: EvmWalletState;
}

/**
 * The combined view the application renders against.
 *
 * The two slots are composed, never merged: a disconnection on one chain must
 * not read as a change on the other, and connecting a wallet on one must not
 * re-derive anything on the other.
 */
export function snapshot(slots: { starknet: StarknetSlot; evm: EvmWalletState }): MultichainSnapshot {
  return { starknet: slots.starknet, evm: slots.evm };
}
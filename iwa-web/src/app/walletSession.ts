// app/walletSession.ts — which account, on which network, and whose identity.
//
// The wallet is not ours. A person can change account in their extension,
// switch network, or disconnect, and none of that goes through Iwa. Until now
// nothing watched for it, so the app could go on showing an address the wallet
// had left behind and holding a member identity derived from it.
//
// That is not only untidy. The member identity marks which seat in a circle is
// yours; carried to another account it would mark somebody else's. So identity
// is tied to exactly one account on exactly one network and is dropped the
// moment either changes, rather than being repaired afterwards.
//
// The transitions live here, apart from React, because they are rules rather
// than rendering: pure, total, and checkable one case at a time.

/** What the app believes about the wallet right now. */
export interface WalletSessionState {
  address: string | null;
  chainId: string | null;
  /**
   * The account the member identity was derived from, or null when there is no
   * identity. Never merely a boolean: an identity belongs to one account, and
   * remembering which is what stops it being reused under another.
   */
  identityAddress: string | null;
  /** The wallet is on the network Iwa settles on. */
  onExpectedChain: boolean;
}

export type WalletEvent =
  | { type: "accountsChanged"; accounts: string[] }
  | { type: "networkChanged"; chainId: string }
  | { type: "disconnected" };

export const DISCONNECTED: WalletSessionState = {
  address: null,
  chainId: null,
  identityAddress: null,
  onExpectedChain: false,
};

/** Compares two felts by value, so padding and case do not matter. */
function sameFelt(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Whether two accounts are the same account. */
export function isSameAccount(a: string | null, b: string | null): boolean {
  return sameFelt(a, b);
}

/**
 * The account an identity may be used for, or null when there is none to use.
 *
 * A screen asks this rather than reading `identityAddress` directly, so the
 * check for "derived, and derived from the account we are actually on" happens
 * in one place.
 */
export function identityCacheFor(state: WalletSessionState): string | null {
  if (state.address === null || state.identityAddress === null) return null;
  return isSameAccount(state.address, state.identityAddress) ? state.identityAddress : null;
}

/**
 * The state after something happened in the wallet.
 *
 * Every branch that changes the account or the network drops the identity. It
 * is cheap to derive again, one signature, and cheap is the right price for
 * never being wrong about whose seat is whose.
 */
export function nextWalletState(
  state: WalletSessionState,
  event: WalletEvent,
  expectedChainId: string,
): WalletSessionState {
  switch (event.type) {
    case "disconnected":
      return DISCONNECTED;

    case "accountsChanged": {
      const next = event.accounts[0] ?? null;
      // Some wallets report an empty list to mean "no longer connected here".
      if (next === null) return DISCONNECTED;
      if (isSameAccount(state.address, next)) return state;
      return { ...state, address: next, identityAddress: null };
    }

    case "networkChanged": {
      const onExpectedChain = sameFelt(event.chainId, expectedChainId);
      // The identity is signed under a domain that names the chain, so it does
      // not carry across a network change even back to the same account.
      return { ...state, chainId: event.chainId, identityAddress: null, onExpectedChain };
    }
  }
}

/**
 * Whether a screen showing private data should load it again.
 *
 * The answer is no when the only thing that changed is that the identity became
 * available. That single case is what cost people a second wallet signature on
 * every private page: deriving the identity changed state the screen depended
 * on, so the read that triggered the derivation ran a second time and asked the
 * wallet again.
 *
 * A read is repeated when the question changes, not when the answer arrives.
 */
export function shouldReloadFor(before: WalletSessionState, after: WalletSessionState): boolean {
  if (!isSameAccount(before.address, after.address)) return true;
  if (before.address === null && after.address !== null) return true;
  if (before.address !== null && after.address === null) return true;
  if (before.onExpectedChain !== after.onExpectedChain) return true;
  if (!sameFelt(before.chainId, after.chainId) && (before.chainId ?? after.chainId) !== null) {
    return true;
  }
  return false;
}

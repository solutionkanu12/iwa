// The rules the wallet connection has to follow.
//
// Two problems these pin. The first cost people signatures: deriving the member
// identity changed state that screens depended on, so the read that triggered
// it ran again and asked the wallet a second time. The second is worse than a
// nuisance: nothing watched the wallet, so changing account in the extension
// left Iwa showing the old address and holding an identity derived from the
// wallet that was no longer connected.
//
// Both are about identity being tied to exactly one account on exactly one
// network, and being dropped the moment either changes.

import { describe, expect, it } from "vitest";

import {
  identityCacheFor,
  isSameAccount,
  nextWalletState,
  shouldReloadFor,
  type WalletEvent,
  type WalletSessionState,
} from "./walletSession";

const A = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const B = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const SN_MAIN = "0x534e5f4d41494e";
const SEPOLIA = "0x534e5f5345504f4c4941";

const connected: WalletSessionState = {
  address: A,
  chainId: SN_MAIN,
  identityAddress: A,
  onExpectedChain: true,
};

const disconnected: WalletSessionState = {
  address: null,
  chainId: null,
  identityAddress: null,
  onExpectedChain: false,
};

const apply = (state: WalletSessionState, event: WalletEvent) => nextWalletState(state, event, SN_MAIN);

describe("account changes", () => {
  it("follows the wallet to the new account", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(next.address).toBe(B);
  });

  // The identity is derived from one account's signature. Carrying it to
  // another account would mark somebody else's seat as yours.
  it("drops the identity derived from the previous account", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(next.identityAddress).toBeNull();
  });

  it("never lets the new account inherit the old identity", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(next.identityAddress).not.toBe(A);
    expect(identityCacheFor(next)).toBeNull();
  });

  it("keeps the identity when the same account is reported again", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [A] });
    expect(next.identityAddress).toBe(A);
    expect(next.address).toBe(A);
  });

  it("compares accounts by value, not by how they were written", () => {
    expect(isSameAccount("0x04099b8eb", "0x4099b8eb")).toBe(true);
    expect(isSameAccount("0x4099B8EB", "0x4099b8eb")).toBe(true);
    expect(isSameAccount(A, B)).toBe(false);
    expect(isSameAccount(null, A)).toBe(false);
    expect(isSameAccount(null, null)).toBe(false);
  });

  it("treats an empty account list as a disconnection", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [] });
    expect(next.address).toBeNull();
    expect(next.identityAddress).toBeNull();
  });

  it("reloads private data when the account changes", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(shouldReloadFor(connected, next)).toBe(true);
  });

  it("does not reload when nothing about the account changed", () => {
    const next = apply(connected, { type: "accountsChanged", accounts: [A] });
    expect(shouldReloadFor(connected, next)).toBe(false);
  });
});

describe("network changes", () => {
  it("marks the wallet as being on the wrong network", () => {
    const next = apply(connected, { type: "networkChanged", chainId: SEPOLIA });
    expect(next.onExpectedChain).toBe(false);
    expect(next.chainId).toBe(SEPOLIA);
  });

  // The identity is signed under a domain carrying the chain, so it does not
  // survive a move to another network.
  it("drops the identity when the network changes", () => {
    const next = apply(connected, { type: "networkChanged", chainId: SEPOLIA });
    expect(next.identityAddress).toBeNull();
  });

  it("keeps the account connected, since the wallet still is", () => {
    const next = apply(connected, { type: "networkChanged", chainId: SEPOLIA });
    expect(next.address).toBe(A);
  });

  it("returns to a usable state when the wallet comes back to mainnet", () => {
    const wrong = apply(connected, { type: "networkChanged", chainId: SEPOLIA });
    const back = apply(wrong, { type: "networkChanged", chainId: SN_MAIN });
    expect(back.onExpectedChain).toBe(true);
    // The identity still has to be derived again: it was dropped, not hidden.
    expect(back.identityAddress).toBeNull();
  });

  it("compares chains by value", () => {
    const next = apply(connected, { type: "networkChanged", chainId: "0x534E5F4D41494E" });
    expect(next.onExpectedChain).toBe(true);
  });
});

describe("disconnection", () => {
  it("clears everything when the wallet disconnects outside the app", () => {
    const next = apply(connected, { type: "disconnected" });
    expect(next).toEqual(disconnected);
  });

  it("clears the identity cache with it", () => {
    expect(identityCacheFor(apply(connected, { type: "disconnected" }))).toBeNull();
  });

  it("is idempotent", () => {
    expect(apply(disconnected, { type: "disconnected" })).toEqual(disconnected);
  });
});

// What a screen is allowed to do with the wallet in each state. No amount of
// stale state may authorize anything.
describe("what may be done in each state", () => {
  it("allows nothing private without an account", () => {
    expect(disconnected.address).toBeNull();
    expect(identityCacheFor(disconnected)).toBeNull();
  });

  it("allows nothing that assumes mainnet while on another network", () => {
    const wrong = apply(connected, { type: "networkChanged", chainId: SEPOLIA });
    expect(wrong.onExpectedChain).toBe(false);
  });

  it("only reports an identity for the account it was derived from", () => {
    expect(identityCacheFor(connected)).toBe(A);
    const moved = apply(connected, { type: "accountsChanged", accounts: [B] });
    expect(identityCacheFor(moved)).toBeNull();
  });
});

// The loop that cost the extra signatures: deriving identity changed state
// screens depended on, so the read reran. The state a screen depends on must
// only change when the answer would actually differ.
describe("private reads do not repeat themselves", () => {
  it("does not ask a screen to reload merely because identity arrived", () => {
    const before: WalletSessionState = { ...connected, identityAddress: null };
    const after: WalletSessionState = { ...connected, identityAddress: A };
    expect(shouldReloadFor(before, after)).toBe(false);
  });

  it("asks a screen to reload when the account changes", () => {
    expect(shouldReloadFor(connected, { ...connected, address: B, identityAddress: null })).toBe(
      true,
    );
  });

  it("asks a screen to reload when the wallet disconnects", () => {
    expect(shouldReloadFor(connected, disconnected)).toBe(true);
  });

  it("asks a screen to reload when the network changes", () => {
    expect(
      shouldReloadFor(connected, { ...connected, chainId: SEPOLIA, onExpectedChain: false }),
    ).toBe(true);
  });

  it("does not ask a screen to reload for an unrelated change", () => {
    expect(shouldReloadFor(connected, { ...connected })).toBe(false);
  });
});

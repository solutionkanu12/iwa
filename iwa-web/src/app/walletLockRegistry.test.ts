import { describe, expect, it, vi } from "vitest";

import { createWalletLockRegistry } from "./walletLockRegistry";

describe("Iwa session to wallet lock boundary", () => {
  it("locks each registered local vault exactly once and supports safe unregister", () => {
    const locks = createWalletLockRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = locks.register(first);
    locks.register(second);

    locks.lockAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unregisterFirst();
    locks.lockAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("contains one local lock callback failure so other vault lifecycles still cold-lock", () => {
    const locks = createWalletLockRegistry();
    const later = vi.fn();
    locks.register(() => { throw new Error("local lifecycle failure"); });
    locks.register(later);

    expect(() => locks.lockAll()).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
  });
});

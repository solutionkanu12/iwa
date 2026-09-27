/**
 * A narrow boundary from Iwa Account lifecycle events to locally held wallet
 * authority. Account code knows only how to request a lock; it never receives
 * a vault, passkey, session capability, or secret.
 */
export interface WalletLockRegistry {
  register(lock: () => void): () => void;
  lockAll(): void;
}

export function createWalletLockRegistry(): WalletLockRegistry {
  const locks = new Set<() => void>();
  return {
    register(lock) {
      locks.add(lock);
      return () => {
        locks.delete(lock);
      };
    },
    lockAll() {
      for (const lock of locks) {
        try {
          lock();
        } catch {
          // A best-effort local cleanup error must not let another registered
          // lifecycle retain a warm session. No error is logged here because
          // a wallet implementation must never serialize secret context.
        }
      }
    },
  };
}

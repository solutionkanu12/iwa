import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { currentBrowserWalletPasskey } from "../lib/walletVault/passkey";
import { IndexedDbVaultStore } from "../lib/walletVault/vaultStore";
import {
  IwaWalletVaultLifecycle,
  type ProvisionLocalVaultInput,
  type PublicWalletVaultState,
  type UnlockLocalVaultInput,
} from "./iwaWalletVaultLifecycle";
import { useIwaAuth } from "./IwaAuthProvider";

export interface IwaWalletVaultState {
  readonly view: PublicWalletVaultState;
  inspect(walletId: string): Promise<PublicWalletVaultState>;
  provision(input: ProvisionLocalVaultInput): Promise<void>;
  unlock(input: UnlockLocalVaultInput): Promise<void>;
  lock(): void;
}

const IwaWalletVaultContext = createContext<IwaWalletVaultState | null>(null);

function productionLifecycle(): IwaWalletVaultLifecycle {
  return new IwaWalletVaultLifecycle({
    openStore: () => IndexedDbVaultStore.open(),
    createPasskey: () => currentBrowserWalletPasskey(),
    // An RP ID must be an origin host, never a URL, path, account email, or
    // server-provided value. Browser WalletPasskey validates it again.
    rpId: () => window.location.hostname,
  });
}

/**
 * Owns the B1-B empty local vault container. It intentionally sits inside the
 * Iwa account provider only to receive lock notifications; account identity
 * neither unlocks the vault nor receives its passkey or decrypted state.
 */
export function IwaWalletVaultProvider({ children }: { children: ReactNode }) {
  const auth = useIwaAuth();
  const lifecycleRef = useRef<IwaWalletVaultLifecycle | null>(null);
  if (lifecycleRef.current === null) lifecycleRef.current = productionLifecycle();
  const lifecycle = lifecycleRef.current;
  const [view, setView] = useState<PublicWalletVaultState>(() => lifecycle.view());

  const lock = useCallback(() => {
    lifecycle.lock();
    setView(lifecycle.view());
  }, [lifecycle]);

  const inspect = useCallback(async (walletId: string) => {
    const next = await lifecycle.inspect(walletId);
    setView(next);
    return next;
  }, [lifecycle]);

  const provision = useCallback(async (input: ProvisionLocalVaultInput) => {
    try {
      await lifecycle.provision(input);
    } finally {
      setView(lifecycle.view());
    }
  }, [lifecycle]);

  const unlock = useCallback(async (input: UnlockLocalVaultInput) => {
    try {
      await lifecycle.unlock(input);
    } finally {
      setView(lifecycle.view());
    }
  }, [lifecycle]);

  useEffect(() => auth.registerWalletLock(lock), [auth, lock]);

  useEffect(() => {
    // A refresh/restart starts from cold memory. `pagehide` explicitly drops a
    // live session before browser teardown. We intentionally do not lock on a
    // short `visibilitychange`: WalletVault's idle timeout remains the bounded
    // warm-session control without breaking routine tab switches.
    const onPageHide = () => lock();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      lock();
    };
  }, [lock]);

  useEffect(() => {
    if (auth.phase !== "authenticated") lock();
  }, [auth.phase, lock]);

  const value = useMemo<IwaWalletVaultState>(
    () => ({ view, inspect, provision, unlock, lock }),
    [view, inspect, provision, unlock, lock],
  );
  return <IwaWalletVaultContext.Provider value={value}>{children}</IwaWalletVaultContext.Provider>;
}

export function useIwaWalletVault(): IwaWalletVaultState {
  const value = useContext(IwaWalletVaultContext);
  if (value === null) throw new Error("useIwaWalletVault must be used inside an IwaWalletVaultProvider");
  return value;
}

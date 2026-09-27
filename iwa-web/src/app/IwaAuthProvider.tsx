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

import { iwaAccount, IwaAccountError, type SessionView } from "../lib/iwaAccount";
import { authPhase, type AuthPhase, type IwaUser } from "./iwaAuthGate";
import { createWalletLockRegistry } from "./walletLockRegistry";

export interface IwaAuthState {
  phase: AuthPhase;
  user: IwaUser | null;
  error: string | null;
  refresh: () => Promise<SessionView | null>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  /** Registers a local wallet lock action without exposing wallet authority to account state. */
  registerWalletLock: (lock: () => void) => () => void;
}

const IwaAuthContext = createContext<IwaAuthState | null>(null);

export function IwaAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<IwaUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const walletLocks = useRef(createWalletLockRegistry());
  const currentUserId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const session = await iwaAccount.me();
      if (currentUserId.current !== null && currentUserId.current !== session.user.id) {
        walletLocks.current.lockAll();
      }
      if (session.user.status === "suspended") walletLocks.current.lockAll();
      currentUserId.current = session.user.id;
      setUser(session.user);
      setError(session.user.status === "suspended" ? "This Iwa account is suspended. Your on-chain funds are untouched." : null);
      return session;
    } catch (e) {
      walletLocks.current.lockAll();
      currentUserId.current = null;
      setUser(null);
      if (e instanceof IwaAccountError && e.code === "account_suspended") {
        setError(e.message);
      } else {
        setError(null);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    walletLocks.current.lockAll();
    currentUserId.current = null;
    try {
      await iwaAccount.logout();
    } finally {
      setUser(null);
      setError(null);
    }
  }, []);

  const logoutAll = useCallback(async () => {
    walletLocks.current.lockAll();
    currentUserId.current = null;
    try {
      await iwaAccount.logoutAll();
    } finally {
      setUser(null);
      setError(null);
    }
  }, []);

  const value = useMemo<IwaAuthState>(
    () => ({
      phase: authPhase({ loading, user }),
      user,
      error,
      refresh,
      logout,
      logoutAll,
      registerWalletLock: walletLocks.current.register,
    }),
    [loading, user, error, refresh, logout, logoutAll],
  );

  return <IwaAuthContext.Provider value={value}>{children}</IwaAuthContext.Provider>;
}

export function useIwaAuth(): IwaAuthState {
  const value = useContext(IwaAuthContext);
  if (value === null) throw new Error("useIwaAuth must be used inside an IwaAuthProvider");
  return value;
}

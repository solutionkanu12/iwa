import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { iwaAccount, IwaAccountError } from "../lib/iwaAccount";
import { authPhase, type AuthPhase, type IwaUser } from "./iwaAuthGate";

export interface IwaAuthState {
  phase: AuthPhase;
  user: IwaUser | null;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const IwaAuthContext = createContext<IwaAuthState | null>(null);

export function IwaAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<IwaUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const session = await iwaAccount.me();
      setUser(session.user);
      setError(session.user.status === "suspended" ? "This Iwa account is suspended. Your on-chain funds are untouched." : null);
    } catch (e) {
      setUser(null);
      if (e instanceof IwaAccountError && e.code === "account_suspended") {
        setError(e.message);
      } else {
        setError(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await iwaAccount.logout();
    } finally {
      setUser(null);
      setError(null);
    }
  }, []);

  const logoutAll = useCallback(async () => {
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

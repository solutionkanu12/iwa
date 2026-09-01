// app/WalletProvider.tsx — one connection, shared by the whole application.
//
// The wallet seam itself is unchanged: this holds no keys, opens no modal of
// its own, and adds no new chain behaviour. It exists because the connection
// used to belong to one screen, so the sidebar could not show it and every
// other screen had to ask for it again.
//
// Two things are deliberately separate.
//
// CONNECTING gives the app an address. It is cheap, and it is what the visitor
// asked for when they pressed Connect.
//
// IDENTITY is the member commitment, derived from a signature the wallet
// produces. It is what marks your seat in a circle and what signs a
// contribution. It costs a second prompt, so it is derived only when a screen
// actually needs it, never merely because the app rendered. The derivation
// itself caches, and the private half never leaves the tab.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  connectWallet,
  deriveMemberCommitment,
  disconnectWallet,
  WalletCancelledError,
  type MemberCommitment,
} from "../lib/starknetWallet";

export interface WalletState {
  address: string | null;
  /** Set once a screen has needed the member identity and the wallet signed. */
  identity: MemberCommitment | null;
  connecting: boolean;
  /** The last connection failure worth showing, or null. */
  error: string | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /**
   * The member identity, deriving it if this is the first time it is needed.
   * Returns null when there is no wallet or the wallet declined to sign.
   */
  ensureIdentity: () => Promise<MemberCommitment | null>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [identity, setIdentity] = useState<MemberCommitment | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (): Promise<string | null> => {
    setConnecting(true);
    setError(null);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      return addr;
    } catch (e) {
      // A cancelled modal is a decision, not a fault: no error is shown for it.
      if (!(e instanceof WalletCancelledError)) {
        setError(e instanceof Error ? e.message : "Could not connect your wallet.");
      }
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await disconnectWallet();
    setAddress(null);
    setIdentity(null);
    setError(null);
  }, []);

  const ensureIdentity = useCallback(async (): Promise<MemberCommitment | null> => {
    if (address === null) return null;
    if (identity !== null) return identity;
    try {
      const derived = await deriveMemberCommitment(address);
      setIdentity(derived);
      return derived;
    } catch {
      // Without a signature there is no membership to show. The public parts of
      // every screen still work, so this is not fatal.
      return null;
    }
  }, [address, identity]);

  const value = useMemo<WalletState>(
    () => ({ address, identity, connecting, error, connect, disconnect, ensureIdentity }),
    [address, identity, connecting, error, connect, disconnect, ensureIdentity],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (value === null) throw new Error("useWallet must be used inside a WalletProvider");
  return value;
}

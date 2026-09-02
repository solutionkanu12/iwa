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
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  connectWallet,
  deriveMemberCommitment,
  disconnectWallet,
  forgetIdentity,
  watchWallet,
  WalletCancelledError,
  type MemberCommitment,
} from "../lib/starknetWallet";
import { REQUIRED_CHAIN_ID } from "../chains/strk20/walletConnect";
import { identityCacheFor, nextWalletState, DISCONNECTED } from "./walletSession";

export interface WalletState {
  address: string | null;
  /** The wallet is on the network Iwa settles on. False while it is elsewhere. */
  onExpectedChain: boolean;
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
  const [session, setSession] = useState(DISCONNECTED);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The derived identity, held in a ref rather than in state.
   *
   * Deliberate. Deriving it used to set state, which changed the context value,
   * which changed the callbacks screens depend on, which re-ran the very read
   * that asked for the identity, which asked the wallet to sign a second time.
   * A ref lets the identity arrive without telling anybody to start again.
   *
   * Memory only, and never persisted: the private half of this must not touch
   * storage, and the whole thing is dropped whenever the account or the network
   * moves.
   */
  const identityRef = useRef<MemberCommitment | null>(null);

  /** Reads the latest session inside callbacks without depending on it. */
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const connect = useCallback(async (): Promise<string | null> => {
    setConnecting(true);
    setError(null);
    try {
      const addr = await connectWallet();
      setSession({
        address: addr,
        chainId: REQUIRED_CHAIN_ID,
        identityAddress: null,
        onExpectedChain: true,
      });
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
    identityRef.current = null;
    setSession(DISCONNECTED);
    setError(null);
  }, []);

  /**
   * Watches the wallet for things that did not go through Iwa.
   *
   * A person can change account, switch network or disconnect in their
   * extension. Until this existed none of it was noticed, so the app could keep
   * showing an address the wallet had left and keep an identity derived from
   * it. Every one of those drops the identity: it belongs to one account on one
   * network, and a stale one would mark somebody else's seat as yours.
   *
   * Nothing here initiates a transaction or asks for a signature. It only
   * forgets.
   */
  useEffect(() => {
    return watchWallet((event) => {
      setSession((current) => {
        const next = nextWalletState(current, event, REQUIRED_CHAIN_ID);
        if (next.identityAddress === null && current.identityAddress !== null) {
          identityRef.current = null;
          forgetIdentity();
        }
        if (next.address === null && current.address !== null) {
          identityRef.current = null;
          forgetIdentity();
        }
        return next;
      });
    });
  }, []);

  /**
   * The member identity, deriving it once if this is the first time it is
   * needed for the connected account.
   *
   * Stable across renders: it reads the session through a ref, so it does not
   * change when the identity arrives and does not restart whatever asked for
   * it. It refuses on the wrong network, since the identity is signed under a
   * domain that names the chain.
   */
  const ensureIdentity = useCallback(async (): Promise<MemberCommitment | null> => {
    const now = sessionRef.current;
    if (now.address === null || !now.onExpectedChain) return null;

    const usable = identityCacheFor({ ...now, identityAddress: now.address });
    if (identityRef.current !== null && usable !== null) return identityRef.current;

    try {
      const derived = await deriveMemberCommitment(now.address);
      // The account may have moved while the wallet was showing the prompt.
      if (!identityCacheFor({ ...sessionRef.current, identityAddress: now.address })) return null;
      identityRef.current = derived;
      setSession((c) => (c.identityAddress === now.address ? c : { ...c, identityAddress: now.address }));
      return derived;
    } catch {
      // Without a signature there is no membership to show. The public parts of
      // every screen still work, so this is not fatal.
      return null;
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address: session.address,
      onExpectedChain: session.onExpectedChain,
      identity: identityRef.current,
      connecting,
      error,
      connect,
      disconnect,
      ensureIdentity,
    }),
    // Deliberately not depending on the identity: it arriving must not restart
    // the read that asked for it. Screens that need it call ensureIdentity.
    [session.address, session.onExpectedChain, connecting, error, connect, disconnect, ensureIdentity],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (value === null) throw new Error("useWallet must be used inside a WalletProvider");
  return value;
}

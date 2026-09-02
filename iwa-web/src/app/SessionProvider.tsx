// app/SessionProvider.tsx — signing in, once, to read your own data.
//
// WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
//
// Every authenticated request used to carry its own wallet signature. That is
// the right shape for anything that changes something — a reorder, a creation
// record — and it stays exactly as it is. It was the wrong shape for looking at
// your own circles: opening three private pages asked for three signatures, and
// prompts a person stops reading are not consent.
//
// So one signature, saying session:create in the wallet, is exchanged for a
// read-only token. It authorizes reads of that wallet's own coordination data
// and nothing else. No mutation route will accept it, and the service is where
// that is enforced rather than here.
//
// WHERE THE TOKEN LIVES
//
// In memory, in a ref, for as long as this tab is open. Not localStorage, not
// sessionStorage, not a cookie, not the URL. A refresh loses it and costs one
// new signature, which is the right price: a bearer token that survives the tab
// is a bearer token that outlives the person's attention.
//
// The session is tied to one account on one network. Change either, or
// disconnect, and it ends here and on the service.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { backend, BackendError, type ReadAuth, type WalletSigner } from "../lib/backend";
import { currentWallet } from "../lib/starknetWallet";
import { useWallet } from "./WalletProvider";
import {
  createSessionHolder,
  shouldDropSession,
  type SessionBinding,
  type SessionHolder,
} from "./sessionHolder";

export interface SessionState {
  /**
   * Runs one private read, signing in first if this is the first that needs it.
   *
   * Reads only. Anything that changes state takes its own action-bound
   * signature and does not come through here.
   */
  authorizedRead: <T>(run: (auth: ReadAuth) => Promise<T>) => Promise<T>;
  /** Ends the session, here and on the service. */
  signOut: () => Promise<void>;
  /** Whether a session is held right now. For display only. */
  hasSession: () => boolean;
}

/**
 * The sign-in did not happen, so the private read could not either.
 *
 * Almost always because the person declined the wallet prompt, which is an
 * answer rather than a fault. It is a distinct type so a screen can say what
 * actually happened instead of reporting a generic failure to load, and so that
 * nothing is tempted to treat a refusal as something to retry.
 */
export class SignInRequiredError extends Error {
  constructor(readonly cause?: unknown) {
    super("Iwa needs your signature to show this. Approve the request in your wallet to continue.");
    this.name = "SignInRequiredError";
  }
}

const SessionContext = createContext<SessionState | null>(null);

/** Turns the connected wallet into the signer the API client expects. */
function walletSigner(): WalletSigner {
  return async (typedData) => {
    const wallet = currentWallet();
    if (wallet === null) throw new Error("Connect your wallet first.");
    const signature = await wallet.account.signMessage(typedData as never);
    return Array.isArray(signature) ? signature.map(String) : [String(signature)];
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address, onExpectedChain } = useWallet();

  /** The wallet as it is now, readable inside callbacks that never change. */
  const bindingRef = useRef<SessionBinding>({ address, onExpectedChain });
  bindingRef.current = { address, onExpectedChain };

  /**
   * The wallet this read should be made as, or null when there is none to make
   * it as.
   *
   * Straight after connecting, React has not re-rendered yet, so the state here
   * still says disconnected while the wallet seam already holds the live
   * connection. The seam is what just answered, so it is what to ask. Connecting
   * refuses a wallet that is not on mainnet, so a live connection that state has
   * not caught up with is a mainnet connection.
   *
   * This only decides which wallet is asked to sign. It never decides whose data
   * comes back: the service takes that from the signature or from the session
   * record, and has never taken it from a client claim.
   */
  const walletForRead = useCallback((): string | null => {
    const now = bindingRef.current;
    if (now.address === null) return currentWallet()?.address ?? null;
    return now.onExpectedChain ? now.address : null;
  }, []);

  const holderRef = useRef<SessionHolder | null>(null);
  if (holderRef.current === null) {
    holderRef.current = createSessionHolder({
      create: async () => {
        const signer = walletForRead();
        if (signer === null) return null;
        try {
          const created = await backend.createSession(signer, walletSigner());
          return created.token;
        } catch (e) {
          // A service with no session endpoint yet. Real during a deploy, when
          // the frontend is live before the API is. The caller signs each read
          // instead, exactly as it did before sessions existed, rather than
          // being locked out of its own data.
          if (e instanceof BackendError && (e.status === 404 || e.status === 503)) return null;
          throw e;
        }
      },
      revoke: (token) => backend.revokeSession(token),
    });
  }
  const holder = holderRef.current;

  /**
   * Ends the session whenever the wallet it belongs to changes.
   *
   * Account change, network change and disconnect all land here through the
   * wallet watcher. Local forgetting happens first and unconditionally; telling
   * the service is a courtesy that is allowed to fail.
   */
  const previousRef = useRef<SessionBinding>({ address, onExpectedChain });
  useEffect(() => {
    const before = previousRef.current;
    const after = { address, onExpectedChain };
    previousRef.current = after;
    if (shouldDropSession(before, after)) void holder.end();
  }, [address, onExpectedChain, holder]);

  const authorizedRead = useCallback(
    async <T,>(run: (auth: ReadAuth) => Promise<T>): Promise<T> => {
      const signer = walletForRead();
      if (signer === null) {
        throw new Error(
          bindingRef.current.address === null
            ? "Connect your wallet first."
            : "Switch your wallet to Starknet mainnet to see this.",
        );
      }

      // One prompt at most, shared by everything that asked at the same moment.
      // A refusal propagates to all of them and nothing here tries again: the
      // person said no, and asking again is how a prompt becomes noise.
      let token: string | null;
      try {
        token = await holder.ensure();
      } catch (e) {
        throw new SignInRequiredError(e);
      }
      const auth: ReadAuth =
        token !== null ? { session: token } : { address: signer, sign: walletSigner() };

      try {
        return await run(auth);
      } catch (e) {
        // The session ended while it was in hand: expired, revoked, or lost to
        // a restart of the service. Forgotten, so the next thing the person
        // asks for signs in again. Not retried here: one prompt per request
        // they actually made.
        if (token !== null && e instanceof BackendError && e.code === "session_invalid") {
          holder.clear();
        }
        throw e;
      }
    },
    [holder, walletForRead],
  );

  const value = useMemo<SessionState>(
    () => ({
      authorizedRead,
      signOut: () => holder.end(),
      hasSession: () => holder.current() !== null,
    }),
    [authorizedRead, holder],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession must be used inside a SessionProvider");
  return value;
}

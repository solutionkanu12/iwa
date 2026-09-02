// app/sessionHolder.ts — one sign-in, however many things ask for it.
//
// The rule this exists to enforce: a person is asked to sign in once, and only
// because they asked for something that needs it.
//
// Both halves matter. Several private reads can start at the same moment —
// a screen mounts, a sidebar counts invitations, a summary loads — and each of
// them independently needs a session. Without something in the middle, each
// opens its own wallet prompt, and a person who asked to see their circles is
// shown three signature requests they did not ask for. So the first call starts
// the sign-in and every caller that arrives while it is in flight waits on that
// same promise.
//
// And if the person declines, everyone waiting fails. Nothing retries. A
// refusal is an answer, and asking again because the first answer was no is how
// a prompt becomes something people click through without reading.
//
// This is deliberately free of React and of the network: it holds a token,
// dedupes the work that produces one, and forgets it on demand. What a token is
// and how one is obtained belong elsewhere.

/**
 * How a session is created and destroyed. Supplied by the provider so this
 * stays testable and knows nothing about HTTP.
 */
export interface SessionTransport {
  /**
   * Signs in. Resolves with the token, or with null when this backend has no
   * session endpoint — which is a real state during a deploy, and means the
   * caller should fall back to signing each read.
   *
   * Rejects when the person declined, or when the attempt genuinely failed.
   */
  create: () => Promise<string | null>;
  /** Ends a session on the server. Best effort; failure is not an error here. */
  revoke: (token: string) => Promise<void>;
}

export interface SessionHolder {
  /** The token held right now, without starting anything. */
  current(): string | null;
  /**
   * The token, signing in if there is not one yet. Null means this backend
   * offers no sessions and the caller should authorize the read some other way.
   */
  ensure(): Promise<string | null>;
  /** Forgets the token locally. Does not tell the server. */
  clear(): void;
  /** Forgets the token and tells the server, without waiting on the network. */
  end(): Promise<void>;
}

export function createSessionHolder(transport: SessionTransport): SessionHolder {
  let token: string | null = null;
  let pending: Promise<string | null> | null = null;

  /**
   * Which session era we are in.
   *
   * Bumped by every clear. A sign-in that was in flight when the wallet moved
   * belongs to the account that started it, so when it lands in a later era its
   * token is thrown away and revoked rather than adopted. Without this, changing
   * account mid-prompt would hand the new account the old one's session.
   */
  let era = 0;

  const clear = () => {
    era += 1;
    token = null;
  };

  return {
    current: () => token,

    ensure(): Promise<string | null> {
      if (token !== null) return Promise.resolve(token);
      if (pending !== null) return pending;

      const startedIn = era;
      const attempt = transport
        .create()
        .then((created) => {
          if (era !== startedIn) {
            // The wallet moved while the prompt was open. This token belongs to
            // an account we are no longer on, so it is destroyed rather than
            // used, and the caller is told there is no session.
            if (created !== null) void transport.revoke(created).catch(() => {});
            return null;
          }
          token = created;
          return created;
        })
        .finally(() => {
          // Cleared either way, so a later deliberate attempt can start. Note
          // that nothing here starts one: a refusal stays refused until a
          // person asks for something again.
          pending = null;
        });

      pending = attempt;
      return attempt;
    },

    clear,

    async end(): Promise<void> {
      const ending = token;
      clear();
      if (ending === null) return;
      // Revoking is a courtesy to the server, not a condition of signing out.
      // A person disconnecting on a train must not be left signed in because
      // the request could not be sent.
      try {
        await transport.revoke(ending);
      } catch {
        // Already forgotten locally, which is the part that protects them.
      }
    },
  };
}

/** What the session is tied to. Changing either of these ends it. */
export interface SessionBinding {
  address: string | null;
  onExpectedChain: boolean;
}

/** Compares two accounts by value, so padding and case do not matter. */
function isSameAccount(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/**
 * Whether the session in hand still belongs to the wallet in front of us.
 *
 * A session authorizes reads of one wallet's own coordination data. Carried to
 * another account it would show one person another's circles, so every change
 * of account ends it. So does every change of network: the session was minted
 * under a signature naming the chain, and a circle means something different on
 * a different one.
 *
 * Connecting from nothing also ends it, which costs nothing because there is
 * nothing to end, and is the honest reading of "the wallet changed".
 */
export function shouldDropSession(before: SessionBinding, after: SessionBinding): boolean {
  if (before.address === null && after.address === null) return false;
  if (before.address === null || after.address === null) return true;
  if (!isSameAccount(before.address, after.address)) return true;
  return before.onExpectedChain !== after.onExpectedChain;
}

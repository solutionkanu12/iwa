// lib/accountDirectory.ts — durable, chain-neutral MemberAccountDirectory.
//
// Backed by the coordination service's account-binding endpoints
// (backend/src/app.ts, table account_bindings). This is the production
// implementation of core/accountBinding.ts's MemberAccountDirectory: any
// chain adapter can use it, since chain/account are opaque strings it never
// interprets.
//
// Scoped to one (chain, account) pair at construction. resolve() only ever
// confirms "is this member bound to the account I already hold" — never
// "who holds this member's place" — matching the read endpoint's own
// privacy shape. A caller builds a fresh instance per connected wallet
// rather than sharing one across different wallets/accounts.
//
// Fails closed in both senses required by core/accountBinding.ts: a
// confirmed absence (no binding, or a binding for someone else) resolves to
// null; a failed lookup (network error, non-2xx, malformed response) throws
// rather than resolving to null, so "we could not check" is never reported
// identically to "we checked and there is nothing."

import type { MemberAccountBinding, MemberAccountDirectory } from "../core/accountBinding";

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");

export class AccountBindingLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBindingLookupError";
  }
}

interface AccountBindingResponse {
  binding?: MemberAccountBinding;
}

/**
 * Builds a MemberAccountDirectory backed by the real coordination service,
 * scoped to the given (chain, account). Use one instance per connected
 * wallet, not one shared across wallets.
 */
export function createHttpMemberAccountDirectory(
  chain: string,
  account: string,
): MemberAccountDirectory {
  return {
    async resolve(circleId: string, memberRef: string): Promise<MemberAccountBinding | null> {
      const path =
        `/api/account-bindings/${encodeURIComponent(circleId)}/${encodeURIComponent(memberRef)}` +
        `?chain=${encodeURIComponent(chain)}&account=${encodeURIComponent(account)}`;

      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
      } catch {
        throw new AccountBindingLookupError(
          "Account binding lookup failed: the coordination service could not be reached.",
        );
      }

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new AccountBindingLookupError(
          `Account binding lookup failed: unexpected response (${res.status}).`,
        );
      }

      let body: AccountBindingResponse;
      try {
        body = (await res.json()) as AccountBindingResponse;
      } catch {
        throw new AccountBindingLookupError("Account binding lookup failed: malformed response.");
      }

      const binding = body.binding;
      if (binding === undefined) return null;
      // The service only ever returns a binding that already matches chain
      // and account (see app.ts), but this does not trust that blindly.
      if (binding.chain !== chain || binding.account !== account) return null;
      return binding;
    },
  };
}

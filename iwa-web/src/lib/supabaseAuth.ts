import { createClient } from "@supabase/supabase-js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface AuthErrorLike {
  message?: string;
}

interface IwaSupabaseClient {
  auth: {
    signInWithOAuth(options: {
      provider: "google";
      options: { redirectTo: string; skipBrowserRedirect: true };
    }): Promise<{ data: { url: string | null }; error: AuthErrorLike | null }>;
    signInWithOtp(options: {
      email: string;
      options: { emailRedirectTo: string; shouldCreateUser: true };
    }): Promise<{ error: AuthErrorLike | null }>;
    exchangeCodeForSession(
      code: string,
      options?: { flowId: string },
    ): Promise<{
      data: { session: { access_token?: string } | null };
      error: AuthErrorLike | null;
    }>;
    verifyOtp(options: {
      token_hash?: string;
      token?: string;
      type: string;
      email?: string;
    }): Promise<{
      data: { session: { access_token?: string } | null };
      error: AuthErrorLike | null;
    }>;
  };
}

function isVerifierKey(key: string): boolean {
  return key.endsWith("-code-verifier");
}

/**
 * Supabase needs durable access to the PKCE verifier across a redirect. It
 * does not need to persist its session because Iwa immediately trades the
 * verified access token for an HttpOnly backend session.
 */
export function createPkceVerifierStorage(backing: StorageLike): StorageLike {
  return {
    getItem(key) {
      return isVerifierKey(key) ? backing.getItem(key) : null;
    },
    setItem(key, value) {
      if (isVerifierKey(key)) backing.setItem(key, value);
    },
    removeItem(key) {
      if (isVerifierKey(key)) backing.removeItem(key);
    },
  };
}

function authFailure(error: AuthErrorLike | null, fallback: string): Error {
  return new Error(error?.message ?? fallback);
}

export function createIwaSupabaseAuth(createAuthClient: () => IwaSupabaseClient) {
  return {
    async googleUrl(redirectTo: string): Promise<string> {
      const { data, error } = await createAuthClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error !== null) throw authFailure(error, "Google sign-in could not be started.");
      if (data.url === null || data.url.length === 0) {
        throw new Error("Google sign-in did not return a redirect URL.");
      }
      return data.url;
    },

    async requestEmail(email: string, redirectTo: string): Promise<void> {
      const { error } = await createAuthClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
      });
      if (error !== null) throw authFailure(error, "The sign-in email could not be sent.");
    },

    async exchangeCode(code: string, flowId?: string): Promise<string> {
      const { data, error } = await createAuthClient().auth.exchangeCodeForSession(
        code,
        flowId === undefined ? undefined : { flowId },
      );
      if (error !== null) throw authFailure(error, "The authorization code could not be exchanged.");
      const accessToken = data.session?.access_token;
      if (accessToken === undefined || accessToken.length === 0) {
        throw new Error("Supabase did not return a verified access token.");
      }
      return accessToken;
    },

    async verifyOtp(params: {
      token_hash?: string;
      token?: string;
      type: string;
      email?: string;
    }): Promise<string> {
      const { data, error } = await createAuthClient().auth.verifyOtp(params as never);
      if (error !== null) throw authFailure(error, "That confirmation link is invalid, expired, or has already been used.");
      const accessToken = data.session?.access_token;
      if (accessToken === undefined || accessToken.length === 0) {
        throw new Error("Supabase did not return a verified access token.");
      }
      return accessToken;
    },
  };
}

let browserClient: IwaSupabaseClient | null = null;

function createBrowserClient(): IwaSupabaseClient {
  if (browserClient !== null) return browserClient;
  if (typeof window === "undefined") throw new Error("Supabase Auth requires a browser.");

  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) throw new Error("Iwa account sign-in is not configured.");

  browserClient = createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: createPkceVerifierStorage(window.localStorage),
      experimental: { appendPkceFlowIdToRedirects: true },
    },
  });
  return browserClient;
}

export const iwaSupabaseAuth = createIwaSupabaseAuth(createBrowserClient);

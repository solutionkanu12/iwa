import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { authPhase, requiresIwaSession, type IwaUser } from "./iwaAuthGate";
import { accessTokenFromLocation } from "../lib/iwaAccount";

const user: IwaUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ada@example.com",
  status: "active",
};

describe("authPhase", () => {
  it("stays on loading until the session check finishes, even with no user yet", () => {
    expect(authPhase({ loading: true, user: null })).toBe("loading");
    expect(authPhase({ loading: true, user })).toBe("loading");
  });

  it("shows the auth screen when there is no session", () => {
    expect(authPhase({ loading: false, user: null })).toBe("unauthenticated");
  });

  it("enters Iwa when a valid session is present", () => {
    expect(authPhase({ loading: false, user })).toBe("authenticated");
  });

  it("does not enter Iwa when the account is suspended", () => {
    expect(authPhase({ loading: false, user: { ...user, status: "suspended" } })).toBe(
      "suspended",
    );
  });
});

describe("which routes need an Iwa session", () => {
  it("keeps the landing page, invites and the OAuth callback public", () => {
    expect(requiresIwaSession("landing")).toBe(false);
    expect(requiresIwaSession("invite")).toBe(false);
    expect(requiresIwaSession("celoBindInvite")).toBe(false);
    expect(requiresIwaSession("authCallback")).toBe(false);
    expect(requiresIwaSession("console")).toBe(false);
  });

  it("gates the application itself", () => {
    expect(requiresIwaSession("home")).toBe(true);
    expect(requiresIwaSession("myCircles")).toBe(true);
    expect(requiresIwaSession("admin")).toBe(true);
    expect(requiresIwaSession("prizeSavings")).toBe(true);
    expect(requiresIwaSession("celoCircle")).toBe(true);
  });
});

describe("OAuth callback token extraction", () => {
  it("reads the legacy access token only from the fragment", () => {
    expect(accessTokenFromLocation("#access_token=abc&type=magiclink", "")).toBe("abc");
    expect(accessTokenFromLocation("", "?access_token=xyz")).toBeNull();
    expect(accessTokenFromLocation("", "")).toBeNull();
  });
});

describe("remembered session client", () => {
  const src = join(process.cwd(), "src");

  it("does not write the session to localStorage or sessionStorage", () => {
    const client = readFileSync(join(src, "lib", "iwaAccount.ts"), "utf8");
    expect(client).not.toMatch(/localStorage/);
    expect(client).not.toMatch(/sessionStorage/);
    expect(client).toContain('credentials: "include"');
  });

  it("never puts the session token in the URL", () => {
    const client = readFileSync(join(src, "lib", "iwaAccount.ts"), "utf8");
    expect(client).not.toMatch(/iwa_session=/);
    expect(client).not.toMatch(/searchParams.*token/);
  });
});

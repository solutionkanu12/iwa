import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuthLoading, AuthScreen, AuthSuspended } from "./AuthScreen";

describe("auth screen", () => {
  it("offers Google and email without redesigning Iwa", () => {
    const html = renderToStaticMarkup(<AuthScreen onSignedIn={() => {}} />);
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with email");
    expect(html).toContain("Continue to Iwa");
    expect(html).toContain("you@example.com");
  });

  it("shows a loading state that is not the login screen", () => {
    const html = renderToStaticMarkup(<AuthLoading />);
    expect(html).toContain("Opening Iwa");
    expect(html).not.toContain("Continue with Google");
  });

  it("explains suspension without claiming custody", () => {
    const html = renderToStaticMarkup(
      <AuthSuspended message="This Iwa account is suspended. Your on-chain funds are untouched." />,
    );
    expect(html).toContain("suspended");
    expect(html).toContain("on-chain funds are untouched");
  });
});

describe("logout controls", () => {
  it("offers logout and logout all from the application shell", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "AppShell.tsx"), "utf8");
    expect(src).toContain("Log out");
    expect(src).toContain("Log out all devices");
    expect(src).toContain("logoutAll");
  });
});

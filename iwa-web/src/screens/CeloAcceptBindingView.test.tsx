// screens/CeloAcceptBindingView.test.tsx — the account-binding invite screen.
//
// No wallet or circle detail can be shown ahead of accepting (the backend
// never discloses which member an invite is for), so the only synchronous
// render to check is the initial prompt.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CeloAcceptBindingView } from "./CeloAcceptBindingView";

describe("CeloAcceptBindingView", () => {
  it("prompts to connect and link a wallet, without revealing circle or member details", () => {
    const html = renderToStaticMarkup(<CeloAcceptBindingView token="tok123" />);
    expect(html).toContain("Link your wallet");
    expect(html).toContain("Connect and link wallet");
    expect(html).not.toContain("tok123");
  });
});

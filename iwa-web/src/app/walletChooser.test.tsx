// app/walletChooser.test.ts — the "Connect to Iwa" chooser.
//
// One Iwa-level chooser offers both wallets, and connecting one never forces
// or disturbs the other. Rendered to static markup (no DOM needed) so the
// surface itself is what is asserted, not an approximation of it.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WalletChooser, type WalletChooserProps } from "./WalletChooser";

function props(overrides: Partial<WalletChooserProps> = {}): WalletChooserProps {
  return {
    open: true,
    starknetAddress: null,
    evmConnected: false,
    evmAddress: null,
    busy: null,
    onClose: () => {},
    onConnectStarknet: () => {},
    onConnectEvm: () => {},
    onDisconnectStarknet: () => {},
    onDisconnectEvm: () => {},
    ...overrides,
  };
}

function markup(p: WalletChooserProps): string {
  return renderToStaticMarkup(<WalletChooser {...p} />);
}

describe("the Connect to Iwa chooser", () => {
  it("renders nothing when closed", () => {
    const html = markup(props({ open: false }));
    expect(html).not.toContain("Connect to Iwa");
  });

  it("offers both wallets to a disconnected visitor", () => {
    const html = markup(props());
    expect(html).toContain("Connect to Iwa");
    expect(html).toContain("Choose the wallet that matches what you want to do.");
    expect(html).toContain("Starknet");
    expect(html).toContain("For savings circles and your Iwa standing.");
    expect(html).toContain("Connect Starknet wallet");
    expect(html).toContain("EVM");
    expect(html).toContain("For Prize Savings.");
    expect(html).toContain("Connect EVM wallet");
  });

  it("never asks the visitor to connect both at once", () => {
    const html = markup(props());
    expect(html).not.toContain("Connect both");
    expect(html).not.toContain("Connect all");
  });

  it("shows the Starknet option as connected when it is", () => {
    const html = markup(props({ starknetAddress: "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7" }));
    expect(html).toContain("Starknet");
    expect(html).toContain("Connected");
  });

  it("shows the EVM option as connected when it is", () => {
    const html = markup(props({ evmConnected: true, evmAddress: "0xabcdef1234567890" }));
    expect(html).toContain("EVM");
    expect(html).toContain("Connected");
    expect(html).toContain("0xabc…7890");
  });

  it("keeps both options independent: a connected Starknet still offers EVM", () => {
    const html = markup(props({ starknetAddress: "0x4099b8eb" }));
    expect(html).toContain("Connect EVM wallet");
  });

  it("keeps both options independent: a connected EVM still offers Starknet", () => {
    const html = markup(props({ evmConnected: true, evmAddress: "0xabcdef1234567890" }));
    expect(html).toContain("Connect Starknet wallet");
  });

  it("shows both connected together without asking to connect either", () => {
    const html = markup(
      props({
        starknetAddress: "0x4099b8eb",
        evmConnected: true,
        evmAddress: "0xabcdef1234567890",
      }),
    );
    expect(html).not.toContain("Connect Starknet wallet");
    expect(html).not.toContain("Connect EVM wallet");
    expect(html).toContain("Disconnect");
  });

  it("keeps the close affordance", () => {
    expect(markup(props())).toContain("Close");
  });

  it("disables the busy chain's button while connecting", () => {
    const html = markup(props({ busy: "starknet" }));
    expect(html).toMatch(/disabled=""/);
  });
});
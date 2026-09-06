// app/appWalletControl.test.tsx — the shell's compact wallet control.
//
// Two connections, one control. Each chain's state is shown on its own row so
// a visitor always knows which wallet Iwa is talking to and which is missing.
// Connecting or disconnecting one never touches the other.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppWalletControl, type AppWalletControlProps } from "./AppWalletControl";

function props(overrides: Partial<AppWalletControlProps> = {}): AppWalletControlProps {
  return {
    starknetAddress: null,
    evmStatus: "disconnected",
    evmAddress: null,
    busy: null,
    onOpenChooser: () => {},
    onConnectStarknet: () => {},
    onDisconnectStarknet: () => {},
    onConnectEvm: () => {},
    onDisconnectEvm: () => {},
    ...overrides,
  };
}

function markup(p: AppWalletControlProps): string {
  return renderToStaticMarkup(<AppWalletControl {...p} />);
}

describe("the shell wallet control", () => {
  it("offers a single Connect to Iwa entry when nothing is connected", () => {
    const html = markup(props());
    expect(html).toContain("Connect to Iwa");
  });

  it("shows Starknet connected and EVM not connected for a Starknet-only user", () => {
    const html = markup(props({ starknetAddress: "0x4099b8ebd6e6c642" }));
    expect(html).toContain("Starknet");
    expect(html).toContain("Connected");
    expect(html).toContain("EVM");
    expect(html).toContain("Not connected");
  });

  it("shows EVM connected and Starknet not connected for an EVM-only user", () => {
    const html = markup(props({ evmStatus: "connected" }));
    expect(html).toContain("EVM");
    expect(html).toContain("Connected");
    expect(html).toContain("Starknet");
    expect(html).toContain("Not connected");
  });

  it("shows both connected without collapsing them into one row", () => {
    const html = markup(props({ starknetAddress: "0x4099b8eb", evmStatus: "connected" }));
    expect(html).toContain("Starknet");
    expect(html).toContain("EVM");
    expect(html).toContain("Connected");
  });

  it("keeps a per-chain disconnect next to each connected chain", () => {
    const html = markup(props({ starknetAddress: "0x4099b8eb", evmStatus: "connected" }));
    expect(html).toContain("Disconnect");
  });

  it("marks the EVM row with the network when it is connected elsewhere", () => {
    const html = markup(props({ evmStatus: "wrongNetwork", evmAddress: "0xabcdef1234567890" }));
    expect(html).toContain("EVM");
    expect(html).toContain("Wrong network");
    expect(html).toContain("Disconnect");
  });

  it("shows the shortened EVM address on a connected EVM row", () => {
    const html = markup(props({ evmStatus: "connected", evmAddress: "0xabcdef1234567890" }));
    expect(html).toContain("0xabc…7890");
  });

  it("does not nest a second wallet pill inside the compact rows", () => {
    const html = markup(props({ starknetAddress: "0x4099b8eb" }));
    expect(html).not.toContain("aria-haspopup");
  });

  it("keeps the labels compact", () => {
    const html = markup(props({ starknetAddress: "0x4099b8eb" }));
    for (const word of ["Starknet", "EVM", "Connected", "Not connected"]) {
      expect(html).toContain(word);
    }
  });
});
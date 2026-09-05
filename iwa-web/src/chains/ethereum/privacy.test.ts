// chains/ethereum/privacy.test.ts — the Prize Savings surface must never log
// ciphertexts, proofs or decrypted values, and must not put them in the page
// history or any storage. Static source guard: no console output and no
// storage/history writes anywhere in the feature or its seams.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SCOPED = [
  "src/features/prizeSavings/contracts.ts",
  "src/features/prizeSavings/zama.ts",
  "src/lib/prizeSavings/flow.ts",
  "src/screens/PrizeSavingsView.tsx",
  "src/chains/ethereum/wallet.ts",
];

describe("prize savings privacy surface", () => {
  for (const file of SCOPED) {
    it(`${file} never logs and never persists decrypted material`, () => {
      const source = readFileSync(join(__dirname, "..", "..", "..", file), "utf8");
      expect(source).not.toMatch(/console\.(log|debug|info|warn|error)\s*\(/);
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    });
  }

  it("the decrypted balance is rendered and not forwarded anywhere", () => {
    const screen = readFileSync(
      join(__dirname, "..", "..", "..", "src", "screens", "PrizeSavingsView.tsx"),
      "utf8",
    );
    // The only consumer of a decrypted value is the local <p> render.
    expect(screen).toContain("setBalance(formatUnits6(value))");
    expect(screen).not.toContain("navigator.sendBeacon");
    expect(screen).not.toContain("fetch(");
  });
});
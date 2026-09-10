// chains/celo/isolation.test.ts — Celo attribution must not leak into
// IWA Core or any non-Celo adapter. Celo is a chain adapter, not a
// product fork.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const WEB_ROOT = join(__dirname, "..", "..", "..");

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, acc);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

describe("Celo attribution does not mutate non-Celo adapters", () => {
  it("ethereum, starknet, core, and prize-savings sources never import Celo tagging", () => {
    const dirs = [
      join(WEB_ROOT, "src", "chains", "ethereum"),
      join(WEB_ROOT, "src", "chains", "strk20"),
      join(WEB_ROOT, "src", "core"),
      join(WEB_ROOT, "src", "features", "prizeSavings"),
      join(WEB_ROOT, "src", "lib"),
    ];
    const extra = [
      join(WEB_ROOT, "src", "chains", "types.ts"),
      join(WEB_ROOT, "src", "chains", "starknetProduction.ts"),
    ];
    const files = [...dirs.flatMap((d) => walkTs(d)), ...extra];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/@celo\/attribution-tags/);
      expect(src, file).not.toMatch(/chains\/celo/);
      expect(src, file).not.toMatch(/celo_448874a99d90/);
      expect(src, file).not.toMatch(/tagCeloCalldata/);
    }
  });

  it("the chain-neutral ChainAdapter interface has no Celo or calldata tagging types", () => {
    const src = readFileSync(join(WEB_ROOT, "src", "chains", "types.ts"), "utf8");
    expect(src).not.toMatch(/celo/i);
    expect(src).not.toMatch(/attribution/i);
    expect(src).not.toMatch(/calldata/i);
  });

  it("the Celo adapter does not import Starknet or Zama modules", () => {
    const files = walkTs(join(WEB_ROOT, "src", "chains", "celo")).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/strk20/i);
      expect(src, file).not.toMatch(/starknet/i);
      expect(src, file).not.toMatch(/zama/i);
      expect(src, file).not.toMatch(/prizeSavings/);
    }
  });
});

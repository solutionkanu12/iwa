// Prize Savings copy and layout must survive narrow screens.
//
// Two problems pinned here. The first is copy that wraps awkwardly on a phone:
// a heading built from three long clauses is a paragraph, not a headline. The
// second is layout that assumes width: a flex row holding an input and a button
// overflows a 360px phone unless it wraps. Both are about the same thing —
// the Prize Savings surface staying as usable on a small screen as it is on a
// desktop — and neither may cost the confidentiality the feature exists for.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const flow = readFileSync(join(SRC, "lib", "prizeSavings", "flow.ts"), "utf8");
const css = readFileSync(join(SRC, "screens", "PrizeSavingsView.module.css"), "utf8");

describe("Prize Savings copy", () => {
  it("keeps the heading short enough to wrap cleanly on a phone", () => {
    const heading = flow.match(/heading: "([^"]+)"/)?.[1] ?? "";
    expect(heading.length).toBeGreaterThan(0);
    expect(heading.length).toBeLessThanOrEqual(64);
    expect(heading.startsWith("Save privately.")).toBe(true);
  });

  it("keeps the promise of principal and a confidential draw", () => {
    const heading = flow.match(/heading: "([^"]+)"/)?.[1] ?? "";
    expect(heading.toLowerCase()).toMatch(/principal/);
    expect(heading.toLowerCase()).toMatch(/reward|draw|win/);
  });

  it("still names the confidentiality mechanism without jargon", () => {
    expect(flow).toContain("encrypted");
    expect(flow).toContain("winner");
  });

  it("still tells the visitor which chain and wallet are needed", () => {
    expect(flow).toContain("Ethereum Sepolia");
    expect(flow).toContain("Ethereum wallet");
  });
});

describe("Prize Savings layout responsiveness", () => {
  it("wraps input rows on narrow screens instead of overflowing", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*(5|6)\d0px\)/);
    expect(css).toMatch(/\.row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("lets a row's input and button each take the width they need when wrapped", () => {
    expect(css).toMatch(/\.row\s*>\s*\.input[^{]*\{/);
    expect(css).toMatch(/flex:\s*1\s*1\s*\d+%/);
  });

  it("keeps the confirm button aligned when a row wraps", () => {
    expect(css).toMatch(/\.row\s*>\s*\.button\s*\{[^}]*align-self:\s*flex-start/);
  });

  it("gives row action buttons the wrap class the CSS targets", () => {
    const view = readFileSync(join(SRC, "screens", "PrizeSavingsView.tsx"), "utf8");
    expect(view).toMatch(/<Button[^>]*className=\{styles\.button\}/);
  });
});
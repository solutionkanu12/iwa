// Prize Savings copy and layout must survive narrow screens.
//
// Two problems pinned here. The first is copy that wraps awkwardly on a phone:
// a heading built from three long clauses is a paragraph, not a headline. The
// second is layout that assumes width: a flex row holding an input and a button
// can overflow a phone instead of staying compact. Both are about the same thing —
// the Prize Savings surface staying as usable on a small screen as it is on a
// desktop — and neither may cost the confidentiality the feature exists for.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIZE_SAVINGS_COPY } from "../lib/prizeSavings/flow";

const SRC = join(process.cwd(), "src");

const flow = readFileSync(join(SRC, "lib", "prizeSavings", "flow.ts"), "utf8");
const css = readFileSync(join(SRC, "screens", "PrizeSavingsView.module.css"), "utf8");

describe("Prize Savings copy", () => {
  it("uses short labels for the wrap and pool-permission actions", () => {
    expect(PRIZE_SAVINGS_COPY.wrap).toBe("Wrap tokens");
    expect(PRIZE_SAVINGS_COPY.grantOperator).toBe("Allow pool");
  });

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
  const view = readFileSync(join(SRC, "screens", "PrizeSavingsView.tsx"), "utf8");

  it("stacks each standalone action as title, explanation, then button", () => {
    expect(view).toContain("className={styles.action}");
    expect(view).toContain("className={styles.actionTitle}");
    expect(view).toContain("className={styles.actionDetail}");
    expect(css).toMatch(/\.action\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.action\s*\{[^}]*align-items:\s*flex-start/);
  });

  it("keeps amount inputs and their buttons in compact two-column rows", () => {
    expect(view).toContain("className={styles.inputRow}");
    expect(css).toMatch(/\.inputRow\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(
      /\.inputRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    );
  });

  it("prevents action labels from wrapping awkwardly", () => {
    expect(css).toMatch(/\.button\s*\{[^}]*white-space:\s*nowrap/);
  });
});

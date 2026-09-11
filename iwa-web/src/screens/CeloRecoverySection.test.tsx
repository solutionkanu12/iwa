// screens/CeloRecoverySection.test.tsx — the recovery card's display logic.
//
// This component never decides eligibility itself (circleModel does, from
// on-chain reads plus the Recovered event log), so these tests only check
// what it renders for a given `recoverableRounds` list: the exact amount,
// no raw enum names, and that the action is gone once the list is empty
// (the state a confirmed recovery, or a round nobody may recover, produces).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CeloRecoverySection } from "./CeloCircleView";

describe("CeloRecoverySection", () => {
  it("shows plain copy, the exact cNGN amount, and a recover action for a recoverable round", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[2]}
        amount="5.0"
        busyRound={null}
        error={null}
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("your contribution of 5.0 cNGN from this round can be returned");
    expect(html).toContain("Recover contribution");
    expect(html).not.toMatch(/DeferredLocked|DEFERRED_LOCKED|OnTime|ON_TIME/);
  });

  it("renders nothing when there is no recoverable round (a non-payer, a defaulting member, or a round already recovered)", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[]}
        amount="5.0"
        busyRound={null}
        error={null}
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toBe("");
  });

  it("renders one row per recoverable round, each with its own action", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[2, 4]}
        amount="5.0"
        busyRound={null}
        error={null}
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("Round 2");
    expect(html).toContain("Round 4");
    expect((html.match(/Recover contribution/g) ?? []).length).toBe(2);
  });

  it("disables every recover action while one round is being recovered, and labels the busy one", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[2]}
        amount="5.0"
        busyRound={2}
        error={null}
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("Recovering…");
    expect(html).toContain("disabled");
  });

  it("shows a failure notice without claiming success", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[2]}
        amount="5.0"
        busyRound={null}
        error="The recovery transaction did not succeed. Nothing was moved."
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("did not succeed");
    expect(html).not.toContain("has been returned");
  });

  it("shows a confirmed result distinctly from a failure", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[2]}
        amount="5.0"
        busyRound={null}
        error={null}
        result="Your contribution has been returned."
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("has been returned");
  });

  it("keeps showing a just-confirmed result even after the round has already left the recoverable list", () => {
    // This is exactly the state right after a confirmed recovery: the same
    // reload that reports success also removes the round from
    // recoverableRounds, since it is no longer recoverable.
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[]}
        amount="5.0"
        busyRound={null}
        error={null}
        result="Your contribution has been returned."
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("has been returned");
    expect(html).not.toContain("Recover contribution");
  });

  it("keeps showing a failure notice even with an empty round list", () => {
    const html = renderToStaticMarkup(
      <CeloRecoverySection
        recoverableRounds={[]}
        amount="5.0"
        busyRound={null}
        error="The recovery transaction did not succeed. Nothing was moved."
        result={null}
        onRecover={vi.fn()}
      />,
    );
    expect(html).toContain("did not succeed");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function shipped(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("landing page structure", () => {
  const landingPageSource = shipped(join(SRC, "landing", "LandingPage.tsx"));

  it("removes the bottom dock island completely", () => {
    expect(landingPageSource).not.toContain("LandingDock");
    expect(landingPageSource).not.toContain("<LandingDock");
    expect(landingPageSource).not.toContain("dock");
  });

  it("preserves the top nav, hero, community, how it works, showcase, faq, and footer", () => {
    expect(landingPageSource).toContain("<LandingNav");
    expect(landingPageSource).toContain("<LandingHero");
    expect(landingPageSource).toContain("<LandingCommunity");
    expect(landingPageSource).toContain("<LandingHowItWorks");
    expect(landingPageSource).toContain("<LandingShowcase");
    expect(landingPageSource).toContain("<LandingFaq");
    expect(landingPageSource).toContain("<LandingFooter");
  });

  it("preserves topband background cowrie asset", () => {
    expect(landingPageSource).toContain("/assets/iwa-cowrie-basket.jpg");
  });
});

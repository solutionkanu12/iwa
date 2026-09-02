// What the product is allowed to say.
//
// Copy drifts out of truth quietly: a chain is migrated, a feature is deferred,
// and a sentence written for the old state stays behind, sounding confident.
// This reads the shipped source and refuses the phrases that were wrong before.
//
// Only what reaches a person. The operator console is internal tooling and is
// out of scope; the preserved Soroban modules that used to be excluded here have
// been removed from the repository, so there is nothing left to exclude.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Files not rendered to a person. */
const OUT_OF_SCOPE = [
  "Strk20ConsoleView", // internal operator tooling
  ".test.",
];

function productFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      productFiles(path, found);
    } else if (/\.tsx?$/.test(entry) && !OUT_OF_SCOPE.some((skip) => path.includes(skip))) {
      found.push(path);
    }
  }
  return found;
}

/** Source with comment lines removed, so only what ships is examined. */
function shippedText(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const FILES = productFiles(SRC);

describe("what the product says", () => {
  it("finds product source to check", () => {
    expect(FILES.length).toBeGreaterThan(15);
  });

  // Iwa keeps a record and proves a claim about it. It does not rate anybody.
  it("never calls the credential a credit score", () => {
    for (const path of FILES) {
      expect(shippedText(path).toLowerCase()).not.toContain("credit score");
    }
  });

  // The earlier implementation ran on a different network. Saying so now would
  // be describing a deployment that is not the one people are using.
  it("does not describe the product as running on the earlier network", () => {
    for (const path of FILES) {
      const text = shippedText(path);
      expect(text).not.toMatch(/Stellar testnet/i);
      expect(text).not.toMatch(/Stellar Hacks/i);
    }
  });

  // The sprint it was first built for is over, and Iwa is not a sprint entry.
  it("does not frame the product as a hackathon entry", () => {
    for (const path of FILES) {
      expect(shippedText(path)).not.toMatch(/hackathon/i);
    }
  });

  // The call to action opens the application, not a circle.
  it("has no remnant of the old call to action", () => {
    for (const path of FILES) {
      expect(shippedText(path)).not.toContain("Enter the circle");
    }
  });

  it("makes no claim of a rating, band or grade", () => {
    for (const path of FILES) {
      const text = shippedText(path).toLowerCase();
      for (const banned of ["excellent standing", "healthy standing", "reputation score"]) {
        expect(text).not.toContain(banned);
      }
    }
  });
});

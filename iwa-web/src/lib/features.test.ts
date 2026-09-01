import { describe, expect, it } from "vitest";

import { CAPABILITIES, POT_COLLECTION, CREDENTIAL_VERIFICATION } from "./features";

// A control that cannot work must say so before it is pressed, not after. Each
// of these carries the reason a person is actually owed, in words they can act
// on, so no screen has to invent an explanation of its own.
describe("capabilities", () => {
  it("gives every capability a reason a person can read", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.reason.length).toBeGreaterThan(20);
      expect(capability.title.length).toBeGreaterThan(0);
    }
  });

  it("speaks plainly, with no protocol jargon", () => {
    for (const { title, reason } of CAPABILITIES) {
      const text = `${title} ${reason}`.toLowerCase();
      for (const jargon of [
        "verifier",
        "groth16",
        "circuit",
        "nullifier",
        "felt",
        "calldata",
        "open note",
        "contract",
        "not deployed",
        "credit score",
      ]) {
        expect(text).not.toContain(jargon);
      }
    }
  });

  it("uses no dashes or exclamation marks in product copy", () => {
    for (const { title, reason } of CAPABILITIES) {
      expect(`${title} ${reason}`).not.toMatch(/[—–!]/);
    }
  });

  it("never promises that something unavailable will work", () => {
    for (const capability of CAPABILITIES) {
      if (capability.available) continue;
      expect(capability.reason.toLowerCase()).not.toMatch(/you can now|available now|ready to use/);
    }
  });
});

// These two are the honest state of this deployment. When either becomes
// available the flag flips here, in one place, and every screen follows.
describe("what this deployment supports", () => {
  it("does not offer credential verification yet", () => {
    expect(CREDENTIAL_VERIFICATION.available).toBe(false);
  });

  it("does not offer pot collection yet", () => {
    expect(POT_COLLECTION.available).toBe(false);
  });

  it("keeps the credential a credential and never a score", () => {
    const text = `${CREDENTIAL_VERIFICATION.title} ${CREDENTIAL_VERIFICATION.reason}`;
    expect(text.toLowerCase()).not.toContain("score");
    expect(text.toLowerCase()).not.toContain("rating");
  });

  it("says money is recorded, never that it can be taken", () => {
    expect(POT_COLLECTION.reason.toLowerCase()).not.toMatch(/withdraw now|available to collect/);
  });
});

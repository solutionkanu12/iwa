// The line between reading and doing, asserted against the source.
//
// Every other test in this suite drives the HTTP surface and proves that today
// a session cannot reorder a payout order. This one is different: it reads
// app.ts and asserts which routes are wired to which credential, so that adding
// a session to a mutation is a failing test rather than a code review somebody
// might be in a hurry for.
//
// It is deliberately literal. If the wiring is refactored these expectations
// must be updated by hand, and having to think about it is the point.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AUTH_ACTIONS } from "../src/authBinding.js";

const source = readFileSync(
  fileURLToPath(new URL("../src/app.ts", import.meta.url)),
  "utf8",
);

/** The actions passed to one of the two authenticators. */
function actionsFor(authenticator: "authenticate" | "authenticateRead"): string[] {
  const pattern = new RegExp(`\\b${authenticator}\\(req, res, AUTH_ACTIONS\\.(\\w+)\\)`, "g");
  return [...source.matchAll(pattern)].map((m) => m[1] as string).sort();
}

describe("which routes accept a read-only session", () => {
  // The four the session exists for. Each answers a question about the
  // caller's own coordination data and changes nothing.
  it("accepts a session for exactly the four private reads", () => {
    expect(actionsFor("authenticateRead")).toEqual(
      ["associationsList", "draftReadOrganizer", "draftsList", "invitationsList"].sort(),
    );
  });

  // Everything that writes, plus the sign-in itself, which must never be
  // mintable from a session or a session would renew itself forever.
  it("demands a full wallet signature for every other action", () => {
    expect(actionsFor("authenticate")).toEqual(
      [
        "sessionCreate",
        "draftCreate",
        "draftReorder",
        "draftMarkCreated",
        "draftReconcile",
      ].sort(),
    );
  });

  it("gives no action both credentials", () => {
    const read = new Set(actionsFor("authenticateRead"));
    const signed = actionsFor("authenticate").filter((a) => read.has(a));
    expect(signed).toEqual([]);
  });

  // Nothing is left in an ambiguous middle: every action the binding declares
  // is wired to one authenticator or the other, or is not authenticated at all
  // and appears in neither.
  it("classifies every action it uses", () => {
    const used = [...actionsFor("authenticate"), ...actionsFor("authenticateRead")];
    for (const action of used) {
      expect(Object.keys(AUTH_ACTIONS)).toContain(action);
    }
    expect(new Set(used).size).toBe(used.length);
  });

  it("names every action the binding declares, so none is silently unrouted", () => {
    const used = new Set([...actionsFor("authenticate"), ...actionsFor("authenticateRead")]);
    expect([...Object.keys(AUTH_ACTIONS)].filter((a) => !used.has(a))).toEqual([]);
  });
});

describe("the session store is reachable only through a verified signature", () => {
  it("mints a session in exactly one place", () => {
    expect([...source.matchAll(/sessions\.create\(/g)]).toHaveLength(1);
  });

  it("mints it from the address the signature verified, never from a request", () => {
    expect(source).toContain("sessions.create(caller, SN_MAIN)");
    expect(source).not.toMatch(/sessions\.create\(\s*req\./);
  });

  it("checks a session against the server's chain, never the caller's", () => {
    expect(source).toContain("sessions.validate(token, SN_MAIN)");
    expect(source).not.toMatch(/sessions\.validate\([^)]*chainHeader/);
  });
});

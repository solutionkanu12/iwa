// What the organizer surface is allowed to reach, and what it is allowed to do.
//
// An organizer command centre is exactly the sort of screen that grows powers.
// It starts as a status list, somebody adds a button because a member is
// unreachable, and a product that could not seize funds becomes one that can.
// Iwa's contracts hold no such power, so the way that happens here is quieter:
// a screen starts reading a member's wallet address, or an invitation token, or
// a savings history that was never the organizer's to see.
//
// So this reads the shipped source of the organizer surface and refuses both.
// It is a coarse instrument on purpose. A regression here is worth a false
// alarm, and every exclusion below is named rather than pattern matched.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Every file that renders or derives what an organizer sees. */
const ORGANIZER_SURFACE = [
  join(SRC, "lib", "organizerView.ts"),
  join(SRC, "screens", "CircleView.tsx"),
];

/** Source with comment lines removed, so only what ships is examined. */
function shipped(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/** The organizer section of the circle screen, on its own. */
function organizerSection(): string {
  const text = shipped(join(SRC, "screens", "CircleView.tsx"));
  const start = text.indexOf("function OrganizerSection");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("type Screen", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("what the organizer view can reach", () => {
  it("never renders a member identifier", () => {
    const section = organizerSection();
    for (const banned of [
      "memberRef",
      "member_ref",
      "inviteToken",
      "invite_token",
      "authPublicKey",
      "auth_public_key",
      "commitment",
      "viewingKey",
      "secret",
    ]) {
      expect(section).not.toContain(banned);
    }
  });

  it("never renders a wallet address, its own included", () => {
    const section = organizerSection();
    expect(section).not.toMatch(/\baddress\b/);
    expect(section).not.toContain("short(");
  });

  it("derives the whole picture without the coordination service", () => {
    // Nothing an organizer sees about a live circle comes from a place that
    // could be persuaded to answer for somebody else's circle.
    const view = shipped(join(SRC, "lib", "organizerView.ts"));
    expect(view).not.toContain("lib/backend");
    expect(view).not.toContain("./backend");
    expect(view).not.toContain("fetch(");
  });

  it("keeps the payout state read from returning who it belongs to", () => {
    const reads = shipped(join(SRC, "chains", "strk20", "publicReads.ts"));
    const start = reads.indexOf("export async function getPayoutState");
    expect(start).toBeGreaterThan(-1);
    const body = reads.slice(start, reads.indexOf("export async function getRoundLiability", start));
    expect(body).not.toContain("scheduledMemberRef");
    expect(body).not.toContain("scheduled_member_ref");
  });

  it("returns no member reference from the organizer chain read", () => {
    const chain = shipped(join(SRC, "lib", "iwaStarknet.ts"));
    const start = chain.indexOf("export interface OrganizerChainFacts");
    expect(start).toBeGreaterThan(-1);
    const body = chain.slice(start, chain.indexOf("}", start));
    expect(body).not.toContain("memberRef");
    expect(body).not.toContain("address");
  });
});

describe("what the organizer view can do", () => {
  it("offers no call that could move money or finalize anything", () => {
    for (const path of ORGANIZER_SURFACE) {
      const text = shipped(path);
      for (const banned of [
        "finalize_round_payout_accounting",
        "finalize_contribution_default",
        "authorize_payout_settlement",
        "settle_payout_from_helper",
        "settle_recovery_from_helper",
        "settle_cure_from_helper",
        "prepare_final_settlement",
        "normalize_surplus",
      ]) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it("signs nothing from the organizer section", () => {
    const section = organizerSection();
    for (const banned of ["signMessage", "account.execute", "walletSigner", "authorizedRead"]) {
      expect(section).not.toContain(banned);
    }
  });

  it("puts no button in the organizer section at all", () => {
    // Every state it reports is resolved by somebody else acting for
    // themselves. A control here would have to be either useless or a power
    // the product has said it does not grant.
    const section = organizerSection();
    expect(section).not.toContain("<Button");
    expect(section).not.toContain("onClick");
  });

  it("reads the chain and derives, and writes nothing", () => {
    const chain = shipped(join(SRC, "lib", "iwaStarknet.ts"));
    const start = chain.indexOf("export async function get_organizer_facts");
    expect(start).toBeGreaterThan(-1);
    const body = chain.slice(start, chain.indexOf("export interface OrganizerChainFacts", start));
    expect(body).not.toContain("execute");
    expect(body).not.toContain("currentWallet");
    expect(body).not.toContain("signChecked");
  });
});

describe("the guard itself", () => {
  it("is reading a real section rather than an empty string", () => {
    const section = organizerSection();
    expect(section.length).toBeGreaterThan(400);
    expect(section).toContain("organizerSummary");
    expect(section).toContain("ORGANIZER_COPY.heading");
  });
});

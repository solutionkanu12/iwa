// What the operator screen is allowed to be.
//
// An admin dashboard is where a product's promises quietly stop being true. A
// button gets added because somebody is unreachable; a wallet address gets
// shown because it would help support; a page ends up gated by a URL nobody
// links to. None of those is caught by a passing feature test, so this reads
// the shipped source and refuses each one by name.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolve, hrefFor, isAppRoute } from "./router";
import { needsWallet, screenFor, PRIMARY_NAV, ACTION_NAV, MOBILE_NAV } from "../app/navigation";

const SRC = join(process.cwd(), "src");

/** Source with comment lines removed, so only what ships is examined. */
function shipped(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const screen = () => shipped(join(SRC, "screens", "AdminView.tsx"));
const view = () => shipped(join(SRC, "lib", "adminView.ts"));

describe("the route", () => {
  it("resolves /admin and nothing under it", () => {
    expect(resolve("/admin", "").route).toEqual({ name: "admin" });
    expect(resolve("/admin/", "").route).toEqual({ name: "admin" });
    expect(resolve("/admin/drafts", "").route.name).toBe("notFound");
    expect(resolve("/admin/members", "").route.name).toBe("notFound");
  });

  it("round trips through its own href", () => {
    expect(hrefFor({ name: "admin" })).toBe("/admin");
    expect(resolve(hrefFor({ name: "admin" }), "").route).toEqual({ name: "admin" });
  });

  it("renders inside the ordinary application shell", () => {
    expect(isAppRoute({ name: "admin" })).toBe(true);
    expect(screenFor({ name: "admin" })).toBe("admin");
    expect(needsWallet("admin")).toBe(true);
  });

  it("is not advertised in navigation to anybody", () => {
    for (const nav of [PRIMARY_NAV, ACTION_NAV, MOBILE_NAV]) {
      expect(nav.map((e) => e.route.name)).not.toContain("admin");
    }
  });
});

describe("the screen cannot be the security boundary", () => {
  it("holds no allowlist, role or operator address of its own", () => {
    const text = screen();
    for (const banned of [
      "ADMIN_ADDRESSES",
      "allowlist",
      "isAdmin",
      "role",
      "0x04099",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("decides nothing about who may look: it asks the service and reports", () => {
    // The only way this screen learns anybody is an operator is by being told,
    // and the only way it learns they are not is a 403 it renders as words.
    expect(screen()).toContain("not_admin");
    expect(screen()).toContain("backend.adminOverview");
  });

  it("derives no figure of its own from a wallet or a chain read", () => {
    const text = screen();
    for (const banned of ["get_circle", "get_organizer_facts", "getPayoutOrder", "ensureIdentity"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("the screen never signs by itself", () => {
  it("has no effect that reads, so arriving prompts nothing", () => {
    // There is one effect and it only forgets. What must never exist is an
    // effect that loads: that would turn a render into a wallet prompt, which
    // is the whole rule this screen shares with Home.
    const effects = [...screen().matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map(
      (m) => m[1] as string,
    );
    expect(effects.length).toBeGreaterThan(0);
    for (const body of effects) {
      expect(body).not.toContain("load(");
      expect(body).not.toContain("adminOverview");
      expect(body).not.toContain("walletSigner");
    }
  });

  it("forgets the report when the wallet changes", () => {
    // A-1. The report was authorized by one wallet; once that wallet is no
    // longer connected the screen must not still be showing it.
    const text = screen();
    const effect = /useEffect\(\(\) => \{\s*setState\(\{ kind: "idle" \}\);\s*\}, \[address\]\);/;
    expect(text).toMatch(effect);
  });

  it("signs only inside the read the operator asked for", () => {
    const text = screen();
    // The signer is handed to exactly one call. A second call site would be a
    // second wallet prompt, which is the thing being guarded against; the
    // declaration itself is matched separately so it cannot mask one.
    expect([...text.matchAll(/,\s*walletSigner\(\)\)/g)]).toHaveLength(1);
    expect([...text.matchAll(/function walletSigner\(\)/g)]).toHaveLength(1);
    expect([...text.matchAll(/signMessage/g)]).toHaveLength(1);
  });

  it("never trades the signature for a session", () => {
    const text = screen();
    for (const banned of ["authorizedRead", "createSession", "useSession", "Bearer"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("the screen has no power", () => {
  it("calls nothing that could move money or finalize anything", () => {
    for (const text of [screen(), view()]) {
      for (const banned of [
        "finalize_round_payout_accounting",
        "finalize_contribution_default",
        "authorize_payout_settlement",
        "settle_payout_from_helper",
        "settle_recovery_from_helper",
        "prepare_final_settlement",
        "normalize_surplus",
        "collect_pot",
        "pay_contribution",
        "join_circle",
        "create_circle",
        "account.execute",
      ]) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it("reaches no coordination mutation on anybody's behalf", () => {
    const text = screen();
    for (const banned of [
      "backend.reconcile",
      "backend.markCreated",
      "backend.reorder",
      "backend.createDraft",
      "backend.acceptInvite",
      "backend.getDraftAsOrganizer",
      "backend.myCircles",
      "backend.listDrafts",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("offers only the read, the retry and a way out", () => {
    // Four buttons: connect, read, read again, and go back. None of them is an
    // operation on the platform or on anybody in it.
    const buttons = [...screen().matchAll(/<Button\b/g)];
    expect(buttons.length).toBeLessThanOrEqual(5);
    for (const banned of ["Fix", "Repair", "Retry all", "Force", "Pause", "Resolve", "Approve"]) {
      expect(screen()).not.toContain(`>${banned}`);
    }
  });
});

describe("the screen carries nothing private", () => {
  it("renders no member identifier or wallet of anybody's", () => {
    const text = screen();
    for (const banned of [
      "memberRef",
      "member_ref",
      "authPublicKey",
      "inviteToken",
      "organizerAddress",
      "acceptedByAddress",
      "viewingKey",
      "commitment",
      "secret",
      "draftId",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("shows only the contract addresses this build is pinned to", () => {
    const text = screen();
    expect(text).toContain("STARKNET_MAINNET.iwaCircle");
    expect(text).toContain("STARKNET_MAINNET.iwaHelper");
    expect(text).toContain("STARKNET_MAINNET.privacyPool");
    // The operator's own address is used to authenticate and is never rendered.
    expect(text).not.toContain("short(address)");
  });

  it("logs nothing anywhere", () => {
    expect(screen()).not.toContain("console.");
  });
});

describe("the guard itself", () => {
  it("is reading real files rather than empty strings", () => {
    expect(screen().length).toBeGreaterThan(1000);
    expect(view().length).toBeGreaterThan(1000);
    expect(screen()).toContain("ADMIN_COPY.heading");
  });
});

// A-1. Clearing has to be total: if the idle state could still carry a report,
// forgetting would leave something behind for the next wallet to see.
describe("what a forgotten report leaves behind", () => {
  it("has no state that both means idle and holds a report", () => {
    const text = screen();
    expect(text).toContain('| { kind: "idle" }');
    // Only the ready state names a report, so resetting to idle discards it
    // structurally rather than by remembering to blank a field.
    const reportStates = [...text.matchAll(/\{ kind: "(\w+)";[^}]*report:/g)].map((m) => m[1]);
    expect(reportStates).toEqual(["ready"]);
  });

  it("renders the report only from the ready state", () => {
    const text = screen();
    // Every read of the report is guarded by the ready state.
    for (const m of text.matchAll(/state\.report/g)) {
      expect(m.index).toBeGreaterThan(text.indexOf('state.kind === "ready"'));
    }
  });
});

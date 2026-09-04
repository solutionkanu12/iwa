// The operator area is not the saver product.
//
// Two failures are being designed against. The obvious one is the saver's
// sidebar appearing beside a page about running the platform, which makes the
// two feel like one thing and offers an operator six destinations they did not
// come for. The quieter one is a navigation entry that points at a section
// which does not exist, which is how an admin area starts growing fake pages.
//
// The shell choice and the section list are both plain data, so both are
// checked here rather than by rendering. What cannot be checked that way, that
// the components actually honour them, is checked against the shipped source.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_NAV,
  ADMIN_NAV,
  MOBILE_NAV,
  PRIMARY_NAV,
  shellFor,
  type ShellName,
} from "./navigation";
import { adminReport, type AdminOverviewFacts, type DeploymentFacts } from "../lib/adminView";
import type { Route } from "../lib/router";

const SRC = join(process.cwd(), "src");

/** Source with comment lines removed, so only what ships is examined. */
function shipped(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const adminShell = () => shipped(join(SRC, "app", "AdminShell.tsx"));
const app = () => shipped(join(SRC, "App.tsx"));

/** Every route the application has, so none is left unclassified. */
const ALL_ROUTES: Route[] = [
  { name: "landing" },
  { name: "home" },
  { name: "explore" },
  { name: "myCircles" },
  { name: "invitations" },
  { name: "circle", circleId: 1 },
  { name: "standing" },
  { name: "create" },
  { name: "invite", token: "t" },
  { name: "console" },
  { name: "admin" },
  { name: "notFound", path: "/nope" },
];

describe("which shell a route gets", () => {
  it("gives the operator area its own", () => {
    expect(shellFor({ name: "admin" })).toBe("admin");
  });

  it("leaves every other route on the ordinary shell", () => {
    for (const route of ALL_ROUTES) {
      if (route.name === "admin") continue;
      expect(shellFor(route)).toBe("app");
    }
  });

  it("sends an unrecognised path under /admin to the ordinary not found", () => {
    // /admin/anything resolves to notFound, which is a mistyped URL and not an
    // operator page. It must not inherit the operator frame.
    expect(shellFor({ name: "notFound", path: "/admin/drafts" })).toBe("app");
  });

  it("classifies every route, with no third answer", () => {
    const answers = new Set<ShellName>(ALL_ROUTES.map(shellFor));
    expect([...answers].sort()).toEqual(["admin", "app"]);
  });
});

describe("the operator area does not carry the saver's navigation", () => {
  const SAVER_DESTINATIONS = [
    "Home",
    "Explore",
    "My circles",
    "Invitations",
    "My standing",
    "Start a circle",
    "How Iwa works",
  ];

  it("renders none of the saver's destinations", () => {
    const text = adminShell();
    for (const label of SAVER_DESTINATIONS) {
      expect(text).not.toContain(label);
    }
  });

  it("imports none of the saver's navigation lists", () => {
    const text = adminShell();
    for (const list of ["PRIMARY_NAV", "ACTION_NAV", "MOBILE_NAV", "ACCOUNT_NAV", "isActive"]) {
      expect(text).not.toContain(list);
    }
  });

  it("is not the ordinary shell wearing a different name", () => {
    const text = adminShell();
    expect(text).not.toContain("AppShell");
    expect(text).not.toContain("AppShell.module.css");
  });

  it("keeps the saver's navigation free of an operator entry", () => {
    for (const nav of [PRIMARY_NAV, ACTION_NAV, MOBILE_NAV]) {
      expect(nav.map((e) => e.route.name)).not.toContain("admin");
      expect(nav.map((e) => e.label)).not.toContain("Operations");
    }
  });

  it("renders no saver mobile tab bar", () => {
    const text = adminShell();
    expect(text).not.toContain("mobileBar");
    expect(text).not.toContain("MOBILE_NAV");
  });
});

describe("the operator area's own navigation", () => {
  it("offers the sections and nothing else", () => {
    expect(ADMIN_NAV.map((e) => e.label)).toEqual([
      "Operations",
      "Overview",
      "Chain",
      "Security",
      "Product",
    ]);
  });

  it("points only at sections the report actually produces", () => {
    // The guard against fake pages. Every anchor must correspond to something
    // the admin page really renders: the operations block, or a report section.
    const facts: AdminOverviewFacts = {
      generatedAt: new Date(0).toISOString(),
      backend: {
        database: "up",
        challengeStore: "in-process",
        sessionStore: "in-process",
        liveChallenges: 0,
        liveSessions: 0,
        corsOriginsConfigured: 1,
        environment: "production",
      },
      chain: {
        chainId: "0x534e5f4d41494e",
        rpcConfigured: true,
        rpcReachable: true,
        latestBlock: 1,
        circleContract: "0x1",
        circleReadOk: true,
      },
      coordination: {
        draftsTotal: 0,
        draftsCollecting: 0,
        draftsReady: 0,
        draftsCreated: 0,
        draftsAbandoned: 0,
        placesTotal: 0,
        placesAccepted: 0,
        createdWithoutCircleId: 0,
        indexedCircles: 0,
        unrecordedChainCircles: 0,
        oldestCollectingAt: null,
        oldestReadyAt: null,
      },
    };
    const deployment: DeploymentFacts = {
      network: "0x534e5f4d41494e",
      circleContract: "0x1",
      helperContract: "0x2",
      privacyPool: "0x3",
    };
    const report = adminReport(facts, deployment, 0);

    const real = new Set(["operations", ...report.sections.map((s) => s.key)]);
    for (const entry of ADMIN_NAV) {
      expect(real.has(entry.id)).toBe(true);
    }
    // And nothing the page renders is missing from the navigation.
    expect(ADMIN_NAV.map((e) => e.id).sort()).toEqual([...real].sort());
  });

  it("anchors within one page rather than inventing routes", () => {
    const text = adminShell();
    expect(text).toContain('href={`#${entry.id}`}');
    // No second admin destination exists, so none may be navigated to.
    expect(text).not.toContain('name: "admin"');
  });

  it("gives the admin screen an anchor target for every entry", () => {
    const screen = shipped(join(SRC, "screens", "AdminView.tsx"));
    expect(screen).toContain('<section id="operations">');
    expect(screen).toContain("<section id={section.key}");
  });

  it("keeps every label short enough for a narrow screen", () => {
    for (const entry of ADMIN_NAV) {
      expect(entry.label.length).toBeLessThanOrEqual(12);
    }
  });

  it("gives every entry a distinct id and label", () => {
    expect(new Set(ADMIN_NAV.map((e) => e.id)).size).toBe(ADMIN_NAV.length);
    expect(new Set(ADMIN_NAV.map((e) => e.label)).size).toBe(ADMIN_NAV.length);
  });
});

describe("the routing change", () => {
  it("chooses the shell from the rule rather than inline", () => {
    const text = app();
    expect(text).toContain("shellFor(route)");
    expect(text).toContain("<AdminShell");
  });

  it("still renders the ordinary shell for everything else", () => {
    const text = app();
    expect(text).toContain("<AppShell route={route} navigate={navigate}>");
  });

  it("wraps the admin screen in exactly one shell", () => {
    const text = app();
    expect([...text.matchAll(/<AdminShell/g)]).toHaveLength(1);
    expect([...text.matchAll(/<AppShell/g)]).toHaveLength(1);
  });
});

describe("the shell is layout and not a permission", () => {
  it("holds no allowlist, role or gate of its own", () => {
    const text = adminShell();
    for (const banned of [
      "ADMIN_ADDRESSES",
      "allowlist",
      "isAdmin",
      "not_admin",
      "adminOverview",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("signs nothing and calls no API", () => {
    const text = adminShell();
    for (const banned of [
      "signMessage",
      "walletSigner",
      "backend.",
      "fetch(",
      "authorizedRead",
      "useSession",
      "ensureIdentity",
      "account.execute",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("reads only the connected address, to say which wallet this is", () => {
    const text = adminShell();
    expect(text).toContain("useWallet()");
    expect(text).toContain("Not connected");
  });

  it("logs nothing", () => {
    expect(adminShell()).not.toContain("console.");
  });
});

describe("the guard itself", () => {
  it("is reading real files rather than empty strings", () => {
    expect(adminShell().length).toBeGreaterThan(800);
    expect(app().length).toBeGreaterThan(500);
  });
});

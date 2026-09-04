import { describe, expect, it } from "vitest";

import {
  ADMIN_COPY,
  adminReport,
  chainName,
  daysSince,
  operationsOf,
  shortAddress,
  SOURCE_LABEL,
  type AdminOverviewFacts,
  type DeploymentFacts,
} from "./adminView";

const NOW = Date.parse("2026-09-04T00:00:00.000Z");
const DAY = 86_400_000;

const CIRCLE = "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be";
const HELPER = "0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb";
const POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

const DEPLOYMENT: DeploymentFacts = {
  network: "0x534e5f4d41494e",
  circleContract: CIRCLE,
  helperContract: HELPER,
  privacyPool: POOL,
};

function facts(over: {
  backend?: Partial<AdminOverviewFacts["backend"]>;
  chain?: Partial<AdminOverviewFacts["chain"]>;
  coordination?: Partial<AdminOverviewFacts["coordination"]>;
} = {}): AdminOverviewFacts {
  return {
    generatedAt: new Date(NOW).toISOString(),
    backend: {
      database: "up",
      challengeStore: "in-process",
      sessionStore: "in-process",
      liveChallenges: 0,
      liveSessions: 2,
      corsOriginsConfigured: 1,
      environment: "production",
      ...over.backend,
    },
    chain: {
      chainId: "0x534e5f4d41494e",
      rpcConfigured: true,
      rpcReachable: true,
      latestBlock: 1_500_000,
      circleContract: CIRCLE,
      circleReadOk: true,
      ...over.chain,
    },
    coordination: {
      draftsTotal: 4,
      draftsCollecting: 1,
      draftsReady: 0,
      draftsCreated: 2,
      draftsAbandoned: 1,
      placesTotal: 8,
      placesAccepted: 6,
      createdWithoutCircleId: 0,
      indexedCircles: 2,
      unrecordedChainCircles: 0,
      oldestCollectingAt: new Date(NOW - 2 * DAY).toISOString(),
      oldestReadyAt: null,
      ...over.coordination,
    },
  };
}

const report = (over: Parameters<typeof facts>[0] = {}) =>
  adminReport(facts(over), DEPLOYMENT, NOW);

const section = (over: Parameters<typeof facts>[0], key: string) =>
  report(over).sections.find((s) => s.key === key);

const rowValue = (over: Parameters<typeof facts>[0], sectionKey: string, rowKey: string) =>
  section(over, sectionKey)?.rows.find((r) => r.key === rowKey)?.value ?? null;

describe("overview", () => {
  it("reports the four sections and nothing more", () => {
    expect(report().sections.map((s) => s.key)).toEqual([
      "overview",
      "chain",
      "security",
      "business",
    ]);
  });

  it("states real counts from the coordination service", () => {
    expect(rowValue({}, "overview", "drafts")).toBe("4");
    expect(rowValue({}, "overview", "created")).toBe("2");
    expect(rowValue({}, "overview", "places")).toBe("6 of 8");
  });

  it("says the database is not reachable rather than showing nothing", () => {
    expect(rowValue({ backend: { database: "down" } }, "overview", "database")).toBe(
      "Not reachable",
    );
  });

  it("names the network instead of printing a chain id", () => {
    expect(rowValue({}, "overview", "network")).toBe("Starknet mainnet");
    expect(chainName("0x534e5f5345504f4c4941")).toBe("Starknet Sepolia");
  });

  it("shows an unknown chain id as itself rather than guessing", () => {
    expect(chainName("0xabc")).toBe("0xabc");
  });

  it("labels every row with where the figure came from", () => {
    for (const s of report().sections) {
      for (const row of s.rows) {
        expect(Object.keys(SOURCE_LABEL)).toContain(row.source);
      }
    }
  });

  it("never labels a coordination count as chain truth", () => {
    const overview = section({}, "overview");
    expect(overview?.rows.find((r) => r.key === "drafts")?.source).toBe("coordination");
    expect(overview?.rows.find((r) => r.key === "rpc")?.source).toBe("chain");
  });
});

describe("chain health", () => {
  it("reports the block it actually read", () => {
    expect(rowValue({}, "chain", "block")).toBe("1500000");
  });

  it("says a block is unavailable rather than zero", () => {
    expect(
      rowValue({ chain: { rpcReachable: false, latestBlock: null } }, "chain", "block"),
    ).toBe("Unavailable");
  });

  it("distinguishes an unconfigured node from an unreachable one", () => {
    expect(rowValue({ chain: { rpcConfigured: false } }, "overview", "rpc")).toBe("Not configured");
    expect(rowValue({ chain: { rpcReachable: false } }, "overview", "rpc")).toBe("Not reachable");
  });

  it("reports the contract addresses this build is pinned to", () => {
    expect(rowValue({}, "chain", "circle-address")).toBe(shortAddress(CIRCLE));
    expect(rowValue({}, "chain", "helper-address")).toBe(shortAddress(HELPER));
    expect(rowValue({}, "chain", "pool-address")).toBe(shortAddress(POOL));
  });

  it("flags a frontend and a service pointing at different circles", () => {
    expect(rowValue({ chain: { circleContract: "0xdead" } }, "chain", "address-mismatch")).toBe(
      "The app and the service point at different circles",
    );
  });

  it("says nothing about a mismatch when the addresses agree", () => {
    // Padding and case are not a mismatch.
    const padded = CIRCLE.replace("0x0", "0x00").toUpperCase().replace("0X", "0x");
    expect(rowValue({ chain: { circleContract: padded } }, "chain", "address-mismatch")).toBeNull();
  });
});

describe("security view", () => {
  it("reports where challenges and sessions live, with live counts", () => {
    expect(rowValue({}, "security", "challenges")).toBe("in-process, 0 live");
    expect(rowValue({}, "security", "sessions")).toBe("in-process, 2 live");
  });

  it("counts allowed origins without naming any", () => {
    expect(rowValue({ backend: { corsOriginsConfigured: 3 } }, "security", "cors")).toBe(
      "3 configured",
    );
    const text = JSON.stringify(report({ backend: { corsOriginsConfigured: 3 } }));
    expect(text).not.toContain("useiwa");
    expect(text).not.toContain("http");
  });

  it("states the standing limitations rather than implying none", () => {
    expect(rowValue({}, "security", "custody")).toContain("None");
    expect(rowValue({}, "security", "contracts")).toContain("Immutable");
    expect(rowValue({}, "security", "known-limit")).toContain("its own recipient");
  });
});

describe("product metrics", () => {
  it("derives a rate only when there is something to divide", () => {
    expect(rowValue({}, "business", "acceptance")).toBe("75%");
    expect(rowValue({}, "business", "completion")).toBe("50%");
  });

  it("omits a rate rather than printing a zero on an empty platform", () => {
    const empty = {
      coordination: { draftsTotal: 0, placesTotal: 0, placesAccepted: 0, draftsCreated: 0 },
    };
    expect(rowValue(empty, "business", "acceptance")).toBeNull();
    expect(rowValue(empty, "business", "completion")).toBeNull();
    expect(rowValue(empty, "business", "drafts-total")).toBe("0");
  });

  it("invents no revenue, no users and no volume", () => {
    const text = JSON.stringify(report()).toLowerCase();
    for (const banned of ["revenue", "mrr", "arr", "subscribers", "users", "volume", "usd$"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("operations", () => {
  it("has nothing to say about a healthy, quiet platform", () => {
    expect(
      operationsOf(
        facts({ coordination: { draftsCollecting: 0, oldestCollectingAt: null } }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("reports a database that is not answering", () => {
    const items = operationsOf(facts({ backend: { database: "down" } }), NOW);
    expect(items[0].key).toBe("database");
    expect(items[0].tone).toBe("attention");
  });

  it("reports an unreachable node, and separately an unconfigured one", () => {
    expect(
      operationsOf(facts({ chain: { rpcReachable: false } }), NOW).map((i) => i.key),
    ).toContain("rpc");
    expect(
      operationsOf(facts({ chain: { rpcConfigured: false } }), NOW).map((i) => i.key),
    ).toContain("rpc-missing");
  });

  it("reports a reachable node whose contract read failed", () => {
    const items = operationsOf(facts({ chain: { circleReadOk: false } }), NOW);
    expect(items.map((i) => i.key)).toContain("circle-read");
  });

  it("reports circles on chain that no draft records", () => {
    const items = operationsOf(facts({ coordination: { unrecordedChainCircles: 2 } }), NOW);
    const item = items.find((i) => i.key === "unrecorded");
    expect(item?.title).toBe("2 circles on chain are not recorded here");
    expect(item?.tone).toBe("attention");
  });

  it("leaves finishing an unrecorded circle to its own organizer", () => {
    const items = operationsOf(facts({ coordination: { unrecordedChainCircles: 1 } }), NOW);
    const item = items.find((i) => i.key === "unrecorded");
    expect(item?.title).toBe("1 circle on chain is not recorded here");
    expect(item?.detail).toBe("Each one is finished by its own organizer, from their circle setup.");
  });

  it("counts circles ready to be created and how long they have waited", () => {
    const items = operationsOf(
      facts({
        coordination: { draftsReady: 1, oldestReadyAt: new Date(NOW - 3 * DAY).toISOString() },
      }),
      NOW,
    );
    const item = items.find((i) => i.key === "ready");
    expect(item?.title).toBe("1 circle is ready to be created");
    expect(item?.detail).toContain("3 days");
    expect(item?.tone).toBe("normal");
  });

  it("raises attention only once something has genuinely been sitting", () => {
    const stale = operationsOf(
      facts({
        coordination: { draftsReady: 1, oldestReadyAt: new Date(NOW - 9 * DAY).toISOString() },
      }),
      NOW,
    );
    expect(stale.find((i) => i.key === "ready")?.tone).toBe("attention");
  });

  it("reports drafts still collecting as ordinary progress", () => {
    const item = operationsOf(facts(), NOW).find((i) => i.key === "collecting");
    expect(item?.title).toBe("1 circle is still collecting acceptances");
    expect(item?.tone).toBe("normal");
  });

  it("flags a created record that names no circle, which should never happen", () => {
    const item = operationsOf(facts({ coordination: { createdWithoutCircleId: 1 } }), NOW).find(
      (i) => i.key === "created-without-id",
    );
    expect(item?.tone).toBe("attention");
  });

  it("says nothing about an age it cannot compute", () => {
    const item = operationsOf(
      facts({ coordination: { draftsReady: 1, oldestReadyAt: null } }),
      NOW,
    ).find((i) => i.key === "ready");
    expect(item?.detail).toBe("Everyone has accepted and the organizer has not created it yet.");
  });

  it("computes an age in whole days, or nothing at all", () => {
    expect(daysSince(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(3);
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("not a date", NOW)).toBeNull();
  });
});

describe("what the operator view refuses to carry", () => {
  it("offers no control that could move money or act for anybody", () => {
    // Deliberately phrases rather than single words. "A round settles only when
    // its own recipient authorizes it" is the honest statement of a limitation
    // and must stay exactly as it is; what may never appear is an operator
    // being offered the thing.
    const text = (JSON.stringify(report()) + JSON.stringify(ADMIN_COPY)).toLowerCase();
    for (const banned of [
      "finalize payout",
      "finalize round",
      "settle payout",
      "release payout",
      "release funds",
      "move funds",
      "seize",
      "withdraw",
      "impersonate",
      "override",
      "skip member",
      "change recipient",
      "normalize surplus",
      "pause contract",
      "upgrade contract",
      "contribute for",
      "join for",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("gives no row or item a name that reads like an action", () => {
    const r = report({ coordination: { unrecordedChainCircles: 1, draftsReady: 1 } });
    const names = [
      ...r.sections.flatMap((s) => [s.key, s.title, ...s.rows.flatMap((x) => [x.key, x.label])]),
      ...r.operations.map((i) => i.key),
    ];
    for (const name of names) {
      for (const verb of ["fix", "repair", "retry", "resend", "force", "reset", "delete", "run"]) {
        expect(name.toLowerCase()).not.toContain(verb);
      }
    }
  });

  it("says out loud that it only reports", () => {
    expect(ADMIN_COPY.readOnly).toContain("reports and does nothing else");
  });

  it("carries no member identifier or wallet", () => {
    const text = JSON.stringify(report());
    for (const banned of [
      "memberRef",
      "member_ref",
      "authPublicKey",
      "inviteToken",
      "organizerAddress",
      "acceptedByAddress",
      "viewingKey",
      "secret",
      "commitment",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("keeps every label short enough for a narrow screen", () => {
    for (const s of report().sections) {
      for (const row of s.rows) expect(row.label.length).toBeLessThanOrEqual(22);
    }
  });

  it("uses no dash characters the design forbids", () => {
    const text = JSON.stringify(report({ chain: { circleContract: "0xdead" } })) +
      JSON.stringify(ADMIN_COPY) +
      JSON.stringify(SOURCE_LABEL);
    expect(text).not.toMatch(/[–—]/);
  });

  it("shortens a contract address rather than printing 66 characters", () => {
    expect(shortAddress(CIRCLE).length).toBeLessThan(16);
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});

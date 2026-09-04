// lib/adminView.ts — the platform, for the people who run it.
//
// An operator asks four questions and no others. Is the service up. Is anything
// stuck. Is the security posture what we think it is. And is the product being
// used. This turns the figures the service returns into those four answers, and
// refuses to turn them into anything else.
//
// WHAT AN OPERATOR IS NOT
//
// Not a party to anybody's savings. Every figure here is a count, a health flag
// or a public contract address, because the API deliberately returns nothing
// else: no wallet, no member reference, no invitation, no draft, no circle
// membership. An operator can see that four drafts are waiting and cannot see
// whose they are, which is the whole design rather than an omission.
//
// Not a party to anybody's money either. There is no control in this file, no
// action, and nothing that could become one: Iwa's deployed contracts hold no
// administrative power to reach, so an operator surface that offered a button
// would be offering something that does not exist.
//
// WHERE EACH FIGURE COMES FROM
//
// Three sources, and they are not interchangeable. The coordination service
// knows what it recorded, the chain knows what actually happened, and the
// deployment knows what it was configured with. A count of drafts is not
// evidence about Starknet, and a reachable node is not evidence that a record
// exists. Every row carries its source so the two are never read as one.
//
// Pure and synchronous, so the exact picture an operator saw can be replayed in
// a test from the same numbers.

/** Where a figure came from. Never mixed, and always shown. */
export type FactSource = "coordination" | "chain" | "config";

export const SOURCE_LABEL: Record<FactSource, string> = {
  coordination: "From the coordination service",
  chain: "Read live from Starknet",
  config: "From this deployment's configuration",
};

export interface AdminRow {
  key: string;
  label: string;
  value: string;
  source: FactSource;
}

export interface AdminSection {
  key: string;
  title: string;
  rows: AdminRow[];
}

/** One thing an operator might have to look into. Reported, never actioned. */
export interface OperationsItem {
  key: string;
  title: string;
  detail: string;
  /** Whether somebody should look now, or whether it is ordinary progress. */
  tone: "attention" | "normal";
}

// ---------------------------------------------------------------- the facts

export interface BackendFacts {
  database: "up" | "down";
  challengeStore: string;
  sessionStore: string;
  liveChallenges: number;
  liveSessions: number;
  corsOriginsConfigured: number;
  environment: string;
}

export interface ChainFacts {
  chainId: string;
  rpcConfigured: boolean;
  rpcReachable: boolean;
  latestBlock: number | null;
  circleContract: string;
  circleReadOk: boolean;
}

export interface CoordinationFacts {
  draftsTotal: number;
  draftsCollecting: number;
  draftsReady: number;
  draftsCreated: number;
  draftsAbandoned: number;
  placesTotal: number;
  placesAccepted: number;
  createdWithoutCircleId: number;
  indexedCircles: number;
  unrecordedChainCircles: number;
  oldestCollectingAt: string | null;
  oldestReadyAt: string | null;
}

/** Exactly what the service returns. */
export interface AdminOverviewFacts {
  generatedAt: string;
  backend: BackendFacts;
  chain: ChainFacts;
  coordination: CoordinationFacts;
}

/**
 * What this build was pinned to.
 *
 * The frontend's own deployment configuration, which is a third source and is
 * labelled as one. Cross-checking it against what the service reports is worth
 * doing: a frontend and a backend pointing at different circle contracts is an
 * operational fault that nothing else would surface.
 */
export interface DeploymentFacts {
  network: string;
  circleContract: string;
  helperContract: string;
  privacyPool: string;
}

export interface AdminReport {
  sections: AdminSection[];
  operations: OperationsItem[];
  /** Read at this moment, in words. */
  generatedAt: string;
}

const CHAIN_NAMES: Record<string, string> = {
  "0x534e5f4d41494e": "Starknet mainnet",
  "0x534e5f5345504f4c4941": "Starknet Sepolia",
};

/** A chain id as a name, or the id itself when it is not one we ship against. */
export function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId.toLowerCase()] ?? chainId;
}

/** An address, shortened. Contract addresses only: no wallet reaches this file. */
export function shortAddress(address: string): string {
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const yesNo = (value: boolean, yes: string, no: string): string => (value ? yes : no);

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Days between an ISO timestamp and now, or null when there is no timestamp. */
export function daysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / 86_400_000);
}

/** "today", "1 day", "6 days". Days only: an hour count implies a precision
 * that a record's clock and an operator's clock do not really share. */
function ageWords(days: number): string {
  if (days <= 0) return "today";
  return plural(days, "1 day", `${days} days`);
}

// --------------------------------------------------------------- the report

function overviewSection(facts: AdminOverviewFacts): AdminSection {
  const c = facts.coordination;
  return {
    key: "overview",
    title: "Overview",
    rows: [
      {
        key: "database",
        label: "Database",
        value: facts.backend.database === "up" ? "Reachable" : "Not reachable",
        source: "coordination",
      },
      {
        key: "network",
        label: "Network",
        value: chainName(facts.chain.chainId),
        source: "config",
      },
      {
        key: "rpc",
        label: "Starknet node",
        value: !facts.chain.rpcConfigured
          ? "Not configured"
          : yesNo(facts.chain.rpcReachable, "Reachable", "Not reachable"),
        source: "chain",
      },
      {
        key: "drafts",
        label: "Circles set up",
        value: String(c.draftsTotal),
        source: "coordination",
      },
      {
        key: "created",
        label: "Circles created",
        value: String(c.draftsCreated),
        source: "coordination",
      },
      {
        key: "places",
        label: "Places accepted",
        value: `${c.placesAccepted} of ${c.placesTotal}`,
        source: "coordination",
      },
    ],
  };
}

function chainSection(facts: AdminOverviewFacts, deployment: DeploymentFacts): AdminSection {
  const rows: AdminRow[] = [
    {
      key: "block",
      label: "Latest block",
      value: facts.chain.latestBlock === null ? "Unavailable" : String(facts.chain.latestBlock),
      source: "chain",
    },
    {
      key: "circle-read",
      label: "Circle contract",
      value: yesNo(facts.chain.circleReadOk, "Answering reads", "Not answering"),
      source: "chain",
    },
    {
      key: "circle-address",
      label: "Circle address",
      value: shortAddress(deployment.circleContract),
      source: "config",
    },
    {
      key: "helper-address",
      label: "Settlement helper",
      value: shortAddress(deployment.helperContract),
      source: "config",
    },
    {
      key: "pool-address",
      label: "Privacy pool",
      value: shortAddress(deployment.privacyPool),
      source: "config",
    },
  ];

  // A frontend and a service pointing at different circle contracts is a fault
  // nothing else would surface, and it is worth one row when it happens.
  if (!sameAddress(facts.chain.circleContract, deployment.circleContract)) {
    rows.push({
      key: "address-mismatch",
      label: "Contract match",
      value: "The app and the service point at different circles",
      source: "config",
    });
  }

  return { key: "chain", title: "Chain", rows };
}

function securitySection(facts: AdminOverviewFacts): AdminSection {
  return {
    key: "security",
    title: "Security",
    rows: [
      {
        key: "environment",
        label: "Environment",
        value: facts.backend.environment,
        source: "config",
      },
      {
        key: "challenges",
        label: "Sign in challenges",
        value: `${facts.backend.challengeStore}, ${facts.backend.liveChallenges} live`,
        source: "coordination",
      },
      {
        key: "sessions",
        label: "Read sessions",
        value: `${facts.backend.sessionStore}, ${facts.backend.liveSessions} live`,
        source: "coordination",
      },
      {
        key: "cors",
        label: "Allowed origins",
        value: plural(
          facts.backend.corsOriginsConfigured,
          "1 configured",
          `${facts.backend.corsOriginsConfigured} configured`,
        ),
        source: "config",
      },
      {
        key: "custody",
        label: "Custody",
        value: "None. Iwa holds no funds and signs nothing",
        source: "config",
      },
      {
        key: "contracts",
        label: "Contracts",
        value: "Immutable. No owner, no pause, no upgrade",
        source: "config",
      },
      {
        key: "known-limit",
        label: "Known limitation",
        value: "A round settles only when its own recipient authorizes it",
        source: "config",
      },
    ],
  };
}

function businessSection(facts: AdminOverviewFacts): AdminSection {
  const c = facts.coordination;
  const rows: AdminRow[] = [
    { key: "drafts-total", label: "Circles set up", value: String(c.draftsTotal), source: "coordination" },
    { key: "drafts-created", label: "Reached creation", value: String(c.draftsCreated), source: "coordination" },
    { key: "drafts-abandoned", label: "Abandoned", value: String(c.draftsAbandoned), source: "coordination" },
  ];

  // A rate needs a denominator. With no drafts there is nothing to divide, and
  // printing a zero would read as a failure rather than as an empty platform.
  if (c.placesTotal > 0) {
    rows.push({
      key: "acceptance",
      label: "Places accepted",
      value: `${Math.round((c.placesAccepted / c.placesTotal) * 100)}%`,
      source: "coordination",
    });
  }
  if (c.draftsTotal > 0) {
    rows.push({
      key: "completion",
      label: "Setup completed",
      value: `${Math.round((c.draftsCreated / c.draftsTotal) * 100)}%`,
      source: "coordination",
    });
  }
  rows.push({
    key: "indexed",
    label: "Circles seen on chain",
    value: String(c.indexedCircles),
    source: "chain",
  });

  return { key: "business", title: "Product", rows };
}

/** Two addresses, compared as numbers. Padding and case are not differences. */
function sameAddress(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

/**
 * What an operator might have to look into.
 *
 * Report only. Every item here is resolved by somebody else acting for
 * themselves: an organizer finishing their own setup, an invited person
 * accepting, a node coming back. None of it is an operator's to fix, and none
 * of it is offered as an action.
 */
export function operationsOf(facts: AdminOverviewFacts, now: number): OperationsItem[] {
  const c = facts.coordination;
  const items: OperationsItem[] = [];

  if (facts.backend.database === "down") {
    items.push({
      key: "database",
      title: "The database is not answering",
      detail: "Coordination counts on this page may be out of date or missing.",
      tone: "attention",
    });
  }

  if (!facts.chain.rpcConfigured) {
    items.push({
      key: "rpc-missing",
      title: "No Starknet node is configured",
      detail: "The service cannot check the chain until one is set.",
      tone: "attention",
    });
  } else if (!facts.chain.rpcReachable) {
    items.push({
      key: "rpc",
      title: "Starknet cannot be reached",
      detail: "Chain figures on this page are unavailable rather than zero.",
      tone: "attention",
    });
  } else if (!facts.chain.circleReadOk) {
    items.push({
      key: "circle-read",
      title: "The circle contract did not answer",
      detail: "The node is reachable but the contract read failed.",
      tone: "attention",
    });
  }

  if (c.unrecordedChainCircles > 0) {
    items.push({
      key: "unrecorded",
      title: plural(
        c.unrecordedChainCircles,
        "1 circle on chain is not recorded here",
        `${c.unrecordedChainCircles} circles on chain are not recorded here`,
      ),
      // The organizer's own reconciliation is the path, and it is theirs. This
      // says the state exists and stops, because an operator finishing somebody
      // else's setup is a power Iwa does not grant.
      detail: "Each one is finished by its own organizer, from their circle setup.",
      tone: "attention",
    });
  }

  if (c.createdWithoutCircleId > 0) {
    items.push({
      key: "created-without-id",
      title: plural(
        c.createdWithoutCircleId,
        "1 record says created without naming a circle",
        `${c.createdWithoutCircleId} records say created without naming a circle`,
      ),
      detail: "This should not happen and is worth looking at.",
      tone: "attention",
    });
  }

  const readyDays = daysSince(c.oldestReadyAt, now);
  if (c.draftsReady > 0) {
    items.push({
      key: "ready",
      title: plural(
        c.draftsReady,
        "1 circle is ready to be created",
        `${c.draftsReady} circles are ready to be created`,
      ),
      detail:
        readyDays === null
          ? "Everyone has accepted and the organizer has not created it yet."
          : `Everyone has accepted. The oldest has been waiting ${ageWords(readyDays)}.`,
      tone: readyDays !== null && readyDays >= 7 ? "attention" : "normal",
    });
  }

  const collectingDays = daysSince(c.oldestCollectingAt, now);
  if (c.draftsCollecting > 0) {
    items.push({
      key: "collecting",
      title: plural(
        c.draftsCollecting,
        "1 circle is still collecting acceptances",
        `${c.draftsCollecting} circles are still collecting acceptances`,
      ),
      detail:
        collectingDays === null
          ? "Waiting on the people who were invited."
          : `Waiting on invited people. The oldest has been open ${ageWords(collectingDays)}.`,
      tone: collectingDays !== null && collectingDays >= 14 ? "attention" : "normal",
    });
  }

  return items;
}

/** Everything the operator screen renders. */
export function adminReport(
  facts: AdminOverviewFacts,
  deployment: DeploymentFacts,
  now: number,
): AdminReport {
  return {
    sections: [
      overviewSection(facts),
      chainSection(facts, deployment),
      securitySection(facts),
      businessSection(facts),
    ],
    operations: operationsOf(facts, now),
    generatedAt: facts.generatedAt,
  };
}

/**
 * The words.
 *
 * Nothing here is a boast and nothing is an alarm. An operator reading a quiet
 * platform should be told it is quiet, which is different from being shown an
 * empty page.
 */
export const ADMIN_COPY = {
  heading: "Operations",
  lede: "How Iwa is running. Counts only, and nothing about any individual saver.",
  signedOut: "Connect the wallet that operates Iwa.",
  needsAuth: "Reading this asks your wallet to confirm once.",
  needsAuthAction: "Open operations",
  loading: "Reading the platform",
  failedAction: "Try again",
  forbidden: "This wallet does not operate Iwa.",
  forbiddenDetail: "Nothing here is available on this wallet.",
  failed: "The platform could not be read just now.",
  nothingOperational: "Nothing needs looking at.",
  operationsHeading: "Needs looking at",
  readOnly:
    "This view reports and does nothing else. Iwa holds no funds, and no operator can move a payout, join, contribute or act for a member.",
} as const;

// Opening the front door must never ask for a signature.
//
// This is a product rule with a security reason behind it. Every wallet prompt
// Iwa shows is meant to be one the person asked for, because the moment prompts
// start arriving uninvited people begin approving them without reading, and
// every protection in this product rests on them reading.
//
// So these tests are about restraint. Most of them assert that nothing happens.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  actionCenterView,
  HOME_COPY,
  shouldLoadActionCenter,
  type HomeState,
} from "./homeActions";
import type { CircleTask } from "./actionCenter";

const task: CircleTask = {
  key: "due-a",
  title: "Contribution due",
  detail: "Round 1.",
  priority: "soon",
  audience: "member",
  circleId: 1,
  draftId: "a",
};

const state = (over: Partial<HomeState> = {}): HomeState => ({
  connected: true,
  hasSession: false,
  requested: false,
  loading: false,
  tasks: null,
  failed: false,
  ...over,
});

describe("Home never asks for a signature by itself", () => {
  // The one that matters. A connected wallet with no session, sitting on Home,
  // must not cause a read, because a read is what creates the session and the
  // session is what costs a signature.
  it("does not load private data on a wallet with no session", () => {
    expect(shouldLoadActionCenter(state())).toBe(false);
  });

  it("does not load anything at all without a wallet", () => {
    expect(shouldLoadActionCenter(state({ connected: false }))).toBe(false);
    expect(shouldLoadActionCenter(state({ connected: false, requested: true }))).toBe(false);
    expect(shouldLoadActionCenter(state({ connected: false, hasSession: true }))).toBe(false);
  });

  it("shows a calm invitation rather than a prompt", () => {
    expect(actionCenterView(state()).kind).toBe("needsSession");
    expect(HOME_COPY.needsSessionAction).toBe("Check my circles");
  });

  it("renders no private task before anybody has authenticated", () => {
    const view = actionCenterView(state());
    expect(view).not.toHaveProperty("tasks");
  });

  it("says nothing private to a visitor with no wallet", () => {
    const view = actionCenterView(state({ connected: false }));
    expect(view.kind).toBe("signedOut");
    expect(view).not.toHaveProperty("tasks");
  });
});

describe("what the person asks for, they get", () => {
  it("loads once they press the button", () => {
    expect(shouldLoadActionCenter(state({ requested: true }))).toBe(true);
  });

  it("loads by itself when a session already exists, with no prompt", () => {
    // The signature was already given, earlier, for something they did ask for.
    // Spending it here costs them nothing.
    expect(shouldLoadActionCenter(state({ hasSession: true }))).toBe(true);
  });

  it("shows the tasks once they are in", () => {
    const view = actionCenterView(state({ hasSession: true, tasks: [task] }));
    expect(view).toEqual({ kind: "ready", tasks: [task] });
  });

  it("shows the calm empty state when there is nothing to do", () => {
    const view = actionCenterView(state({ hasSession: true, tasks: [] }));
    expect(view).toEqual({ kind: "ready", tasks: [] });
    expect(HOME_COPY.nothing).toBe("You are up to date.");
  });
});

describe("nothing repeats itself", () => {
  it("does not start a second load while one is running", () => {
    expect(shouldLoadActionCenter(state({ requested: true, loading: true }))).toBe(false);
    expect(shouldLoadActionCenter(state({ hasSession: true, loading: true }))).toBe(false);
  });

  it("does not reload once it has an answer", () => {
    expect(shouldLoadActionCenter(state({ hasSession: true, tasks: [] }))).toBe(false);
    expect(shouldLoadActionCenter(state({ hasSession: true, tasks: [task] }))).toBe(false);
  });

  // A declined signature or a failed read must not become a loop that asks
  // again on every render. It waits to be asked.
  it("stops after a failure until the person asks again", () => {
    const failed = state({ requested: true, failed: true });
    expect(shouldLoadActionCenter(failed)).toBe(false);
    expect(actionCenterView(failed).kind).toBe("failed");
    expect(HOME_COPY.failedAction).toBe("Try again");
  });

  it("tries again only on a fresh request", () => {
    // Clearing `failed` is what the retry button does.
    expect(shouldLoadActionCenter(state({ requested: true, failed: false }))).toBe(true);
  });
});

describe("a session that ends", () => {
  // The session expired or was dropped. Home goes back to being quiet, and does
  // not silently re-sign to replace it.
  it("returns to the calm state rather than signing again", () => {
    const expired = state({ hasSession: false, requested: false, tasks: null });
    expect(actionCenterView(expired).kind).toBe("needsSession");
    expect(shouldLoadActionCenter(expired)).toBe(false);
  });

  it("shows nothing private once the wallet is gone", () => {
    const gone = state({ connected: false, hasSession: false, tasks: null });
    expect(actionCenterView(gone).kind).toBe("signedOut");
  });
});

describe("the words", () => {
  it("never mention a wallet prompt, a session or a signature", () => {
    for (const text of Object.values(HOME_COPY)) {
      const lower = text.toLowerCase();
      for (const jargon of ["signature", "sign a", "session", "authorize", "on-chain", "nonce"]) {
        expect(lower).not.toContain(jargon);
      }
    }
  });

  it("uses no dashes and no exclamation marks", () => {
    for (const text of Object.values(HOME_COPY)) expect(text).not.toMatch(/[—–!]/);
  });
});

// The rule has to hold in the screen, not only in the module it imports. This
// reads HomeView and checks the gate is actually the thing guarding the read.
describe("the screen obeys the rule", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../screens/HomeView.tsx", import.meta.url)),
    "utf8",
  );

  it("guards its load with the gate rather than calling on mount", () => {
    expect(source).toContain("shouldLoadActionCenter");
  });

  it("reaches private data through exactly one call site", () => {
    expect([...source.matchAll(/authorizedRead\(/g)]).toHaveLength(1);
  });

  it("has no effect that reads private data unconditionally", () => {
    // Every effect that can trigger the load must mention the gate. An effect
    // body that calls load() with no gate is the exact regression this whole
    // file exists to prevent.
    const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map(
      (m) => m[1] as string,
    );
    for (const body of effects) {
      if (body.includes("load(")) expect(body).toContain("shouldLoad");
    }
  });
});

// Phase 7B added a public read to the same load, so that an organizer is told
// when their circle is stuck on somebody who never joined. Public is the whole
// point: it must not have moved the identity derivation, which is the one step
// in here that opens a wallet.
describe("the front door after the organizer tasks arrived", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../screens/HomeView.tsx", import.meta.url)),
    "utf8",
  );

  it("derives the member identity only for a circle this wallet has a place in", () => {
    expect(source).toContain("live.some((a) => a.accepted) ? await ensureIdentity() : null");
    expect([...source.matchAll(/ensureIdentity\(\)/g)]).toHaveLength(1);
  });

  it("still reaches private data through exactly one call site", () => {
    expect([...source.matchAll(/authorizedRead\(/g)]).toHaveLength(1);
  });

  it("asks the wallet to sign nothing", () => {
    for (const banned of ["signMessage", "account.execute", "createSession("]) {
      expect(source).not.toContain(banned);
    }
  });
});

// The session must not reach anything that moves money.
//
// A read-only session is a bearer token. Bearer tokens spread: they are easy to
// pass along, and a helper that takes one is a helper somebody will reuse. So
// this asserts, against the source rather than against intent, that the token
// stays inside the four private reads and never appears anywhere a transaction
// is built, signed or sent.
//
// Nothing here replaces the service-side enforcement, which is what actually
// refuses a session on a mutation. This is the second line: it makes the
// separation visible in the client too, and turns erosion of it into a failing
// test.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = fileURLToPath(new URL("..", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(src, relative), "utf8");
}

/**
 * The file with its comments removed.
 *
 * These guards are about what the code does, and the comments here say at
 * length what it deliberately does not do. Matching prose would make a file
 * fail for explaining itself.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every .ts/.tsx file under a directory. */
function filesUnder(relative: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(join(src, relative));
  return out;
}

const backendClient = read("lib/backend.ts");

describe("only reads take a session", () => {
  // The four. Each answers a question about the caller's own coordination data.
  it("routes exactly the four private reads through the read path", () => {
    expect([...backendClient.matchAll(/return readCall\(/g)]).toHaveLength(4);
  });

  it("keeps every mutation on a per-request signature", () => {
    for (const method of ["createDraft", "reorder", "reconcile", "markCreated"]) {
      const body = backendClient.slice(
        backendClient.indexOf(`async ${method}(`),
        backendClient.indexOf("},", backendClient.indexOf(`async ${method}(`)),
      );
      expect(body).toContain("signedCall(");
      expect(body).not.toContain("readCall(");
      expect(body).not.toContain("ReadAuth");
    }
  });

  it("sends the bearer token from exactly one place", () => {
    expect([...backendClient.matchAll(/Bearer \$\{/g)]).toHaveLength(2); // one read, one revoke
  });

  // Signing in is itself an action-bound signature. A session that could mint
  // another session would never end.
  it("mints a session with a signature, not with a session", () => {
    const body = backendClient.slice(
      backendClient.indexOf("async createSession("),
      backendClient.indexOf("},", backendClient.indexOf("async createSession(")),
    );
    expect(body).toContain("signedCall(");
    expect(body).toContain("AUTH_ACTIONS.sessionCreate");
  });
});

describe("nothing that moves money knows a session exists", () => {
  // Every chain adapter, every settlement path, every contract call. If a
  // session token ever reaches one of these, the credential separating reading
  // from spending has stopped separating anything.
  const moneyPaths = [...filesUnder("chains"), join(src, "lib/iwaStarknet.ts")];

  it("covers the chain and settlement code", () => {
    expect(moneyPaths.length).toBeGreaterThan(5);
  });

  it("never references the session provider, its holder, or a bearer token", () => {
    const offenders = moneyPaths.filter((file) => {
      const text = code(readFileSync(file, "utf8"));
      return (
        text.includes("SessionProvider") ||
        text.includes("sessionHolder") ||
        text.includes("useSession") ||
        text.includes("ReadAuth") ||
        /\bBearer\b/.test(text)
      );
    });
    expect(offenders.map((f) => f.slice(src.length))).toEqual([]);
  });
});

describe("the token is never written anywhere it could outlive the tab", () => {
  const held = ["app/SessionProvider.tsx", "app/sessionHolder.ts", "lib/backend.ts"];

  it("uses no browser storage of any kind", () => {
    for (const file of held) {
      const text = code(read(file));
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it("never puts a token in a URL", () => {
    const holder = code(read("app/sessionHolder.ts"));
    expect(holder).not.toMatch(/location|history\.|searchParams/);
  });
});

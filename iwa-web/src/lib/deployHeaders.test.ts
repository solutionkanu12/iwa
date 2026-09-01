// The headers the browser is told to enforce.
//
// They live in vercel.json, which nothing else validates, so a directive can be
// dropped or loosened in a hurry and nobody would notice until it mattered.
// This reads the real file and pins what each header is for.
//
// What these do and do not do, stated plainly so nobody over-trusts them:
// a policy is defence in depth, not a substitute for not having an injection;
// frame-ancestors stops a page being framed, it does not make a wallet
// confirmation safe; and a referrer policy hides an invite link from other
// sites, not from the person holding it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(join(process.cwd(), "..", "vercel.json"), "utf8"),
) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
  rewrites: { source: string; destination: string }[];
};

const all = config.headers[0].headers;
const header = (key: string) => all.find((h) => h.key === key)?.value ?? "";
const csp = header("Content-Security-Policy");

/** One CSP directive's sources. */
function directive(name: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (found === undefined) return [];
  return found.split(/\s+/).slice(1);
}

describe("the headers apply to the whole site", () => {
  it("covers every path", () => {
    expect(config.headers).toHaveLength(1);
    expect(config.headers[0].source).toBe("/(.*)");
  });
});

describe("script execution", () => {
  // The build emits one module script with a src and no inline script, so this
  // needs no nonce, no hash and no allowance. It is the directive that matters
  // most and it is the tightest one here.
  it("allows scripts only from this origin", () => {
    expect(directive("script-src")).toEqual(["'self'"]);
  });

  it("permits no inline script and no eval", () => {
    expect(csp).not.toContain("'unsafe-inline' 'unsafe-eval'");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    // Proof generation is closed in this build, so nothing instantiates wasm.
    // Turning it back on means adding 'wasm-unsafe-eval' here, deliberately.
    expect(directive("script-src")).not.toContain("'wasm-unsafe-eval'");
  });

  it("forbids plugins and pins the base url", () => {
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
  });

  it("allows no workers, since nothing creates one", () => {
    expect(directive("worker-src")).toEqual(["'none'"]);
  });
});

describe("framing", () => {
  // A wallet confirmation shown inside somebody else's page is the attack this
  // closes. It does not make the confirmation itself safe; it stops the page
  // being wrapped at all.
  it("refuses to be framed by anyone", () => {
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
  });

  it("carries the legacy header too, for anything that ignores CSP", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
  });
});

describe("where the app may talk", () => {
  // Exactly what the app uses: itself, the Starknet RPC it is configured with,
  // and the coordination service. Wallet extensions run outside the page and
  // are unaffected by this, and wallet discovery makes no network call at all.
  it("allows only the origins the app actually calls", () => {
    expect(directive("connect-src").sort()).toEqual(
      [
        "'self'",
        "https://api.cartridge.gg",
        "https://iwa-production-2900.up.railway.app",
      ].sort(),
    );
  });

  it("uses no wildcard anywhere", () => {
    expect(csp).not.toContain("*");
  });
});

describe("styles, fonts and images", () => {
  // 'unsafe-inline' for styles is required by the inline style attributes the
  // screens use for progress widths and animation delays. The exposure is CSS
  // injection, not script execution, and script-src stays strict. Removing the
  // remaining inline styles would let this be dropped.
  it("allows the google fonts stylesheet and inline style attributes", () => {
    expect(directive("style-src")).toContain("'self'");
    expect(directive("style-src")).toContain("https://fonts.googleapis.com");
    expect(directive("style-src")).toContain("'unsafe-inline'");
  });

  it("allows font files only from the font host", () => {
    expect(directive("font-src").sort()).toEqual(["'self'", "https://fonts.gstatic.com"].sort());
  });

  it("allows images from this origin and inline svg data", () => {
    expect(directive("img-src").sort()).toEqual(["'self'", "data:"].sort());
  });

  it("falls back to this origin for anything unlisted", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
  });
});

// An invite link carries a token in its path. If that link is open and the
// person clicks through to another site, a lax policy would hand the token to
// that site in the Referer header.
describe("invite links do not leak", () => {
  it("sends no referrer to anywhere", () => {
    expect(header("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("device capabilities", () => {
  it("turns off everything the app does not use", () => {
    const policy = header("Permissions-Policy");
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "payment",
      "usb",
      "serial",
      "bluetooth",
      "midi",
      "hid",
    ]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});

describe("content type", () => {
  it("refuses mime sniffing", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
  });
});

// Adding headers must not disturb the routes. A lost rewrite is a 404 on every
// deep link.
describe("the routes are untouched", () => {
  it("still rewrites every application path to the app", () => {
    expect(config.rewrites.map((r) => r.source)).toEqual([
      "/",
      "/app",
      "/app/(.*)",
      "/strk20",
      "/start",
      "/invite/(.*)",
    ]);
    for (const rewrite of config.rewrites) {
      expect(rewrite.destination).toBe("/index.html");
    }
  });

  it("adds no redirect and no caching rule", () => {
    expect(config).not.toHaveProperty("redirects");
    expect(JSON.stringify(config)).not.toContain("Cache-Control");
  });
});

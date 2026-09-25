import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL(".", import.meta.url));

function productionSource(): string {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .map((text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))
    .join("\n");
}

describe("wallet vault secret boundary", () => {
  it("does not use web storage, cookies, URL state, telemetry, logs, or a network transport", () => {
    const source = productionSource();
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "location.search",
      "URLSearchParams",
      "console.",
      "telemetry",
      "sendBeacon",
      "fetch(",
      "XMLHttpRequest",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("has no signing, account-session, external-wallet, or chain SDK dependency", () => {
    const source = productionSource();
    for (const forbidden of ["signTransaction", "signMessage", "WalletAccountV6", "get-starknet", "IwaAccount", "Bearer "]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

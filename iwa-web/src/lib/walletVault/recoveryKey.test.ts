import { describe, expect, it } from "vitest";

import { VaultError } from "./vaultCrypto";
import {
  createRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
} from "./recoveryKey";

describe("Iwa Wallet recovery key code", () => {
  it("encodes an independently held 32-byte recovery key in an exact portable code", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const code = formatRecoveryKey(bytes);

    expect(code).toMatch(/^iwa-recovery-v1\.[A-Za-z0-9_-]{43}$/);
    expect(parseRecoveryKey(code)).toEqual(bytes);
    expect(code).not.toContain("wallet");
  });

  it("rejects malformed, shortened, extended, and wrong-version recovery codes", () => {
    const code = formatRecoveryKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));

    for (const malformed of [
      "",
      code.slice(0, -1),
      `${code}A`,
      code.replace("iwa-recovery-v1", "iwa-recovery-v2"),
      `${code.slice(0, 17)}.${code.slice(18)}`,
    ]) {
      expect(() => parseRecoveryKey(malformed)).toThrow(VaultError);
    }
  });

  it("creates fresh high-entropy keys without persisting or serializing them", () => {
    const first = createRecoveryKey();
    const second = createRecoveryKey();

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(first).not.toEqual(second);
    expect(JSON.stringify({ first })).not.toContain(formatRecoveryKey(first));
  });
});

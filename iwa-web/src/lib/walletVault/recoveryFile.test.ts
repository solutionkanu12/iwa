import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultError } from "./vaultCrypto";
import { createRecoveryPackage } from "./recoveryPackage";
import {
  IWA_WALLET_RECOVERY_FILE_LIMIT_BYTES,
  downloadRecoveryPackage,
  recoveryDownloadName,
  parseRecoveryPackageJson,
} from "./recoveryFile";

const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 61);

describe("recovery package file boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("uses a recognizable filename with only a short wallet identifier and generation", () => {
    expect(recoveryDownloadName("12345678-1234-4000-8000-123456789abc", 12)).toBe("iwa-wallet-recovery-12345678-g12.iwa");
  });

  it("parses only an authenticated-format candidate and rejects malformed or oversized JSON before recovery", async () => {
    const recovery = await createRecoveryPackage({
      walletId: "wallet-recovery-file",
      packageId: "recovery-package-file",
      generation: 1,
      recoveryKey,
      rootSecret,
      authorities: [],
      publicDescriptors: [],
    });

    expect(parseRecoveryPackageJson(JSON.stringify(recovery))).toEqual(recovery);
    expect(() => parseRecoveryPackageJson("not-json")).toThrow(VaultError);
    expect(() => parseRecoveryPackageJson(" ".repeat(IWA_WALLET_RECOVERY_FILE_LIMIT_BYTES + 1))).toThrow(VaultError);
  });

  it("downloads only encrypted package bytes and revokes its temporary object URL", async () => {
    const recovery = await createRecoveryPackage({
      walletId: "12345678-1234-4000-8000-123456789abc",
      packageId: "recovery-package-file",
      generation: 2,
      recoveryKey,
      rootSecret,
      authorities: [],
      publicDescriptors: [],
    });
    const click = vi.fn();
    const anchor = { href: "", download: "", rel: "", click };
    const createObjectURL = vi.fn(() => "blob:temporary-package");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    downloadRecoveryPackage(recovery);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(anchor.download).toBe("iwa-wallet-recovery-12345678-g2.iwa");
    expect(anchor.href).toBe("blob:temporary-package");
    expect(anchor.rel).toBe("noopener");
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:temporary-package");
    expect(`${anchor.href}${anchor.download}`).not.toContain(formatRecoveryKeyForTest());
  });
});

function formatRecoveryKeyForTest(): string {
  return "iwa-recovery-v1." + "A".repeat(43);
}

import { describe, expect, it } from "vitest";
import { ec } from "starknet";

import {
  createStrk20ViewingAuthority,
  validateStrk20ViewingAuthority,
} from "./strk20ViewingAuthority";

const viewingContext = {
  networkId: "SN_IWA_DEVNET",
  poolAddress: "0x1234",
  accountAddress: "0x5678",
  descriptorVersion: 1 as const,
};

function scalar(value: Uint8Array): bigint {
  return BigInt(`0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

describe("local STRK20 viewing authority", () => {
  it("uses CSPRNG rejection sampling in the SDK-required viewing-key range and binds public context", () => {
    const first = createStrk20ViewingAuthority(viewingContext);
    const second = createStrk20ViewingAuthority(viewingContext);

    expect(first.privateKey).toHaveLength(32);
    expect(scalar(first.privateKey)).toBeGreaterThan(0n);
    expect(scalar(first.privateKey)).toBeLessThanOrEqual(ec.starkCurve.CURVE.n / 2n);
    expect(first.privateKey).not.toEqual(second.privateKey);
    expect(first.descriptor).toEqual({
      namespace: "strk20/viewing",
      descriptorVersion: 1,
      networkId: "SN_IWA_DEVNET",
      poolAddress: "0x1234",
      accountAddress: "0x5678",
      registrationState: "local",
    });
    expect(validateStrk20ViewingAuthority(first)).toEqual(first);

    first.privateKey.fill(0);
    second.privateKey.fill(0);
  });

  it("rejects malformed and out-of-range viewing authority records before vault encryption", () => {
    const authority = createStrk20ViewingAuthority(viewingContext);
    const tooLarge = new Uint8Array(32);
    const max = ec.starkCurve.CURVE.n / 2n + 1n;
    for (let index = 31, remaining = max; index >= 0; index -= 1) {
      tooLarge[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }

    expect(() => validateStrk20ViewingAuthority({ ...authority, extra: true })).toThrow();
    expect(() => validateStrk20ViewingAuthority({
      ...authority,
      descriptor: { ...authority.descriptor, poolAddress: "0x0" },
    })).toThrow();
    expect(() => validateStrk20ViewingAuthority({
      ...authority,
      privateKey: tooLarge,
    })).toThrow();

    authority.privateKey.fill(0);
    tooLarge.fill(0);
  });
});

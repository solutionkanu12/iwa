import { describe, expect, it } from "vitest";
import { ec } from "starknet";

import {
  createStarknetAuthority,
  signStarknetAuthorityProof,
  validateStarknetAuthority,
} from "./starknetAuthority";

const testAccountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1,
} as const;

function compactSignature(signature: { r: string; s: string }) {
  return ec.starkCurve.Signature.fromCompact(
    `${signature.r.slice(2).padStart(64, "0")}${signature.s.slice(2).padStart(64, "0")}`,
  );
}

function scalarHex(privateKey: Uint8Array): string {
  return `0x${Array.from(privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("local Starknet wallet authority", () => {
  it("uses browser CSPRNG output as a valid Stark scalar and computes a stable counterfactual account", () => {
    const first = createStarknetAuthority(testAccountClass);
    const second = createStarknetAuthority(testAccountClass);

    expect(first.privateKey).toHaveLength(32);
    expect(BigInt(`0x${Array.from(first.privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`)).toBeGreaterThan(0n);
    expect(BigInt(`0x${Array.from(first.privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`)).toBeLessThan(ec.starkCurve.CURVE.n);
    expect(first.descriptor.accountAddress).toMatch(/^0x[0-9a-f]+$/);
    expect(first.descriptor.publicKey).toMatch(/^0x[0-9a-f]+$/);
    expect(first.descriptor.deploymentState).toBe("addressComputed");
    expect(second.privateKey).not.toEqual(first.privateKey);
    expect(validateStarknetAuthority(first)).toEqual(first);
  });

  it("signs only with the matching local Starknet authority and rejects a modified proof hash", () => {
    const owner = createStarknetAuthority(testAccountClass);
    const stranger = createStarknetAuthority(testAccountClass);
    const proofHash = "0x3456";
    const signature = signStarknetAuthorityProof(owner, proofHash);

    // The Starknet account contract receives the x-coordinate in the descriptor.
    // Noble verification needs the complete curve point, reconstructed here only in
    // this local proof test from ephemeral test authority material.
    expect(ec.starkCurve.verify(compactSignature(signature), proofHash, ec.starkCurve.getPublicKey(scalarHex(owner.privateKey)))).toBe(true);
    expect(ec.starkCurve.verify(compactSignature(signature), proofHash, ec.starkCurve.getPublicKey(scalarHex(stranger.privateKey)))).toBe(false);
    expect(ec.starkCurve.verify(compactSignature(signature), "0x3457", ec.starkCurve.getPublicKey(scalarHex(owner.privateKey)))).toBe(false);
  });

  it("rejects malformed or extended authority descriptors before they enter encrypted storage", () => {
    const authority = createStarknetAuthority(testAccountClass);
    expect(() => validateStarknetAuthority({ ...authority, extra: "unexpected" })).toThrow();
    expect(() => validateStarknetAuthority({
      ...authority,
      descriptor: { ...authority.descriptor, extra: "unexpected" },
    })).toThrow();
    authority.privateKey.fill(0);
  });
});

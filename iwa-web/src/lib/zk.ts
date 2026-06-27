// lib/zk.ts — the single seam for zero-knowledge proof generation.
//
// Mocked for now: resolves after a short delay so the proof animation
// ("Building proof on this device", then "Checking on Stellar", then
// "Verified") can run today. The real body runs snarkjs witness calculation and
// Groth16 proving in WASM, locally, so secrets never leave the device. Only this
// file changes when the real prover lands; the signature stays the same.

import type { Claim, ProofResult } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fakeHex = (len: number): string => {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};

/**
 * Generate a proof for the chosen claim, on this device. Resolves after a short
 * delay so the verified moment can animate. Public signals carry only the
 * claim, never personal data.
 */
export async function generateProof(claim: Claim): Promise<ProofResult> {
  // Long enough to let "Building proof on this device" read as real work.
  await delay(1600);
  return {
    proof: "0x" + fakeHex(512),
    publicSignals: [String(claim.threshold), fakeHex(64)],
    claim,
  };
}

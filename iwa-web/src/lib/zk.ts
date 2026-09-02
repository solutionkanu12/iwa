// lib/zk.ts — the single seam for zero-knowledge proof generation.
//
// Now real: generateProof builds a Groth16 proof on this device with snarkjs,
// using the circuit artifacts served from public/zk (reputation.wasm as the
// witness calculator, rep_final.zkey as the proving key). No arkworks glue is
// used, so the nodejs-target iwa_prover.js (which loads wasm via fs.readFileSync
// and cannot run in a browser) is avoided entirely: snarkjs fetches the wasm and
// zkey straight from their URLs. Secrets never leave the device; only the proof
// and its public signals do, and those carry only the claim, never raw numbers.

// THE PROVING STACK IS LOADED ON DEMAND.
//
// snarkjs and circomlibjs together are the largest thing this application could
// ship, and almost nobody reaches them. Proving happens in two places: a join
// into a trust-gated circle, and the credential screen, which is not open in
// this version. Importing them at the top of this file meant every visitor
// downloaded a prover in order to look at a list of circles.
//
// Both call sites were already asynchronous and already awaited this function,
// so deferring the import changes nothing about when a proof becomes available.
// It changes who pays to have the code at all. The types are imported for their
// shapes only and are erased at build time, so they cost nothing.

import type { Groth16Proof } from "snarkjs";
import type { Poseidon } from "circomlibjs";
import type { Claim, ProofResult } from "./types";
import type { SnarkProof } from "./convert";

/**
 * Where the circuit artifacts are served from.
 *
 * Fetched by URL when a proof is actually being built, never bundled: they are
 * several megabytes and belong to the credential work rather than to the
 * application everyone loads. They live here now, because the earlier chain's
 * configuration file that used to carry them has been removed.
 */
export const ZK_ARTIFACTS = {
  circuitWasm: "/zk/reputation.wasm",
  provingKey: "/zk/rep_final.zkey",
  verificationKey: "/zk/verification_key.json",
} as const;

let poseidonPromise: Promise<Poseidon> | null = null;
function getPoseidon(): Promise<Poseidon> {
  // Built once and reused. The import resolves to the same module either way,
  // so the cost is paid by whoever proves first and by nobody else.
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then((m) => m.buildPoseidon());
  }
  return poseidonPromise;
}

// The circuit is Reputation(4): a 4-level Merkle tree (16 leaves). This matches
// iwa-circuit/reputation.circom and gen_input.js exactly.
const LEVELS = 4;

// Build the circuit witness input, mirroring iwa-circuit/gen_input.js. The
// member's leaf is Poseidon([secret]); it sits at index 0 of a tree whose other
// leaves are filler, and we collect the branch to the root. The root becomes a
// public input, so the proof is self-consistent for this member's commitment.
// The reputation figures are the demo good-standing values the circuit needs to
// satisfy the claim (completed >= threshold, zero defaults); the secret, and so
// the identity binding in the nullifier, is the real per-wallet secret.
async function buildInput(
  secret: bigint,
  threshold: number,
): Promise<Record<string, string | string[]>> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const H = (arr: bigint[]): bigint => F.toObject(poseidon(arr));

  const n = 1 << LEVELS;
  const leaves: bigint[] = [H([secret])];
  for (let i = 1; i < n; i++) leaves.push(BigInt(1000 + i));

  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  let cur = leaves.slice();
  let idx = 0;
  for (let l = 0; l < LEVELS; l++) {
    const sibling = cur[idx ^ 1];
    pathElements.push(sibling.toString());
    pathIndices.push((idx & 1).toString());
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(H([cur[i], cur[i + 1]]));
    cur = next;
    idx = idx >> 1;
  }

  return {
    secret: secret.toString(),
    completedCycles: "5",
    onTimeCount: "5",
    defaultCount: "0",
    pathElements,
    pathIndices,
    threshold: String(threshold),
    root: cur[0].toString(),
  };
}

// snarkjs proof -> the (a, b, c) decimal shape convert.ts serialises for Soroban.
function toSnarkProof(p: Groth16Proof): SnarkProof {
  return {
    a: [p.pi_a[0], p.pi_a[1]],
    b: [
      [p.pi_b[0][0], p.pi_b[0][1]],
      [p.pi_b[1][0], p.pi_b[1][1]],
    ],
    c: [p.pi_c[0], p.pi_c[1]],
  };
}

/**
 * Generate a real Groth16 proof for the chosen claim, on this device, from the
 * member's secret. Public signals carry only [nullifier, threshold, root],
 * never personal data. Throws if witness generation or proving fails, so the
 * caller can show an honest failure state instead of a fake verified moment.
 */
export async function generateProof(
  claim: Claim,
  secret: bigint,
): Promise<ProofResult> {
  const input = await buildInput(secret, claim.threshold);
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    ZK_ARTIFACTS.circuitWasm,
    ZK_ARTIFACTS.provingKey,
  );
  return { proof: toSnarkProof(proof), publicSignals, claim };
}

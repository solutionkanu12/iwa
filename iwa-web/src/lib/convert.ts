// Decimal -> Soroban-bytes conversion for Groth16 proofs and public signals.
//
// Ported verbatim (same ordering and big-endian field encoding) from
// iwa-verifier/contracts/verifier/testdata/convert.js, which produced the bytes
// the deployed verifier accepts. The Iwa prover emits snarkjs-style decimal
// strings; the on-chain `verify_proof` needs:
//   * proof  -> 256 bytes: A.x|A.y (64) then B.x.c1|B.x.c0|B.y.c1|B.y.c0 (128,
//               G2 in Soroban c1||c0 order) then C.x|C.y (64), each 32-byte BE.
//   * signal -> 32-byte big-endian field element.
//
// Not wired into anything yet; this only makes the conversion available.

// Groth16 proof as the Iwa prover emits it (decimal strings).
export interface SnarkProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

/** Decimal field element -> 32-byte big-endian, as a 64-character hex string. */
export function fieldToBe32Hex(dec: string): string {
  const h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error(`field element exceeds 32 bytes: ${dec}`);
  return h.padStart(64, "0");
}

/** snarkjs G1 point [x, y] -> 64 bytes (x || y) as hex. */
function g1Hex(pt: [string, string]): string {
  return fieldToBe32Hex(pt[0]) + fieldToBe32Hex(pt[1]);
}

/**
 * Serialize a proof to the 256-byte Soroban layout as a hex string. G2 (point
 * B) is written c1 before c0 to match Soroban's ordering, exactly as the
 * original converter does (b[0][1], b[0][0], b[1][1], b[1][0]).
 */
export function proofToSorobanHex(p: SnarkProof): string {
  const a = g1Hex(p.a);
  const b =
    fieldToBe32Hex(p.b[0][1]) +
    fieldToBe32Hex(p.b[0][0]) +
    fieldToBe32Hex(p.b[1][1]) +
    fieldToBe32Hex(p.b[1][0]);
  const c = g1Hex(p.c);
  const hex = a + b + c;
  if (hex.length !== 512) {
    throw new Error(`proof is not 256 bytes: ${hex.length / 2}`);
  }
  return hex;
}

/** Public signals (decimal strings) -> array of 32-byte big-endian hex. */
export function signalsToHex(signals: string[]): string[] {
  return signals.map(fieldToBe32Hex);
}

/** Hex string -> raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Proof -> raw 256 bytes (for the verifier's `proof: Bytes` argument). */
export function proofToSorobanBytes(p: SnarkProof): Uint8Array {
  return hexToBytes(proofToSorobanHex(p));
}

/** Public signals -> array of raw 32-byte arrays (for `Vec<BytesN<32>>`). */
export function signalsToBytes(signals: string[]): Uint8Array[] {
  return signalsToHex(signals).map(hexToBytes);
}

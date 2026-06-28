/* tslint:disable */
/* eslint-disable */

/**
 * Generate a proof in the browser. `zkey` is the proving key bytes,
 * `witness_json` the witness array (from circom's witness calculator).
 */
export function prove(zkey: Uint8Array, witness_json: string): string;

/**
 * Verify a proof against a snarkjs-format verification key.
 */
export function verify(vk_json: string, result_json: string): boolean;

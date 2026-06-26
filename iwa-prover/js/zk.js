// Iwa proving seam (the lib/zk.ts equivalent), runnable in Node or the browser.
//
//   generateProof(claim) -> { proof, publicSignals, claim }
//
// The witness is computed on-device from the claim's circuit inputs (circom's
// WASM witness calculator), then a real Groth16 BN254 proof is generated
// on-device by the arkworks WASM module. The member's secret never leaves here.
const fs = require("fs");
const path = require("path");
const os = require("os");
const snarkjs = require("snarkjs");
const wasmProver = require("../pkg/iwa_prover.js");

const CIRCUIT = path.join(__dirname, "..", "..", "iwa-circuit", "build");
const CIRCUIT_WASM = path.join(CIRCUIT, "reputation_js", "reputation.wasm");
const ZKEY = path.join(CIRCUIT, "rep_final.zkey");

async function generateProof(claim) {
  // 1) Witness, on-device, from the claim's circuit inputs.
  const tmp = path.join(os.tmpdir(), `iwa_wtns_${Date.now()}.wtns`);
  await snarkjs.wtns.calculate(claim.input, CIRCUIT_WASM, tmp);
  const witness = await snarkjs.wtns.exportJson(tmp);
  fs.unlinkSync(tmp);
  const witnessJson = JSON.stringify(witness.map((x) => x.toString()));

  // 2) Proof, on-device (arkworks compiled to WASM).
  const zkey = fs.readFileSync(ZKEY);
  const resultJson = wasmProver.prove(new Uint8Array(zkey), witnessJson);
  const { proof, publicSignals } = JSON.parse(resultJson);

  return { proof, publicSignals, claim };
}

module.exports = { generateProof, wasmProver };

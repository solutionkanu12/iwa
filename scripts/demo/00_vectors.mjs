// Regenerates the fixed vectors pinned in
// contracts/starknet/tests/test_hash_parity.cairo.
//
// The fixture and the computation live in lib/parity.mjs, which the read-only
// preflight also imports, so the printed constants and the constants the
// preflight enforces can never come from different code paths.
//
// Run:  node 00_vectors.mjs
// Then copy the printed values into the Cairo test and re-run the suite.

import { verifyIwa, feltHex } from "./lib/iwa.mjs";
import { computeParityVectors, FIXTURE } from "./lib/parity.mjs";

const v = computeParityVectors();

console.log("SECRET_A        " + feltHex(FIXTURE.SECRET_A));
console.log("KEY_A           " + feltHex(v.KEY_A));
console.log("MEMBER_REF      " + feltHex(v.MEMBER_REF));
console.log("CONTRIB         " + feltHex(v.CONTRIB));
console.log("CURE            " + feltHex(v.CURE));
console.log("PAYOUT_AUTH     " + feltHex(v.PAYOUT_AUTH));
console.log("PAYOUT_SETTLE   " + feltHex(v.PAYOUT_SETTLE));
console.log("RECOVERY_SETTLE " + feltHex(v.RECOVERY_SETTLE));
console.log("SIG_R           " + feltHex(v.SIG_R));
console.log("SIG_S           " + feltHex(v.SIG_S));

// Off-chain mirror of the contract predicate: the range and canonical low-s
// guards of iwa_types::verify_settlement_hash, then check_ecdsa_signature.
// Verification takes the on-chain auth public key, not the private key.
const accepted = verifyIwa(v.KEY_A, v.CONTRIB, v.SIG_R, v.SIG_S);
console.log("\non-chain acceptance predicate: " + accepted);
if (!accepted) {
  console.error("refusing to emit vectors the deployed verifier would reject");
  process.exit(1);
}

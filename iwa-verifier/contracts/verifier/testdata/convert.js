// Convert our Stage 8 snarkjs proof + public signals into the Soroban byte
// layout the verifier contract expects, and copy the Stage 7 verification key
// for build.rs to embed.
//
//   proof  (256 bytes) = A.x|A.y | B.x.c1|B.x.c0|B.y.c1|B.y.c0 | C.x|C.y
//   signal (32 bytes)  = big-endian field element
//
// snarkjs pi_b is [[x.c0,x.c1],[y.c0,y.c1],...]; Soroban wants c1 before c0.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../../../iwa-circuit/build");
const OUT = __dirname;

function be32(dec) {
  let h = BigInt(dec).toString(16);
  if (h.length > 64) throw new Error("field element > 32 bytes: " + dec);
  return h.padStart(64, "0");
}

function g1(pt) {
  return be32(pt[0]) + be32(pt[1]);
}

function proofHex(p) {
  const a = g1(p.pi_a);
  // c1 || c0 for each Fq2 coordinate
  const b =
    be32(p.pi_b[0][1]) + be32(p.pi_b[0][0]) +
    be32(p.pi_b[1][1]) + be32(p.pi_b[1][0]);
  const c = g1(p.pi_c);
  const hex = a + b + c;
  if (hex.length !== 512) throw new Error("proof not 256 bytes: " + hex.length / 2);
  return hex;
}

function signals(arr) {
  return arr.map((s) => be32(s));
}

const proof = JSON.parse(fs.readFileSync(path.join(SRC, "proof_pass.json")));
const pubPass = JSON.parse(fs.readFileSync(path.join(SRC, "public_pass.json")));
const pubTampered = JSON.parse(fs.readFileSync(path.join(SRC, "public_tampered.json")));
const vk = fs.readFileSync(path.join(SRC, "verification_key.json"), "utf8");

const realHex = proofHex(proof);

// A tampered proof that stays a valid curve point so the host accepts the bytes
// but the Groth16 pairing rejects it: negate A's y-coordinate. For (x, y) on the
// BN254 curve, (x, p - y) is also on the curve, so from_bytes succeeds and
// pairing_check returns false (rather than the host hard-erroring on an
// off-curve point).
const FQ_P = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);
const tamperedProof = JSON.parse(JSON.stringify(proof));
tamperedProof.pi_a[1] = (FQ_P - BigInt(proof.pi_a[1])).toString();
const tamperedProofHex = proofHex(tamperedProof);

const artifacts = {
  proof_pass_hex: realHex,
  proof_tampered_hex: tamperedProofHex,
  public_pass: signals(pubPass),
  public_tampered: signals(pubTampered),
};

fs.writeFileSync(path.join(OUT, "proof_pass.hex"), realHex + "\n");
fs.writeFileSync(path.join(OUT, "proof_tampered.hex"), tamperedProofHex + "\n");
fs.writeFileSync(path.join(OUT, "public_pass.json"), JSON.stringify(signals(pubPass)) + "\n");
fs.writeFileSync(path.join(OUT, "public_tampered.json"), JSON.stringify(signals(pubTampered)) + "\n");
fs.writeFileSync(path.join(OUT, "artifacts.json"), JSON.stringify(artifacts, null, 1) + "\n");
fs.writeFileSync(path.join(OUT, "verification_key.json"), vk);

console.log("wrote testdata to", OUT);
console.log("proof_pass_hex   :", realHex.slice(0, 32), "...", "(", realHex.length / 2, "bytes )");
console.log("proof_tampered   :", tamperedProofHex.slice(0, 32), "...");
console.log("public_pass      :", JSON.stringify(signals(pubPass)));
console.log("public_tampered  :", JSON.stringify(signals(pubTampered)));

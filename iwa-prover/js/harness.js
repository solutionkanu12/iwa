// Browser-like Node harness: generate a reputation proof on-device for a good
// member, verify it with the SAME Stage 7 verification key, and confirm a
// tampered public claim verifies false.
const fs = require("fs");
const path = require("path");
const { generateProof, wasmProver } = require("./zk");

const CIRCUIT = path.join(__dirname, "..", "..", "iwa-circuit");
const VK = path.join(CIRCUIT, "build", "verification_key.json");
const INPUT_PASS = path.join(CIRCUIT, "input_pass.json");

(async () => {
  const vkJson = fs.readFileSync(VK, "utf8");
  const input = JSON.parse(fs.readFileSync(INPUT_PASS, "utf8"));

  const claim = { label: "completed >= 2, no defaults", input };
  const result = await generateProof(claim);
  console.log("publicSignals [nullifier, threshold, root]:");
  console.log("  ", result.publicSignals);

  // Verify with the SAME Stage 7 verification key.
  const okJson = JSON.stringify({ proof: result.proof, publicSignals: result.publicSignals });
  const passVerify = wasmProver.verify(vkJson, okJson);
  console.log("PASS verify (good member):", passVerify);

  // Tamper the public claim (bump threshold 2 -> 5) -> must verify false.
  const tampered = JSON.parse(okJson);
  tampered.publicSignals[1] = "5";
  const tamperVerify = wasmProver.verify(vkJson, JSON.stringify(tampered));
  console.log("TAMPER verify (bumped threshold):", tamperVerify);

  if (passVerify === true && tamperVerify === false) {
    console.log("RESULT: OK  (on-device proof verifies true; tampered claim false)");
    process.exit(0);
  }
  console.log("RESULT: FAIL");
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

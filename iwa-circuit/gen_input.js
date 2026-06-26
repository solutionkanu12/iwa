// Build circuit inputs with a valid Poseidon Merkle branch.
// Produces a passing case (good member) and two failing cases
// (defaults > 0, and completed < threshold). circomlibjs Poseidon matches
// circomlib's poseidon.circom, so the off-circuit root agrees with the circuit.

const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");

(async () => {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (arr) => F.toObject(poseidon(arr)); // -> BigInt

  const LEVELS = 4;
  const N = 1 << LEVELS; // 16 leaves
  const secret = 12345n;

  // The member's leaf is a commitment to their secret.
  const memberLeaf = H([secret]);

  // Member sits at index 0; other leaves are filler.
  const leaves = [memberLeaf];
  for (let i = 1; i < N; i++) leaves.push(BigInt(1000 + i));

  // Walk up the tree collecting the branch for index 0.
  const pathElements = [];
  const pathIndices = [];
  let cur = leaves.slice();
  let idx = 0;
  for (let l = 0; l < LEVELS; l++) {
    const sibling = cur[idx ^ 1];
    pathElements.push(sibling.toString());
    pathIndices.push((idx & 1).toString());
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(H([cur[i], cur[i + 1]]));
    cur = next;
    idx = idx >> 1;
  }
  const root = cur[0];

  const base = {
    secret: secret.toString(),
    pathElements,
    pathIndices,
    threshold: "2",
    root: root.toString(),
  };

  // Good member: 5 completed cycles, all on time, zero defaults.
  const pass = { ...base, completedCycles: "5", onTimeCount: "5", defaultCount: "0" };
  // Bad member A: has a default.
  const failDefault = { ...base, completedCycles: "5", onTimeCount: "4", defaultCount: "1" };
  // Bad member B: completed fewer than the threshold.
  const failLow = { ...base, completedCycles: "1", onTimeCount: "1", defaultCount: "0" };

  fs.writeFileSync("input_pass.json", JSON.stringify(pass, null, 2));
  fs.writeFileSync("input_fail_default.json", JSON.stringify(failDefault, null, 2));
  fs.writeFileSync("input_fail_low.json", JSON.stringify(failLow, null, 2));

  console.log("memberLeaf =", memberLeaf.toString());
  console.log("root       =", root.toString());
  console.log("wrote input_pass.json, input_fail_default.json, input_fail_low.json");
})();

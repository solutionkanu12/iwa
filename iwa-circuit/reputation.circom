pragma circom 2.2.2;

// Iwa reputation circuit (BN254). Proves a member is in good standing in a
// circle without revealing their identity, their exact numbers, the circle, or
// the other members.
//
// Built for Iwa. It studies the reference's Circom patterns (Merkle membership,
// Poseidon hashing, nullifier binding) but is not the reference's UTXO circuit.
// Hashing uses circomlib's standard Poseidon.

include "poseidon.circom";
include "comparators.circom";
include "mux1.circom";

// Poseidon hash of an ordered pair, used for Merkle parents.
template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;
    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    hash <== h.out;
}

// Recompute a Merkle root from a leaf and its branch. pathIndices[i] is 0 when
// the current node is the left child at level i, 1 when it is the right child.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // pathIndices must be a bit.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Order the pair: (cur, sibling) if left child, (sibling, cur) if right.
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== cur[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== cur[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = HashLeftRight();
        hashers[i].left <== mux[i].out[0];
        hashers[i].right <== mux[i].out[1];

        cur[i + 1] <== hashers[i].hash;
    }

    root <== cur[levels];
}

template Reputation(levels) {
    // --- Private inputs ---
    signal input secret;          // the member's secret (identity stays hidden)
    signal input completedCycles;  // reputation numbers (kept private)
    signal input onTimeCount;
    signal input defaultCount;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // --- Public inputs ---
    signal input threshold;       // N, set by the verifier: prove completed >= N
    signal input root;            // the circle's membership Merkle root

    // --- Public output ---
    signal output nullifier;      // binds the proof to this member and claim

    // The membership leaf is a commitment to the secret.
    component leaf = Poseidon(1);
    leaf.inputs[0] <== secret;

    // 1) Membership: the leaf sits under the public root.
    component mp = MerkleProof(levels);
    mp.leaf <== leaf.out;
    for (var i = 0; i < levels; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    mp.root === root;

    // 2) Good standing, part one: completedCycles >= threshold.
    component ge = GreaterEqThan(32);
    ge.in[0] <== completedCycles;
    ge.in[1] <== threshold;
    ge.out === 1;

    // 3) Good standing, part two: zero defaults.
    component noDefaults = IsZero();
    noDefaults.in <== defaultCount;
    noDefaults.out === 1;

    // Sanity, and a use for onTimeCount: on-time payments cannot exceed the
    // number of completed cycles.
    component sane = LessEqThan(32);
    sane.in[0] <== onTimeCount;
    sane.in[1] <== completedCycles;
    sane.out === 1;

    // Nullifier binds the proof to the member commitment and the claimed
    // threshold, so one proof cannot be reused for a different claim.
    component nf = Poseidon(2);
    nf.inputs[0] <== leaf.out;
    nf.inputs[1] <== threshold;
    nullifier <== nf.out;
}

// threshold and root are public; nullifier is a public output. Everything else
// (secret, the three numbers, the Merkle branch) stays private.
component main {public [threshold, root]} = Reputation(4);

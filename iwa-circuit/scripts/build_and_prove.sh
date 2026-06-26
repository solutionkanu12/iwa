#!/usr/bin/env bash
# Compile the reputation circuit, run a local Groth16 trusted setup, then prove
# and verify a passing case and confirm the failing cases are rejected.
# Run scripts/setup.sh first. Generated artifacts land in build/ (gitignored).
set -e
export PATH="$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use --lts >/dev/null

cd "$(dirname "$0")/.."
mkdir -p build

echo "############ compile circuit ############"
circom reputation.circom --r1cs --wasm --sym -l circomlib/circuits -o build
snarkjs r1cs info build/reputation.r1cs

echo "############ powers of tau (bn128, 2^14) ############"
snarkjs powersoftau new bn128 14 build/pot14_0000.ptau
snarkjs powersoftau contribute build/pot14_0000.ptau build/pot14_0001.ptau --name="iwa-1" -e="iwa entropy one"
snarkjs powersoftau prepare phase2 build/pot14_0001.ptau build/pot14_final.ptau

echo "############ groth16 setup + verification key ############"
snarkjs groth16 setup build/reputation.r1cs build/pot14_final.ptau build/rep_0000.zkey
snarkjs zkey contribute build/rep_0000.zkey build/rep_final.zkey --name="iwa-2" -e="iwa entropy two"
snarkjs zkey export verificationkey build/rep_final.zkey build/verification_key.json

echo "############ generate inputs (valid Merkle branch) ############"
node gen_input.js

WASM=build/reputation_js/reputation.wasm

echo "############ PASS case: good member ############"
snarkjs wtns calculate "$WASM" input_pass.json build/witness_pass.wtns
snarkjs groth16 prove build/rep_final.zkey build/witness_pass.wtns build/proof_pass.json build/public_pass.json
echo "--- public signals (pass): [nullifier, threshold, root] ---"; cat build/public_pass.json
set +e
snarkjs groth16 verify build/verification_key.json build/public_pass.json build/proof_pass.json
echo "PASS_VERIFY_RC=$? (0 = verifies TRUE)"

echo "############ FAIL case A: member has a default ############"
snarkjs wtns calculate "$WASM" input_fail_default.json build/witness_fail_default.wtns >build/fail_default.log 2>&1
echo "FAIL_DEFAULT_witness_rc=$? (non-zero = rejected, cannot prove)"

echo "############ FAIL case B: completed < threshold ############"
snarkjs wtns calculate "$WASM" input_fail_low.json build/witness_fail_low.wtns >build/fail_low.log 2>&1
echo "FAIL_LOW_witness_rc=$? (non-zero = rejected, cannot prove)"
set -e

echo "done"

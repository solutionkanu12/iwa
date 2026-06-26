#!/usr/bin/env bash
# Install the ZK toolchain and fetch circomlib.
# - node (LTS) via nvm, no sudo
# - snarkjs (global)
# - circom is expected on PATH already (2.2.x)
# - circomlib (cloned) and circomlibjs (local npm dep, for input generation)
set -e
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install --lts
nvm use --lts
command -v snarkjs >/dev/null 2>&1 || npm install -g snarkjs

cd "$(dirname "$0")/.."
[ -d circomlib ] || git clone --depth 1 https://github.com/iden3/circomlib
npm install

echo "setup done: node $(node --version), circom $(circom --version)"

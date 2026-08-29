#!/usr/bin/env bash
#
# Offline assertions for the IWA deployment tool (Task 8C).
#
# Runs entirely from fixtures: no network, no account, no transactions. Proves
# the two properties that keep a deployment safe — the artifact allowlist
# ignores everything it is not explicitly told to deploy (StarkWare's `Privacy`
# above all), and a malformed configuration is refused before it can cost
# anything.
#
# Usage: ./test-iwa-deploy.sh

set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TOOL="${SCRIPT_DIR}/iwa-deploy.sh"
readonly WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
RED=""; GRN=""; RST=""
if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; RST=$'\033[0m'; fi

pass() { PASS=$((PASS+1)); printf '%s PASS %s %s\n' "$GRN" "$RST" "$1"; }
fail() { FAIL=$((FAIL+1)); printf '%s FAIL %s %s\n' "$RED" "$RST" "$1"; }

# Asserts the command fails AND its output mentions the expected reason, so a
# test cannot pass because of an unrelated error.
assert_rejects() {
  local desc="$1" expect="$2"; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "$desc (command unexpectedly succeeded)"
  elif printf '%s' "$out" | grep -qi -- "$expect"; then
    pass "$desc"
  else
    fail "$desc (rejected, but not for '$expect'): $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
}

assert_accepts() {
  local desc="$1"; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then pass "$desc"
  else fail "$desc: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"; fi
}

assert_output_contains() {
  local desc="$1" expect="$2"; shift 2
  local out
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -qi -- "$expect"; then pass "$desc"
  else fail "$desc (missing '$expect')"; fi
}

assert_output_lacks() {
  local desc="$1" forbidden="$2"; shift 2
  local out
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -qi -- "$forbidden"; then
    fail "$desc (unexpectedly contains '$forbidden')"
  else pass "$desc"; fi
}

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

POOL=0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
USDC=0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb
STRK=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
SINK=0x0777000000000000000000000000000000000000000000000000000000000777
AUTH=0x0666000000000000000000000000000000000000000000000000000000000666

# Artifacts fixture deliberately includes StarkWare's Privacy plus an unknown
# contract, mirroring what `scarb build` actually produces today.
cat > "$WORK/artifacts.json" <<JSON
{"version":1,"contracts":[
 {"id":"a","package_name":"iwa","contract_name":"IwaCircle","module_path":"iwa::iwa_circle::IwaCircle","artifacts":{"sierra":"iwa_IwaCircle.contract_class.json","casm":null}},
 {"id":"b","package_name":"iwa","contract_name":"IwaStrk20Helper","module_path":"iwa::iwa_strk20_helper::IwaStrk20Helper","artifacts":{"sierra":"iwa_IwaStrk20Helper.contract_class.json","casm":null}},
 {"id":"c","package_name":"privacy","contract_name":"Privacy","module_path":"privacy::privacy::Privacy","artifacts":{"sierra":"iwa_Privacy.contract_class.json","casm":null}},
 {"id":"d","package_name":"iwa","contract_name":"SomeFutureContract","module_path":"iwa::x::SomeFutureContract","artifacts":{"sierra":"iwa_SomeFutureContract.contract_class.json","casm":null}}
]}
JSON

# Minimal IwaCircle ABI fixture with the one-time initializer and no setter.
cat > "$WORK/iwa_IwaCircle.contract_class.json" <<'JSON'
{"abi":[{"type":"interface","name":"iwa::iwa_circle::IIwaCircle","items":[
 {"type":"function","name":"initialize_settlement_helper","inputs":[],"outputs":[],"state_mutability":"external"},
 {"type":"function","name":"get_settlement_config","inputs":[],"outputs":[],"state_mutability":"view"}
]}]}
JSON

# Same, but with a helper-replacement setter that must be caught.
cat > "$WORK/artifacts_badabi.json" <<JSON
{"version":1,"contracts":[
 {"id":"a","package_name":"iwa","contract_name":"IwaCircle","module_path":"m","artifacts":{"sierra":"bad_IwaCircle.contract_class.json","casm":null}},
 {"id":"b","package_name":"iwa","contract_name":"IwaStrk20Helper","module_path":"m","artifacts":{"sierra":"iwa_IwaStrk20Helper.contract_class.json","casm":null}}
]}
JSON
cat > "$WORK/bad_IwaCircle.contract_class.json" <<'JSON'
{"abi":[{"type":"interface","name":"i","items":[
 {"type":"function","name":"initialize_settlement_helper","inputs":[],"outputs":[],"state_mutability":"external"},
 {"type":"function","name":"set_settlement_helper","inputs":[],"outputs":[],"state_mutability":"external"}
]}]}
JSON

# Artifacts missing an allowlisted contract entirely.
cat > "$WORK/artifacts_missing.json" <<JSON
{"version":1,"contracts":[
 {"id":"c","package_name":"privacy","contract_name":"Privacy","module_path":"p","artifacts":{"sierra":"iwa_Privacy.contract_class.json","casm":null}}
]}
JSON

mkcfg() {
  local out="$1" sink="${2:-$SINK}" usdc="${3:-$USDC}" strk="${4:-$STRK}" \
        auth="${5:-$AUTH}" pool="${6:-$POOL}" net="${7:-mainnet}"
  cat > "$out" <<JSON
{"network":"$net","rpc_url":"https://example.invalid/rpc",
 "privacy_pool":"$pool","usdc_token":"$usdc","strk_token":"$strk",
 "surplus_sink":"$sink","setup_authority":"$auth","deployer_account":"acct"}
JSON
}

mkcfg "$WORK/good.json"

# --------------------------------------------------------------------------
# A. Artifact allowlist
# --------------------------------------------------------------------------

printf '\n--- A. Artifact allowlist ---\n'

export IWA_ARTIFACTS_FILE="$WORK/artifacts.json"

assert_accepts "allowlisted artifacts are selected" \
  "$TOOL" check-artifacts

assert_output_contains "IwaCircle is selected by name" "selected IwaCircle" \
  "$TOOL" check-artifacts
assert_output_contains "IwaStrk20Helper is selected by name" "selected IwaStrk20Helper" \
  "$TOOL" check-artifacts

assert_output_contains "StarkWare Privacy is explicitly ignored" \
  "ignoring forbidden artifact 'Privacy'" "$TOOL" check-artifacts
assert_output_lacks "Privacy is never reported as selected" "selected Privacy" \
  "$TOOL" check-artifacts

assert_output_contains "an unknown future artifact is ignored, not deployed" \
  "ignoring unexpected artifact 'SomeFutureContract'" "$TOOL" check-artifacts
assert_output_lacks "unknown artifact is never selected" "selected SomeFutureContract" \
  "$TOOL" check-artifacts

export IWA_ARTIFACTS_FILE="$WORK/artifacts_missing.json"
assert_rejects "missing allowlisted artifact is refused" "expected exactly 1 artifact named" \
  "$TOOL" check-artifacts

export IWA_ARTIFACTS_FILE="$WORK/nonexistent.json"
assert_rejects "absent artifacts file is refused" "build artifacts not found" \
  "$TOOL" check-artifacts

# --------------------------------------------------------------------------
# A2. Forbidden entrypoints
# --------------------------------------------------------------------------

printf '\n--- A2. Forbidden entrypoint check ---\n'

export IWA_ARTIFACTS_FILE="$WORK/artifacts_badabi.json"
assert_rejects "a settlement-helper setter is refused" "forbidden entrypoint" \
  "$TOOL" check-artifacts

export IWA_ARTIFACTS_FILE="$WORK/artifacts.json"
assert_output_contains "clean ABI passes the setter check" \
  "no 'set_settlement_helper' entrypoint" "$TOOL" check-artifacts

# --------------------------------------------------------------------------
# B/D. Configuration validation
# --------------------------------------------------------------------------

printf '\n--- B/D. Configuration validation ---\n'

assert_accepts "a well-formed config plans cleanly" \
  "$TOOL" plan "$WORK/good.json"

mkcfg "$WORK/placeholder.json" "REPLACE_ME_WITH_IWA_TREASURY_MULTISIG"
assert_rejects "an unset surplus_sink placeholder is refused" "still a placeholder" \
  "$TOOL" plan "$WORK/placeholder.json"

assert_rejects "the shipped example config is refused as-is" "still a placeholder" \
  "$TOOL" plan "$SCRIPT_DIR/deploy.config.example.json"

mkcfg "$WORK/zerosink.json" "0x0"
assert_rejects "a zero surplus_sink is refused" "must not be the zero address" \
  "$TOOL" plan "$WORK/zerosink.json"

mkcfg "$WORK/sametoken.json" "$SINK" "$USDC" "$USDC"
assert_rejects "usdc == strk is refused" "must differ" \
  "$TOOL" plan "$WORK/sametoken.json"

mkcfg "$WORK/sinkpool.json" "$POOL"
assert_rejects "sink == privacy pool is refused" "must not be the privacy pool" \
  "$TOOL" plan "$WORK/sinkpool.json"

mkcfg "$WORK/sinkusdc.json" "$USDC"
assert_rejects "sink == a configured token is refused" "must not be a configured token" \
  "$TOOL" plan "$WORK/sinkusdc.json"

mkcfg "$WORK/sinkauth.json" "$AUTH"
assert_rejects "sink == setup authority is refused" "must not be the setup authority" \
  "$TOOL" plan "$WORK/sinkauth.json"

# Address equality must be felt-wise, not string-wise: 0x0777... and 0x777...
# are the same address and the collision checks must still catch them.
mkcfg "$WORK/sinkpool_unpadded.json" "0x40337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"
assert_rejects "unpadded sink == pool is still caught" "must not be the privacy pool" \
  "$TOOL" plan "$WORK/sinkpool_unpadded.json"

mkcfg "$WORK/badhex.json" "not-an-address"
assert_rejects "a malformed address is refused" "not a hex address" \
  "$TOOL" plan "$WORK/badhex.json"

printf '{"network":"mainnet"}' > "$WORK/incomplete.json"
assert_rejects "a config missing addresses is refused" "is missing from config" \
  "$TOOL" plan "$WORK/incomplete.json"

printf 'not json' > "$WORK/notjson.json"
assert_rejects "invalid JSON is refused" "not valid JSON" \
  "$TOOL" plan "$WORK/notjson.json"

assert_rejects "a missing config file is refused" "config file not found" \
  "$TOOL" plan "$WORK/absent.json"

# --------------------------------------------------------------------------
# B2. surplus_sink must not be the deployed IwaCircle
# --------------------------------------------------------------------------
#
# `validate` cannot catch this: the circle does not exist yet when the config is
# first checked. The guard runs between deploying IwaCircle and deploying the
# helper, and nothing on chain enforces it, so it is tested here directly.

printf '\n--- B2. surplus_sink vs deployed IwaCircle ---\n'

CIRCLE=0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# The sink equals the circle that was just deployed.
mkcfg "$WORK/sink_is_circle.json" "$CIRCLE"
assert_rejects "sink equal to the deployed IwaCircle is refused" \
  "surplus_sink is the deployed IwaCircle" \
  "$TOOL" check-sink "$WORK/sink_is_circle.json" "$CIRCLE"

# Felt equality, not string equality: a padded circle address must still match.
mkcfg "$WORK/sink_is_circle_unpadded.json" \
  "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
assert_rejects "unpadded sink equal to the circle is still refused" \
  "surplus_sink is the deployed IwaCircle" \
  "$TOOL" check-sink "$WORK/sink_is_circle_unpadded.json" "$CIRCLE"

# The refusal must name the abort point, so an operator knows nothing shipped.
assert_output_contains "refusal states the helper was not deployed" \
  "BEFORE the helper is deployed" \
  "$TOOL" check-sink "$WORK/sink_is_circle.json" "$CIRCLE"
assert_output_contains "refusal states initialization did not run" \
  "BEFORE initialization" \
  "$TOOL" check-sink "$WORK/sink_is_circle.json" "$CIRCLE"

# A distinct sink passes.
assert_accepts "a sink distinct from the circle passes" \
  "$TOOL" check-sink "$WORK/good.json" "$CIRCLE"
assert_output_contains "passing case is reported explicitly" \
  "distinct from the deployed IwaCircle" \
  "$TOOL" check-sink "$WORK/good.json" "$CIRCLE"

# A malformed or missing circle address is refused rather than silently skipped.
assert_rejects "a zero circle address is refused" "must not be the zero address" \
  "$TOOL" check-sink "$WORK/good.json" "0x0"
assert_rejects "a malformed circle address is refused" "not a hex address" \
  "$TOOL" check-sink "$WORK/good.json" "not-an-address"
assert_rejects "a missing circle address is refused" "is missing from config" \
  "$TOOL" check-sink "$WORK/good.json"

# The guard runs after the ordinary config checks, so a placeholder sink is
# still caught first.
assert_rejects "a placeholder sink is refused before the circle check" \
  "still a placeholder" \
  "$TOOL" check-sink "$WORK/placeholder.json" "$CIRCLE"

# --------------------------------------------------------------------------
# C. Deployment is gated
# --------------------------------------------------------------------------

printf '\n--- C. Deployment gating and ordering ---\n'

assert_rejects "deploy without --confirm-send sends nothing" "Nothing has been sent" \
  "$TOOL" deploy "$WORK/good.json"

assert_output_contains "plan states the approved order" \
  "initialize_settlement_helper(helper) — exactly once" "$TOOL" plan "$WORK/good.json"
assert_output_contains "plan states the helper constructor includes surplus_sink" \
  "surplus_sink" "$TOOL" plan "$WORK/good.json"

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

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
        auth="${5:-$AUTH}" pool="${6:-$POOL}" net="${7:-mainnet}" salt="${8:-}"
  cat > "$out" <<JSON
{"network":"$net","rpc_url":"https://example.invalid/rpc",
 "privacy_pool":"$pool","usdc_token":"$usdc","strk_token":"$strk",
 "surplus_sink":"$sink","setup_authority":"$auth","deployer_account":"acct"
JSON
  [ -n "$salt" ] && printf ',"salt":"%s"' "$salt" >> "$out"
  printf '}\n' >> "$out"
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
# D. Pre-initialization helper gate (fail-closed, read-only)
# --------------------------------------------------------------------------
#
# The gate the abandoned mainnet deployment was missing: before the one-time
# initialize_settlement_helper is sent, the tool must independently confirm
# that the helper address really hosts the helper class, that the helper's
# immutable config is exact, and that the circle is still uninitialized.
# These tests drive assert_helper_ready through the `check-helper` subcommand
# against a fake `curl` serving the exact JSON-RPC surface the gate reads.
# Selectors below are starknet_keccak of `get_config` and
# `get_settlement_config` on the pinned classes.

printf '\n--- D. Pre-initialization helper gate ---\n'

mkdir -p "$WORK/bin"

cat > "$WORK/bin/curl" <<'SH'
#!/usr/bin/env bash
payload=""; prev=""
for a in "$@"; do
  [ "$prev" = "-d" ] && payload="$a"
  prev="$a"
done
[ -n "$payload" ] || { echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"no payload"}}'; exit 0; }
norm() { printf '%s' "${1#0x}" | sed 's/^0*//' | tr '[:upper:]' '[:lower:]'; }
HELPER_N=$(norm "0x48c90774b5bc798438c6db2b85163151b2e5057d7a07e6cd1c58b4bbaf0b71e")
CORE_N=$(norm "0x02cc664789697a4ea74ea062bcb826e57317eab1d17a6f6803b01406292b42cb")
method=$(printf '%s' "$payload" | jq -r '.method // empty')
case "$method" in
  starknet_chainId)
    echo '{"jsonrpc":"2.0","id":1,"result":"0x534e5f4d41494e"}' ;;
  starknet_getClassHashAt)
    addr=$(printf '%s' "$payload" | jq -r '.params.contract_address // empty')
    an=$(norm "$addr")
    if [ "$an" = "$HELPER_N" ]; then cls="${MOCK_HELPER_CLASS:-none}"
    elif [ "$an" = "$CORE_N" ]; then cls="${MOCK_CIRCLE_CLASS:-none}"
    else cls="${MOCK_POOL_CLASS:-none}"; fi
    if [ "$cls" = "none" ]; then
      echo '{"jsonrpc":"2.0","id":1,"error":{"code":20,"message":"Contract not found"}}'
    else
      printf '{"jsonrpc":"2.0","id":1,"result":"%s"}\n' "$cls"
    fi ;;
  starknet_call)
    sel=$(printf '%s' "$payload" | jq -r '.params.request.entry_point_selector // empty')
    case "$sel" in
      0x01847d98d2c5c239f7b89e5ccb00b2b0aa9d78cf297e3334b68e1707ed49d3b2)
        printf '{"jsonrpc":"2.0","id":1,"result":%s}\n' "${MOCK_HELPER_CONFIG:-[]}" ;;
      0x00dff80fd5377ea4fb11e78ea05ff6b4758553ff4352383b73215096c3ee54e0)
        if [ -f "${MOCK_INVOKE_MARKER:-/nonexistent}" ]; then
          printf '{"jsonrpc":"2.0","id":1,"result":%s}\n' "${MOCK_CORE_CONFIG_POST:-[]}"
        else
          printf '{"jsonrpc":"2.0","id":1,"result":%s}\n' "${MOCK_CORE_CONFIG_PRE:-[]}"
        fi ;;
      *) echo '{"jsonrpc":"2.0","id":1,"error":{"code":21,"message":"entrypoint not found"}}' ;;
    esac ;;
  *)
    echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}' ;;
esac
SH
chmod +x "$WORK/bin/curl"

cat > "$WORK/bin/sncast" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MOCK_SNCAST_ARGS:-/dev/null}"
cmd=""; fn=""; prev=""
for a in "$@"; do
  case "$a" in declare|deploy|invoke|call) cmd="$a" ;; esac
  [ "$prev" = "--function" ] && fn="$a"
  prev="$a"
done
args="$(printf '%s' "$*")"
args="${args,,}"
case "$cmd" in
  declare)
    echo "command: declare"
    echo "transaction_hash: 0x1111111111111111111111111111111111111111111111111111111111111111"
    case "$args" in
      *iwastrk20helper*)
        echo "class_hash: ${MOCK_HELPER_DECLARE_CLASS:-0x56f037212521b23d072628bcccac937e8e5773dd99a0dab6859a7d0a55641cd}" ;;
      *)
        echo "class_hash: ${MOCK_CIRCLE_DECLARE_CLASS:-0x1848a8ffbf0465f3afa44e5db06f52ab2b6e8051e2e2367dd8539e5b7211d1e}" ;;
    esac ;;
  deploy)
    echo "command: deploy"
    echo "transaction_hash: 0x2222222222222222222222222222222222222222222222222222222222222222"
    case "$args" in
      *0x56f037212521b23d072628bcccac937e8e5773dd99a0dab6859a7d0a55641cd*)
        if [ "${MOCK_HELPER_DEPLOY_MALFORMED:-0}" = "1" ]; then
          echo "Error: transaction failed"
        else
          echo "contract_address: 0x48c90774b5bc798438c6db2b85163151b2e5057d7a07e6cd1c58b4bbaf0b71e"
        fi ;;
      *)
        echo "contract_address: 0x02cc664789697a4ea74ea062bcb826e57317eab1d17a6f6803b01406292b42cb" ;;
    esac ;;
  invoke)
    echo "command: invoke"
    echo "transaction_hash: 0x3333333333333333333333333333333333333333333333333333333333333333"
    : > "${MOCK_INVOKE_MARKER:-/nonexistent}"
    ;;
  call)
    case "$fn" in
      get_version)    echo "Response: [0x322e30]" ;;
      get_fee_amount) echo "Response: [0x53444835ec580000]" ;;
      symbol)
        case "$args" in
          *0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb*) echo 'Response: ["USDC"]' ;;
          *) echo 'Response: ["STRK"]' ;;
        esac ;;
      decimals)
        case "$args" in
          *0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb*) echo "Response: [0x6]" ;;
          *) echo "Response: [0x12]" ;;
        esac ;;
      *) echo "Response: []" ;;
    esac ;;
  *)
    echo "unknown sncast subcommand: $*" >&2
    exit 1 ;;
esac
SH
chmod +x "$WORK/bin/sncast"

export PATH="$WORK/bin:$PATH"

HELPER=0x48c90774b5bc798438c6db2b85163151b2e5057d7a07e6cd1c58b4bbaf0b71e
HELPER_CLASS=0x56f037212521b23d072628bcccac937e8e5773dd99a0dab6859a7d0a55641cd
CIRCLE_CLASS=0x1848a8ffbf0465f3afa44e5db06f52ab2b6e8051e2e2367dd8539e5b7211d1e
CIRCLE=0x02cc664789697a4ea74ea062bcb826e57317eab1d17a6f6803b01406292b42cb

happy_helper_config() {
  printf '["%s","%s","%s","%s","%s"]' "$CIRCLE" "$POOL" "$USDC" "$STRK" "$SINK"
}
happy_core_pre()  { printf '["0x0","%s","%s","0x0"]' "$POOL" "$AUTH"; }
happy_core_post() { printf '["%s","%s","0x0","0x1"]' "$HELPER" "$POOL"; }

MOCK_HELPER_CLASS="$HELPER_CLASS"
MOCK_CIRCLE_CLASS="$CIRCLE_CLASS"
MOCK_HELPER_CONFIG=$(happy_helper_config)
MOCK_CORE_CONFIG_PRE=$(happy_core_pre)
MOCK_CORE_CONFIG_POST=$(happy_core_post)
export MOCK_HELPER_CLASS MOCK_CIRCLE_CLASS MOCK_HELPER_CONFIG MOCK_CORE_CONFIG_PRE MOCK_CORE_CONFIG_POST

assert_accepts "helper gate passes a correct, uninitialized deployment" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"
assert_output_contains "gate reports the helper hosts the exact class" \
  "helper hosts the exact IwaStrk20Helper class" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"
assert_output_contains "gate reports the core is uninitialized and ready" \
  "core is uninitialized and ready" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

# Exact normalized (felt-wise) equality: a padded helper address is the same
# address and must still pass.
assert_accepts "padded helper address passes through normalized equality" \
  "$TOOL" check-helper "$WORK/good.json" \
  "0x048c90774b5bc798438c6db2b85163151b2e5057d7a07e6cd1c58b4bbaf0b71e" \
  "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CLASS=none
export MOCK_HELPER_CLASS
assert_rejects "a nonexistent helper blocks initialization" \
  "no contract deployed at helper" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

# The exact historical failure: the dead wired address ...bafb071e has no
# contract, so the gate must refuse before any init could be sent.
assert_rejects "the dead wired helper address (historical bug) blocks initialization" \
  "no contract deployed at helper" \
  "$TOOL" check-helper "$WORK/good.json" \
  "0x048c90774b5bc798438c6db2b85163151b2e5057d7a07e6cd1c58b4bbafb071e" \
  "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CLASS=0x1234deadbeef1234deadbeef1234deadbeef1234deadbeef1234deadbeef1234dead
export MOCK_HELPER_CLASS
assert_rejects "a helper running a different class blocks initialization" \
  "runs class" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CLASS="$HELPER_CLASS"
MOCK_HELPER_CONFIG=$(printf '["0x1111111111111111111111111111111111111111111111111111111111111111","%s","%s","%s","%s"]' "$POOL" "$USDC" "$STRK" "$SINK")
export MOCK_HELPER_CONFIG
assert_rejects "a helper pointing at the wrong circle blocks initialization" \
  "iwa_circle is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CONFIG=$(printf '["%s","0x1111111111111111111111111111111111111111111111111111111111111111","%s","%s","%s"]' "$CIRCLE" "$USDC" "$STRK" "$SINK")
assert_rejects "a helper with the wrong privacy pool blocks initialization" \
  "privacy_pool is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CONFIG=$(printf '["%s","%s","0x1111111111111111111111111111111111111111111111111111111111111111","%s","%s"]' "$CIRCLE" "$POOL" "$STRK" "$SINK")
assert_rejects "a helper with the wrong USDC blocks initialization" \
  "usdc_token is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CONFIG=$(printf '["%s","%s","%s","0x1111111111111111111111111111111111111111111111111111111111111111","%s"]' "$CIRCLE" "$POOL" "$USDC" "$SINK")
assert_rejects "a helper with the wrong STRK blocks initialization" \
  "strk_token is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CONFIG=$(printf '["%s","%s","%s","%s","0x1111111111111111111111111111111111111111111111111111111111111111"]' "$CIRCLE" "$POOL" "$USDC" "$STRK")
assert_rejects "a helper with the wrong surplus sink blocks initialization" \
  "surplus_sink is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_HELPER_CONFIG=$(happy_helper_config)
MOCK_CORE_CONFIG_PRE=$(printf '["0x0","%s","%s","0x1"]' "$POOL" "$AUTH")
export MOCK_CORE_CONFIG_PRE
assert_rejects "an already-initialized circle blocks initialization" \
  "already true" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_CORE_CONFIG_PRE=$(printf '["%s","%s","%s","0x0"]' "$HELPER" "$POOL" "$AUTH")
assert_rejects "a circle already wired to a helper blocks initialization" \
  "already wired" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_CORE_CONFIG_PRE=$(printf '["0x0","%s","0x1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd","0x0"]' "$POOL")
assert_rejects "a mismatched setup authority blocks initialization" \
  "setup_authority is" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE" "$HELPER_CLASS"

MOCK_CORE_CONFIG_PRE=$(happy_core_pre)
export MOCK_CORE_CONFIG_PRE

assert_rejects "a missing helper class hash argument is refused" \
  "is missing from config" \
  "$TOOL" check-helper "$WORK/good.json" "$HELPER" "$CIRCLE"

# --------------------------------------------------------------------------
# E. Deployment salt policy and gated deploy (mocked sncast + RPC)
# --------------------------------------------------------------------------

printf '\n--- E. Salt policy and gated deploy ---\n'

mkcfg "$WORK/saltzero.json" "$SINK" "$USDC" "$STRK" "$AUTH" "$POOL" "mainnet" "0x0"
assert_rejects "salt 0x0 is refused (the abandoned deployment occupies salt-0 addresses)" \
  "salt must not be 0x0" \
  "$TOOL" plan "$WORK/saltzero.json"

assert_output_contains "a missing salt generates and prints a fresh one" \
  "generated fresh deployment salt" \
  "$TOOL" plan "$WORK/good.json"

MOCK_SNCAST_ARGS="$WORK/sncast-args.log"
MOCK_INVOKE_MARKER="$WORK/invoke.marker"
export MOCK_SNCAST_ARGS MOCK_INVOKE_MARKER
MOCK_POOL_CLASS=0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d
export MOCK_POOL_CLASS
export IWA_ARTIFACTS_FILE="$WORK/artifacts.json"

out=$("$TOOL" deploy "$WORK/good.json" --confirm-send 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "full gated deployment passes with correct mocks"
else
  fail "full gated deployment failed (rc=$rc): $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi
if printf '%s' "$out" | grep -qi "Pre-initialization helper gate"; then
  pass "deployment ran the pre-init helper gate"
else
  fail "deployment did not run the pre-init helper gate"
fi
if [ -f "$MOCK_INVOKE_MARKER" ]; then
  pass "init invoke was sent only after the gate passed"
else
  fail "init invoke was never sent"
fi
if grep -q -- "--salt" "$MOCK_SNCAST_ARGS" && ! grep -q -- "--salt 0x0" "$MOCK_SNCAST_ARGS"; then
  pass "deploys passed a fresh non-zero salt"
else
  fail "deploys did not receive a fresh non-zero salt"
fi

rm -f "$MOCK_INVOKE_MARKER" "$MOCK_SNCAST_ARGS"
MOCK_HELPER_DEPLOY_MALFORMED=1
export MOCK_HELPER_DEPLOY_MALFORMED
out=$("$TOOL" deploy "$WORK/good.json" --confirm-send 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "no parseable contract_address"; then
  pass "malformed sncast deploy output fails closed"
else
  fail "malformed sncast deploy output did not fail closed (rc=$rc)"
fi
if [ ! -f "$MOCK_INVOKE_MARKER" ]; then
  pass "no init invoke was sent after malformed output"
else
  fail "init invoke was sent despite malformed output"
fi
unset MOCK_HELPER_DEPLOY_MALFORMED

# --------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

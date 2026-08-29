#!/usr/bin/env bash
#
# IWA Starknet deployment tool (Task 8C).
#
# Deliberately boring and explicit. It only ever acts on two contracts, named
# one by one; it never enumerates build artifacts. The pinned STRK20 pool
# (`Privacy`) is compiled into this package's artifacts so integration tests can
# declare the genuine contract, and this tool must never declare or deploy it —
# the mainnet pool already exists and belongs to StarkWare.
#
# Subcommands:
#   validate <config.json>              offline + read-only on-chain checks
#   plan     <config.json>              print the exact ordered deployment steps
#   deploy   <config.json>              SENDS TRANSACTIONS; requires --confirm-send
#   check-sink <config.json> <deployed-iwa-circle>
#                                       offline: refuses a surplus_sink that
#                                       collides with the deployed IwaCircle
#   verify   <config.json> <core> <helper>
#                                       read-only post-deployment verification
#
# Read-only by default. `deploy` refuses to run without an explicit flag.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The complete set of contracts IWA is ever allowed to declare or deploy.
# Adding to this list is a security decision, not a convenience.
readonly -a ALLOWED_CONTRACTS=("IwaCircle" "IwaStrk20Helper")

# Contracts that are present in build artifacts but must never be touched.
# `Privacy` is StarkWare's pool: IWA integrates with the deployed instance.
readonly -a FORBIDDEN_CONTRACTS=("Privacy")

# Entrypoints that must not exist on IwaCircle: a settlement-helper replacement
# path would defeat the one-time initialization lock.
readonly -a FORBIDDEN_ENTRYPOINTS=(
  "set_settlement_helper"
  "update_settlement_helper"
  "replace_settlement_helper"
  "set_surplus_sink"
)

readonly EXPECTED_CHAIN_ID_SN_MAIN="0x534e5f4d41494e"

RED=""; GRN=""; YLW=""; RST=""
if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'; fi

die() { printf '%sFAIL%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
ok()  { printf '%s ok %s %s\n' "$GRN" "$RST" "$*"; }
warn(){ printf '%swarn%s %s\n' "$YLW" "$RST" "$*"; }
step(){ printf '\n=== %s ===\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

CFG_FILE=""
CFG_NETWORK=""; CFG_RPC=""; CFG_POOL=""; CFG_USDC=""; CFG_STRK=""
CFG_SINK=""; CFG_SETUP_AUTHORITY=""; CFG_ACCOUNT=""

cfg() { jq -r --arg k "$1" '.[$k] // ""' "$CFG_FILE"; }

load_config() {
  CFG_FILE="${1:-}"
  [ -n "$CFG_FILE" ] || die "usage: $0 <subcommand> <config.json>"
  [ -f "$CFG_FILE" ] || die "config file not found: $CFG_FILE"
  jq -e . "$CFG_FILE" >/dev/null 2>&1 || die "config is not valid JSON: $CFG_FILE"

  CFG_NETWORK=$(cfg network)
  CFG_RPC=$(cfg rpc_url)
  CFG_POOL=$(cfg privacy_pool)
  CFG_USDC=$(cfg usdc_token)
  CFG_STRK=$(cfg strk_token)
  CFG_SINK=$(cfg surplus_sink)
  CFG_SETUP_AUTHORITY=$(cfg setup_authority)
  CFG_ACCOUNT=$(cfg deployer_account)
}

# Normalizes to lowercase, unpadded-but-comparable form. Starknet addresses are
# felts, so 0x01... and 0x1... are the same address and must compare equal.
norm_addr() {
  local a="${1,,}"
  a="${a#0x}"
  a="$(printf '%s' "$a" | sed 's/^0*//')"
  [ -n "$a" ] || a="0"
  printf '0x%s' "$a"
}

is_hex_address() {
  [[ "${1,,}" =~ ^0x[0-9a-f]{1,64}$ ]]
}

require_address() {
  local label="$1" value="$2"
  [ -n "$value" ] || die "$label is missing from config"
  case "$value" in
    *REPLACE_ME*|*PLACEHOLDER*|*TODO*)
      die "$label is still a placeholder ($value) — set a real address" ;;
  esac
  is_hex_address "$value" || die "$label is not a hex address: $value"
  [ "$(norm_addr "$value")" != "0x0" ] || die "$label must not be the zero address"
}

same_addr() { [ "$(norm_addr "$1")" = "$(norm_addr "$2")" ]; }

# --------------------------------------------------------------------------
# A. Artifact selection — explicit allowlist, never enumeration
# --------------------------------------------------------------------------

artifacts_file() {
  local f="${IWA_ARTIFACTS_FILE:-${PACKAGE_DIR}/target/dev/iwa.starknet_artifacts.json}"
  [ -f "$f" ] || die "build artifacts not found: $f (run: scarb build)"
  printf '%s' "$f"
}

# Returns the sierra artifact path for exactly one allowlisted contract name.
select_artifact() {
  local name="$1" file="$2" count
  local allowed=0
  for c in "${ALLOWED_CONTRACTS[@]}"; do [ "$c" = "$name" ] && allowed=1; done
  [ "$allowed" = "1" ] || die "refusing to select non-allowlisted contract: $name"

  count=$(jq --arg n "$name" '[.contracts[] | select(.contract_name == $n)] | length' "$file")
  [ "$count" = "1" ] || die "expected exactly 1 artifact named '$name', found $count"
  jq -r --arg n "$name" '.contracts[] | select(.contract_name == $n) | .artifacts.sierra' "$file"
}

check_artifacts() {
  local file; file="$(artifacts_file)"
  step "A. Artifact selection (explicit allowlist)"
  printf 'artifacts file: %s\n' "$file"

  for name in "${ALLOWED_CONTRACTS[@]}"; do
    local sierra; sierra="$(select_artifact "$name" "$file")"
    [ -n "$sierra" ] && [ "$sierra" != "null" ] || die "no sierra artifact for $name"
    ok "selected $name -> $sierra"
  done

  # Everything else present is reported and deliberately ignored. A forbidden
  # contract being present is expected and must never become a deployment.
  local other
  other=$(jq -r --argjson allow "$(printf '%s\n' "${ALLOWED_CONTRACTS[@]}" | jq -R . | jq -s .)" \
    '[.contracts[].contract_name] - $allow | .[]' "$file")
  if [ -n "$other" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      local forbidden=0
      for f in "${FORBIDDEN_CONTRACTS[@]}"; do [ "$f" = "$name" ] && forbidden=1; done
      if [ "$forbidden" = "1" ]; then
        ok "ignoring forbidden artifact '$name' (never declared or deployed by IWA)"
      else
        ok "ignoring unexpected artifact '$name' (not on the allowlist)"
      fi
    done <<< "$other"
  fi

  # Belt and braces: prove the allowlist itself excludes every forbidden name.
  for f in "${FORBIDDEN_CONTRACTS[@]}"; do
    for c in "${ALLOWED_CONTRACTS[@]}"; do
      [ "$c" = "$f" ] && die "allowlist is corrupt: forbidden contract '$f' is allowlisted"
    done
  done
  ok "allowlist excludes all forbidden contracts"
}

# Refuses if IwaCircle exposes any helper-replacement entrypoint.
check_no_forbidden_entrypoints() {
  local file sierra path
  file="$(artifacts_file)"
  sierra="$(select_artifact "IwaCircle" "$file")"
  path="$(dirname "$file")/$sierra"
  [ -f "$path" ] || die "IwaCircle sierra artifact missing: $path"

  step "A2. Forbidden entrypoint check (IwaCircle)"
  local names
  names=$(jq -r '[.abi[]? | select(.type=="interface") | .items[]?.name,
                  (.abi[]? | select(.type=="function") | .name)] | .[]?' "$path" 2>/dev/null || true)
  if [ -z "$names" ]; then
    names=$(jq -r '.. | objects | select(.type? == "function") | .name' "$path" 2>/dev/null || true)
  fi
  [ -n "$names" ] || die "could not read any entrypoint names from $path"

  for bad in "${FORBIDDEN_ENTRYPOINTS[@]}"; do
    if printf '%s\n' "$names" | grep -qx "$bad"; then
      die "IwaCircle exposes forbidden entrypoint '$bad'"
    fi
    ok "no '$bad' entrypoint"
  done

  printf '%s\n' "$names" | grep -qx "initialize_settlement_helper" \
    || die "IwaCircle is missing initialize_settlement_helper"
  ok "initialize_settlement_helper present (one-time)"
}

# --------------------------------------------------------------------------
# B/D. Configuration validation
# --------------------------------------------------------------------------

check_config_offline() {
  step "B. Configuration validation (offline)"
  [ -n "$CFG_NETWORK" ] || die "network is missing from config"
  [ -n "$CFG_RPC" ] || die "rpc_url is missing from config"

  require_address "privacy_pool"   "$CFG_POOL"
  require_address "usdc_token"     "$CFG_USDC"
  require_address "strk_token"     "$CFG_STRK"
  require_address "surplus_sink"   "$CFG_SINK"
  require_address "setup_authority" "$CFG_SETUP_AUTHORITY"
  ok "all required addresses present, non-zero and well formed"

  # Mirrors the on-chain constructor guards, so a bad config fails before it
  # ever costs a transaction.
  ! same_addr "$CFG_USDC" "$CFG_STRK" || die "usdc_token and strk_token must differ"
  ! same_addr "$CFG_SINK" "$CFG_POOL" || die "surplus_sink must not be the privacy pool"
  ! same_addr "$CFG_SINK" "$CFG_USDC" || die "surplus_sink must not be a configured token"
  ! same_addr "$CFG_SINK" "$CFG_STRK" || die "surplus_sink must not be a configured token"
  ok "no forbidden address collisions (tokens, pool, sink)"

  # Not enforced on chain, but a deployment smell worth blocking early.
  if same_addr "$CFG_SINK" "$CFG_SETUP_AUTHORITY"; then
    die "surplus_sink must not be the setup authority (see the sink policy in README.md)"
  fi
  ok "surplus_sink is distinct from the setup authority"
}

rpc_call() {
  local method="$1" params="$2"
  curl -s -m 30 -X POST "$CFG_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

check_network() {
  step "D. Network check (read-only)"
  local resp chain
  resp=$(rpc_call starknet_chainId '[]') || die "RPC call failed: $CFG_RPC"
  chain=$(printf '%s' "$resp" | jq -r '.result // empty')
  [ -n "$chain" ] || die "RPC did not return a chain id: $resp"

  case "$CFG_NETWORK" in
    mainnet|SN_MAIN)
      [ "${chain,,}" = "$EXPECTED_CHAIN_ID_SN_MAIN" ] \
        || die "network mismatch: config says '$CFG_NETWORK' but RPC chain id is $chain" ;;
    *)
      warn "non-mainnet network '$CFG_NETWORK' (chain id $chain) — mainnet guards relaxed" ;;
  esac
  ok "RPC chain id $chain matches configured network '$CFG_NETWORK'"
}

sn_call() {
  local addr="$1" fn="$2"; shift 2
  ( cd "$PACKAGE_DIR" && sncast call --url "$CFG_RPC" --contract-address "$addr" \
      --function "$fn" "$@" 2>&1 )
}

check_onchain_config() {
  step "E. On-chain configuration check (read-only)"

  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$CFG_POOL\"}" | jq -r '.result // empty')
  [ -n "$cls" ] || die "no contract deployed at privacy_pool $CFG_POOL"
  ok "privacy_pool has a deployed class: $cls"

  local ver
  ver=$(sn_call "$CFG_POOL" get_version | grep -E '^Response:' | head -1 || true)
  printf '     pool get_version -> %s\n' "${ver:-<none>}"
  [ -n "$ver" ] || die "privacy_pool did not answer get_version — is this really the STRK20 pool?"
  ok "privacy_pool answers the STRK20 pool view interface"

  local fee
  fee=$(sn_call "$CFG_POOL" get_fee_amount | grep -E '^Response:' | head -1 || true)
  printf '     pool get_fee_amount -> %s\n' "${fee:-<none>}"
  warn "the pool charges this fee in STRK per apply_actions call, paid by the caller"

  local sym dec
  for pair in "usdc_token:$CFG_USDC:USDC" "strk_token:$CFG_STRK:STRK"; do
    local label="${pair%%:*}" rest="${pair#*:}"
    local addr="${rest%%:*}" want="${rest##*:}"
    sym=$(sn_call "$addr" symbol | grep -E '^Response:' | head -1 || true)
    dec=$(sn_call "$addr" decimals | grep -E '^Response:' | head -1 || true)
    printf '     %s symbol -> %s / decimals -> %s\n' "$label" "${sym:-<none>}" "${dec:-<none>}"
    printf '%s' "$sym" | grep -q "\"$want\"" \
      || die "$label at $addr does not report symbol $want"
    ok "$label verified on chain as $want"
  done
}

# --------------------------------------------------------------------------
# C. Deployment ordering
# --------------------------------------------------------------------------

print_plan() {
  step "C. Deployment order (approved sequence)"
  cat <<PLAN
  1. Verify pool and token addresses on the target network   [validate]
  2. Declare + deploy IwaCircle
        constructor: usdc_token, strk_token, privacy_pool, setup_authority
        usdc_token      = $CFG_USDC
        strk_token      = $CFG_STRK
        privacy_pool    = $CFG_POOL
        setup_authority = $CFG_SETUP_AUTHORITY
  3. Declare + deploy IwaStrk20Helper
        constructor: iwa_circle, privacy_pool, usdc_token, strk_token, surplus_sink
        iwa_circle      = <IwaCircle address from step 2>
        privacy_pool    = $CFG_POOL
        usdc_token      = $CFG_USDC
        strk_token      = $CFG_STRK
        surplus_sink    = $CFG_SINK
  4. initialize_settlement_helper(helper) — exactly once, from setup_authority
  5. Verify stored helper equals the deployed helper
  6. Verify setup authority is cleared to zero
  7. Verify no replacement setter exists                     [validate]
  8. Verify helper config matches every expected address     [verify]

  Steps 5-8 are re-run by: $0 verify <config.json> <core> <helper>
PLAN
}

# --------------------------------------------------------------------------
# Post-deployment verification
# --------------------------------------------------------------------------

resp_value() { grep -E '^Response:' | head -1 | sed 's/^Response: *//'; }

verify_deployment() {
  local core="$1" helper="$2"
  require_address "deployed IwaCircle" "$core"
  require_address "deployed IwaStrk20Helper" "$helper"

  step "Post-deployment verification (read-only)"

  local cfg_out
  cfg_out=$(sn_call "$core" get_settlement_config)
  printf '  core get_settlement_config:\n%s\n' "$cfg_out"
  printf '%s' "$cfg_out" | grep -qi "$(norm_addr "$helper" | sed 's/^0x//')" \
    || die "core does not report the deployed helper as its settlement helper"
  ok "stored settlement helper matches the deployed helper"

  printf '%s' "$cfg_out" | grep -qi "true" \
    || die "core does not report helper_initialized = true"
  ok "helper initialization is locked"

  local hcfg
  hcfg=$(sn_call "$helper" get_config)
  printf '  helper get_config:\n%s\n' "$hcfg"
  for pair in "iwa_circle:$core" "privacy_pool:$CFG_POOL" "usdc:$CFG_USDC" \
              "strk:$CFG_STRK" "surplus_sink:$CFG_SINK"; do
    local label="${pair%%:*}" addr="${pair#*:}"
    printf '%s' "$hcfg" | grep -qi "$(norm_addr "$addr" | sed 's/^0x//')" \
      || die "helper config does not contain expected $label = $addr"
    ok "helper config contains expected $label"
  done

  warn "confirm by eye that setup_authority in get_settlement_config is 0x0"
  warn "confirm the helper is not on the pool's blocked_open_note_depositors list"
}

# --------------------------------------------------------------------------
# surplus_sink vs. deployed IwaCircle
# --------------------------------------------------------------------------

# The sink policy forbids using the IwaCircle address, but the circle does not
# exist during initial config validation, so `validate` cannot check it. This is
# the only moment it can be checked: after IwaCircle is deployed and before the
# helper's immutable constructor consumes the sink. The helper constructor
# rejects a sink equal to the pool, either token, or the helper itself, but it
# does not know the circle address, so nothing on chain enforces this one.
assert_sink_not_circle() {
  local core="$1"
  require_address "deployed IwaCircle" "$core"
  if same_addr "$CFG_SINK" "$core"; then
    die "surplus_sink is the deployed IwaCircle.
       surplus_sink     $CFG_SINK
       deployed circle  $core
     The sink is immutable once the helper is deployed, and IwaCircle has no
     path to move tokens, so any surplus sent there would be stranded forever.
     Aborting BEFORE the helper is deployed and BEFORE initialization.
     Set surplus_sink to a dedicated IWA treasury multisig and re-run."
  fi
  ok "surplus_sink is distinct from the deployed IwaCircle"
}

# --------------------------------------------------------------------------
# Deployment (gated)
# --------------------------------------------------------------------------

do_deploy() {
  local confirmed="${1:-}"
  [ "$confirmed" = "--confirm-send" ] || die \
    "deploy sends real transactions and spends real funds.
     Re-run with: $0 deploy <config.json> --confirm-send
     Nothing has been sent."

  [ -n "$CFG_ACCOUNT" ] || die "deployer_account is required to deploy"
  need sncast

  check_artifacts
  check_no_forbidden_entrypoints
  check_config_offline
  check_network
  check_onchain_config

  step "Deploying (transactions WILL be sent)"
  # Each declare names exactly one allowlisted contract. There is no loop over
  # artifacts anywhere in this function.
  local core_class helper_class
  core_class=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaCircle | tee /dev/stderr \
    | grep -Eo '0x[0-9a-fA-F]+' | tail -1)
  [ -n "$core_class" ] || die "IwaCircle declare produced no class hash"

  local core
  core=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$core_class" \
    --constructor-calldata "$CFG_USDC" "$CFG_STRK" "$CFG_POOL" "$CFG_SETUP_AUTHORITY" \
    | tee /dev/stderr | grep -Eo '0x[0-9a-fA-F]+' | tail -1)
  [ -n "$core" ] || die "IwaCircle deploy produced no address"
  ok "IwaCircle deployed at $core"

  # Policy gate. Nothing below this line runs if the sink collides with the
  # circle: no helper deployment, no initialization.
  assert_sink_not_circle "$core"

  helper_class=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaStrk20Helper | tee /dev/stderr \
    | grep -Eo '0x[0-9a-fA-F]+' | tail -1)
  [ -n "$helper_class" ] || die "IwaStrk20Helper declare produced no class hash"

  local helper
  helper=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$helper_class" \
    --constructor-calldata "$core" "$CFG_POOL" "$CFG_USDC" "$CFG_STRK" "$CFG_SINK" \
    | tee /dev/stderr | grep -Eo '0x[0-9a-fA-F]+' | tail -1)
  [ -n "$helper" ] || die "IwaStrk20Helper deploy produced no address"
  ok "IwaStrk20Helper deployed at $helper"

  (cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" invoke --url "$CFG_RPC" \
    --contract-address "$core" --function initialize_settlement_helper \
    --calldata "$helper")
  ok "initialize_settlement_helper called once"

  verify_deployment "$core" "$helper"
  printf '\nRecord these addresses:\n  IwaCircle       %s\n  IwaStrk20Helper %s\n' "$core" "$helper"
}

# --------------------------------------------------------------------------

main() {
  need jq; need curl
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    validate)
      load_config "${1:-}"
      check_artifacts
      check_no_forbidden_entrypoints
      check_config_offline
      need sncast
      check_network
      check_onchain_config
      printf '\n%sVALIDATION PASSED%s — nothing was sent.\n' "$GRN" "$RST"
      ;;
    plan)
      load_config "${1:-}"
      check_config_offline
      print_plan
      printf '\nNo transactions were sent.\n'
      ;;
    check-artifacts)
      check_artifacts
      check_no_forbidden_entrypoints
      ;;
    check-sink)
      load_config "${1:-}"
      check_config_offline
      assert_sink_not_circle "${2:-}"
      printf '\nSINK CHECK PASSED — nothing was sent.\n'
      ;;
    verify)
      load_config "${1:-}"
      need sncast
      verify_deployment "${2:-}" "${3:-}"
      ;;
    deploy)
      load_config "${1:-}"
      do_deploy "${2:-}"
      ;;
    *)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 1
      ;;
  esac
}

main "$@"

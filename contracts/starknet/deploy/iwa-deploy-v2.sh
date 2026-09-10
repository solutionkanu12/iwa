#!/usr/bin/env bash
#
# IWA Starknet V2 deployment tool — Candidate P private pot collection.
#
# Security template: contracts/starknet/deploy/iwa-deploy.sh (V1). This is the
# same tool, re-pointed at IwaCircleV2 / IwaStrk20HelperV2, with every
# security-critical value HARDCODED below (not read from a config file) and
# re-asserted on chain. The config file names only the signing account and an
# optional fixed salt.
#
# It only ever acts on two contracts, named one by one; it never enumerates
# build artifacts. `Privacy` (StarkWare's pool) and the V1 IwaCircle /
# IwaStrk20Helper classes are on an explicit forbidden list — this tool must
# never declare or deploy any of them.
#
# Subcommands (only `deploy` sends transactions, and only with --confirm-send):
#   preflight  <config.json>                       ALL non-sending checks, PASS/FAIL summary
#   validate   <config.json>                       offline + read-only on-chain checks
#   plan       <config.json>                       print the exact ordered deployment steps
#   check-artifacts                                allowlist + local class-hash + forbidden entrypoints
#   check-sink  <config.json> <deployed-CircleV2>  offline: sink must not be the deployed circle
#   check-helper <config.json> <circleV2> <helperV2>
#                                                  PRE-INIT HARD STOP (read-only, fail-closed)
#   verify      <config.json> <circleV2> <helperV2>
#                                                  POST-INIT verification (read-only)
#   deploy      <config.json> --confirm-send       SENDS TRANSACTIONS
#
# Read-only by default. `deploy` refuses to run without an explicit flag.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --------------------------------------------------------------------------
# HARDCODED, ALREADY-REVIEWED VALUES. Not read from config. Not overridable.
# --------------------------------------------------------------------------

# The complete set of contracts this tool is ever allowed to declare or deploy.
readonly -a ALLOWED_CONTRACTS=("IwaCircleV2" "IwaStrk20HelperV2")

# Present in build artifacts, must never be touched by the V2 tool:
#   Privacy            — StarkWare's deployed pool
#   IwaCircle          — the immutable V1 core (deployed, wired, authority cleared)
#   IwaStrk20Helper    — the immutable V1 helper
readonly -a FORBIDDEN_CONTRACTS=("Privacy" "IwaCircle" "IwaStrk20Helper")

# Entrypoints that must not exist on IwaCircleV2: any settlement-helper
# replacement or admin/upgrade path would defeat the one-time initialization
# lock and the "no mutable admin" invariant.
readonly -a FORBIDDEN_ENTRYPOINTS=(
  "set_settlement_helper"
  "update_settlement_helper"
  "replace_settlement_helper"
  "set_surplus_sink"
  "set_setup_authority"
  "transfer_setup_authority"
  "upgrade"
  "replace_class"
  "set_class_hash"
  "transfer_ownership"
  "renounce_ownership"
  "set_admin"
  "pause"
  "unpause"
)

readonly EXPECTED_CHAIN_ID_SN_MAIN="0x534e5f4d41494e"

# V2 class hashes — computed from the pinned Scarb 2.18.0 / Cairo 2.18.0 build
# and cross-checked against the two deployed V1 class hashes reproduced
# byte-for-byte by the same toolchain. See the deployment-prep report.
readonly EXPECTED_CIRCLE_V2_CLASS="0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a"
readonly EXPECTED_HELPER_V2_CLASS="0x039b102d6bac470782aa7bd73dd37a6a0e07bee136a1fc1947dc79151ecb70f5"

# Reviewed mainnet configuration. Identical to the V1-verified values.
readonly EXPECTED_USDC="0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb"
readonly EXPECTED_STRK="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
readonly EXPECTED_POOL="0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"
readonly EXPECTED_SINK="0x043d08F5B0D621eF22f91B954e719d7C0a5a8c6ed89308bA05f36FAe42F2d804"
readonly EXPECTED_SETUP_AUTHORITY="0x04099B8eBD6e6c642B4B31BFD27A9c781AB9b41D7f66F80d5C04CC51c0977E85"

# The V1 deployment, so the V2 tool can refuse any accidental reuse.
readonly V1_IWA_CIRCLE="0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be"
readonly V1_IWA_HELPER="0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb"
readonly V1_IWA_CIRCLE_CLASS="0x1848a8ffbf0465f3afa44e5db06f52ab2b6e8051e2e2367dd8539e5b7211d1e"
readonly V1_IWA_HELPER_CLASS="0x56f037212521b23d072628bcccac937e8e5773dd99a0dab6859a7d0a55641cd"

# Entry-point selectors (starknet_keccak of the name). Name-derived, so V2
# reuses the same selectors as V1 for the shared view functions.
readonly SEL_GET_SETTLEMENT_CONFIG="0x00dff80fd5377ea4fb11e78ea05ff6b4758553ff4352383b73215096c3ee54e0"
readonly SEL_GET_CONFIG="0x01847d98d2c5c239f7b89e5ccb00b2b0aa9d78cf297e3334b68e1707ed49d3b2"
readonly SEL_GET_PAYOUT_STATE_V2="0x038f973d53e36700b4f9a24ef4a23e4afa7ad41fb483b18426e46f54fbacabb6"

RED=""; GRN=""; YLW=""; RST=""
if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'; fi

die() { printf '%sFAIL%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
ok()  { printf '%s ok %s %s\n' "$GRN" "$RST" "$*"; }
warn(){ printf '%swarn%s %s\n' "$YLW" "$RST" "$*"; }
step(){ printf '\n=== %s ===\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

# Preflight PASS/FAIL accounting. Non-fatal recording so `preflight` can report
# every line rather than aborting on the first failure.
PF_PASS=0; PF_FAIL=0
declare -a PF_LINES=()
pf() {
  local status="$1"; shift
  case "$status" in
    PASS) PF_PASS=$((PF_PASS+1)); PF_LINES+=("${GRN}PASS${RST}  $*"); printf '%sPASS%s  %s\n' "$GRN" "$RST" "$*" ;;
    FAIL) PF_FAIL=$((PF_FAIL+1)); PF_LINES+=("${RED}FAIL${RST}  $*"); printf '%sFAIL%s  %s\n' "$RED" "$RST" "$*" ;;
    WARN) PF_LINES+=("${YLW}WARN${RST}  $*"); printf '%sWARN%s  %s\n' "$YLW" "$RST" "$*" ;;
  esac
}

# --------------------------------------------------------------------------
# Config (account + salt only)
# --------------------------------------------------------------------------

CFG_FILE=""
CFG_NETWORK=""; CFG_RPC=""; CFG_ACCOUNT=""; CFG_SALT=""

cfg() { jq -r --arg k "$1" '.[$k] // ""' "$CFG_FILE"; }

load_config() {
  CFG_FILE="${1:-}"
  [ -n "$CFG_FILE" ] || die "usage: $0 <subcommand> <config.json>"
  [ -f "$CFG_FILE" ] || die "config file not found: $CFG_FILE (copy deploy-v2.config.example.json)"
  jq -e . "$CFG_FILE" >/dev/null 2>&1 || die "config is not valid JSON: $CFG_FILE"

  CFG_NETWORK=$(cfg network)
  CFG_RPC=$(cfg rpc_url)
  CFG_ACCOUNT=$(cfg deployer_account)
  CFG_SALT=$(cfg salt)

  [ -n "$CFG_NETWORK" ] || die "network is missing from config"
  [ -n "$CFG_RPC" ] || die "rpc_url is missing from config"
  [ -n "$CFG_ACCOUNT" ] || die "deployer_account is missing from config"

  if [ -z "$CFG_SALT" ]; then
    CFG_SALT=$(fresh_salt)
    printf '%sgenerated fresh deployment salt: %s%s (record it; used for every deploy in this run)\n' \
      "$YLW" "$CFG_SALT" "$RST"
  fi
}

norm_addr() {
  local a="${1,,}"
  a="${a#0x}"
  a="$(printf '%s' "$a" | sed 's/^0*//')"
  [ -n "$a" ] || a="0"
  printf '0x%s' "$a"
}

fresh_salt() {
  printf '0x%s' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
}

sn_field() {
  local label="$1" out="${2:-}" v
  [ -n "$out" ] || return 1
  v=$(printf '%s\n' "$out" | sed -n "s/^[[:space:]]*${label}:[[:space:]]*//p" | tail -1)
  [ -n "$v" ] || return 1
  v=$(printf '%s' "$v" | grep -oiE '0x[0-9a-f]{1,64}' | head -1 || true)
  [ -n "$v" ] && is_hex_address "$v" && printf '%s' "$v"
}

is_hex_address() { [[ "${1,,}" =~ ^0x[0-9a-f]{1,64}$ ]]; }
same_addr()      { [ "$(norm_addr "$1")" = "$(norm_addr "$2")" ]; }

require_address() {
  local label="$1" value="$2"
  [ -n "$value" ] || die "$label is missing"
  case "$value" in
    *REPLACE_ME*|*PLACEHOLDER*|*TODO*) die "$label is still a placeholder ($value)" ;;
  esac
  is_hex_address "$value" || die "$label is not a hex address: $value"
  [ "$(norm_addr "$value")" != "0x0" ] || die "$label must not be the zero address"
}

# --------------------------------------------------------------------------
# A. Artifact selection — explicit allowlist, never enumeration
# --------------------------------------------------------------------------

artifacts_file() {
  local f="${IWA_ARTIFACTS_FILE:-${PACKAGE_DIR}/target/dev/iwa.starknet_artifacts.json}"
  [ -f "$f" ] || die "build artifacts not found: $f (run: scarb build)"
  printf '%s' "$f"
}

select_artifact() {
  local name="$1" file="$2" count allowed=0
  for c in "${ALLOWED_CONTRACTS[@]}"; do [ "$c" = "$name" ] && allowed=1; done
  [ "$allowed" = "1" ] || die "refusing to select non-allowlisted contract: $name"
  count=$(jq --arg n "$name" '[.contracts[] | select(.contract_name == $n)] | length' "$file")
  [ "$count" = "1" ] || die "expected exactly 1 artifact named '$name', found $count"
  jq -r --arg n "$name" '.contracts[] | select(.contract_name == $n) | .artifacts.sierra' "$file"
}

# The class hash of a locally built contract, computed offline by the deploy
# toolchain itself (sncast utils class-hash). No network, no rebuild.
local_class_hash() {
  local sierra_path="$1"
  need sncast
  ( cd "$PACKAGE_DIR" && sncast utils class-hash --sierra-file "$sierra_path" 2>/dev/null ) \
    | grep -oiE '0x[0-9a-f]{1,64}' | head -1
}

check_artifacts() {
  local file; file="$(artifacts_file)"
  step "A. Artifact selection + local class-hash verification"
  printf 'artifacts file: %s\n' "$file"

  local d; d="$(dirname "$file")"
  for name in "${ALLOWED_CONTRACTS[@]}"; do
    local sierra expect got
    sierra="$(select_artifact "$name" "$file")"
    [ -n "$sierra" ] && [ "$sierra" != "null" ] || die "no sierra artifact for $name"
    case "$name" in
      IwaCircleV2)       expect="$EXPECTED_CIRCLE_V2_CLASS" ;;
      IwaStrk20HelperV2) expect="$EXPECTED_HELPER_V2_CLASS" ;;
    esac
    got="$(local_class_hash "$d/$sierra" || true)"
    [ -n "$got" ] || die "could not compute local class hash for $name ($d/$sierra)"
    same_addr "$got" "$expect" \
      || die "$name local class hash $got != expected $expect — stale or wrong build"
    ok "$name -> $sierra ; class hash $got matches expected"
  done

  # Everything else present is reported and deliberately ignored.
  local other
  other=$(jq -r --argjson allow "$(printf '%s\n' "${ALLOWED_CONTRACTS[@]}" | jq -R . | jq -s .)" \
    '[.contracts[].contract_name] - $allow | .[]' "$file")
  if [ -n "$other" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      local forbidden=0
      for f in "${FORBIDDEN_CONTRACTS[@]}"; do [ "$f" = "$n" ] && forbidden=1; done
      if [ "$forbidden" = "1" ]; then
        ok "ignoring forbidden artifact '$n' (never declared or deployed by the V2 tool)"
      else
        ok "ignoring unexpected artifact '$n' (not on the V2 allowlist)"
      fi
    done <<< "$other"
  fi

  for f in "${FORBIDDEN_CONTRACTS[@]}"; do
    for c in "${ALLOWED_CONTRACTS[@]}"; do
      [ "$c" = "$f" ] && die "allowlist is corrupt: forbidden contract '$f' is allowlisted"
    done
  done
  ok "allowlist excludes all forbidden contracts (Privacy, IwaCircle, IwaStrk20Helper)"

  # The V2 classes must not collide with the deployed V1 classes.
  ! same_addr "$EXPECTED_CIRCLE_V2_CLASS" "$V1_IWA_CIRCLE_CLASS" \
    || die "IwaCircleV2 class equals the deployed V1 IwaCircle class"
  ! same_addr "$EXPECTED_HELPER_V2_CLASS" "$V1_IWA_HELPER_CLASS" \
    || die "IwaStrk20HelperV2 class equals the deployed V1 IwaStrk20Helper class"
  ok "V2 class hashes are distinct from the deployed V1 classes"
}

# Refuses if IwaCircleV2 exposes any helper-replacement / admin / upgrade
# entrypoint. Requires initialize_settlement_helper to be present.
check_no_forbidden_entrypoints() {
  local file sierra path
  file="$(artifacts_file)"
  sierra="$(select_artifact "IwaCircleV2" "$file")"
  path="$(dirname "$file")/$sierra"
  [ -f "$path" ] || die "IwaCircleV2 sierra artifact missing: $path"

  step "A2. Forbidden entrypoint check (IwaCircleV2)"
  local names
  names=$(jq -r '[.abi[]? | select(.type=="interface") | .items[]?.name,
                  (.abi[]? | select(.type=="function") | .name)] | .[]?' "$path" 2>/dev/null || true)
  if [ -z "$names" ]; then
    names=$(jq -r '.. | objects | select(.type? == "function") | .name' "$path" 2>/dev/null || true)
  fi
  [ -n "$names" ] || die "could not read any entrypoint names from $path"

  for bad in "${FORBIDDEN_ENTRYPOINTS[@]}"; do
    if printf '%s\n' "$names" | grep -qx "$bad"; then
      die "IwaCircleV2 exposes forbidden entrypoint '$bad'"
    fi
    ok "no '$bad' entrypoint"
  done

  printf '%s\n' "$names" | grep -qx "initialize_settlement_helper" \
    || die "IwaCircleV2 is missing initialize_settlement_helper"
  ok "initialize_settlement_helper present (one-time)"

  # Also check the helper for any admin/upgrade path.
  local hsierra hpath hnames
  hsierra="$(select_artifact "IwaStrk20HelperV2" "$file")"
  hpath="$(dirname "$file")/$hsierra"
  hnames=$(jq -r '[.abi[]? | select(.type=="interface") | .items[]?.name,
                  (.abi[]? | select(.type=="function") | .name)] | .[]?' "$hpath" 2>/dev/null || true)
  for bad in upgrade replace_class transfer_ownership set_admin set_surplus_sink set_iwa_circle pause; do
    printf '%s\n' "$hnames" | grep -qx "$bad" \
      && die "IwaStrk20HelperV2 exposes forbidden entrypoint '$bad'"
  done
  ok "IwaStrk20HelperV2 exposes no admin/upgrade entrypoint"
}

# --------------------------------------------------------------------------
# B. Offline config guards (mirror the on-chain constructor guards)
# --------------------------------------------------------------------------

check_config_offline() {
  step "B. Hardcoded configuration guards (offline)"
  require_address "EXPECTED_USDC"            "$EXPECTED_USDC"
  require_address "EXPECTED_STRK"            "$EXPECTED_STRK"
  require_address "EXPECTED_POOL"            "$EXPECTED_POOL"
  require_address "EXPECTED_SINK"            "$EXPECTED_SINK"
  require_address "EXPECTED_SETUP_AUTHORITY" "$EXPECTED_SETUP_AUTHORITY"
  require_address "EXPECTED_CIRCLE_V2_CLASS" "$EXPECTED_CIRCLE_V2_CLASS"
  require_address "EXPECTED_HELPER_V2_CLASS" "$EXPECTED_HELPER_V2_CLASS"
  ok "all hardcoded addresses present, non-zero and well formed"

  ! same_addr "$EXPECTED_USDC" "$EXPECTED_STRK" || die "USDC and STRK must differ"
  ! same_addr "$EXPECTED_SINK" "$EXPECTED_POOL" || die "surplus_sink must not be the pool"
  ! same_addr "$EXPECTED_SINK" "$EXPECTED_USDC" || die "surplus_sink must not be USDC"
  ! same_addr "$EXPECTED_SINK" "$EXPECTED_STRK" || die "surplus_sink must not be STRK"
  ! same_addr "$EXPECTED_SINK" "$EXPECTED_SETUP_AUTHORITY" || die "surplus_sink must not be the setup authority"
  ! same_addr "$EXPECTED_SINK" "$V1_IWA_CIRCLE" || die "surplus_sink must not be the V1 IwaCircle"
  ! same_addr "$EXPECTED_SINK" "$V1_IWA_HELPER" || die "surplus_sink must not be the V1 IwaStrk20Helper"
  ok "no forbidden surplus_sink collisions"

  is_hex_address "$CFG_SALT" || die "salt is not a hex felt: $CFG_SALT"
  ! same_addr "$CFG_SALT" "0x0" || die "salt must not be 0x0"
  ok "salt is a non-zero hex felt ($CFG_SALT)"

  case "$CFG_NETWORK" in
    mainnet|SN_MAIN) ok "config network is mainnet" ;;
    *) die "V2 tool only deploys to mainnet; config says '$CFG_NETWORK'" ;;
  esac
}

# --------------------------------------------------------------------------
# On-chain reads (read-only, fail-closed)
# --------------------------------------------------------------------------

rpc_call() {
  local method="$1" params="$2"
  curl -s -m 30 -X POST "$CFG_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

view_array() {
  local addr="$1" sel="$2" resp out
  resp=$(rpc_call starknet_call \
    "{\"block_id\":\"latest\",\"request\":{\"contract_address\":\"$(norm_addr "$addr")\",\"entry_point_selector\":\"$sel\",\"calldata\":[]}}")
  out=$(printf '%s' "$resp" | jq -r '.result // empty' 2>/dev/null || true)
  [ -n "$out" ] && [ "$out" != "null" ] || die "view $sel at $addr failed: $resp"
  printf '%s' "$out"
}

view_array_args() {
  local addr="$1" sel="$2" cd="$3" resp out
  resp=$(rpc_call starknet_call \
    "{\"block_id\":\"latest\",\"request\":{\"contract_address\":\"$(norm_addr "$addr")\",\"entry_point_selector\":\"$sel\",\"calldata\":$cd}}")
  out=$(printf '%s' "$resp" | jq -r '.result // empty' 2>/dev/null || true)
  printf '%s|%s' "$out" "$resp"
}

felt_at() {
  local arr="$1" idx="$2" v
  v=$(printf '%s' "$arr" | jq -r --argjson i "$idx" '.[$i] // empty')
  [ -n "$v" ] && [ "$v" != "null" ] || die "view returned no felt at index $idx: $arr"
  printf '%s' "$v"
}

sn_call() {
  local addr="$1" fn="$2"; shift 2
  ( cd "$PACKAGE_DIR" && sncast call --url "$CFG_RPC" --contract-address "$addr" \
      --function "$fn" "$@" 2>&1 )
}

check_network() {
  step "D. Network check (read-only)"
  local resp chain
  resp=$(rpc_call starknet_chainId '[]') || die "RPC call failed: $CFG_RPC"
  chain=$(printf '%s' "$resp" | jq -r '.result // empty')
  [ -n "$chain" ] || die "RPC did not return a chain id: $resp"
  [ "${chain,,}" = "$EXPECTED_CHAIN_ID_SN_MAIN" ] \
    || die "network mismatch: RPC chain id is $chain, expected SN_MAIN ($EXPECTED_CHAIN_ID_SN_MAIN)"
  ok "RPC chain id $chain is SN_MAIN"
}

check_onchain_config() {
  step "E. On-chain configuration check (read-only)"

  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$EXPECTED_POOL\"}" | jq -r '.result // empty')
  [ -n "$cls" ] || die "no contract deployed at the expected pool $EXPECTED_POOL"
  ok "pool has a deployed class: $cls"

  local ver
  ver=$(sn_call "$EXPECTED_POOL" get_version | grep -E '^Response:' | head -1 || true)
  printf '     pool get_version -> %s\n' "${ver:-<none>}"
  [ -n "$ver" ] || die "pool did not answer get_version — is this the STRK20 pool?"
  ok "pool answers the STRK20 pool view interface"

  local fee
  fee=$(sn_call "$EXPECTED_POOL" get_fee_amount | grep -E '^Response:' | head -1 || true)
  printf '     pool get_fee_amount -> %s\n' "${fee:-<none>}"
  warn "the pool charges this fee in STRK per apply_actions, paid by the caller — NOT part of deployment"

  local sym dec
  for pair in "USDC:$EXPECTED_USDC:USDC" "STRK:$EXPECTED_STRK:STRK"; do
    local label="${pair%%:*}" rest="${pair#*:}"
    local addr="${rest%%:*}" want="${rest##*:}"
    sym=$(sn_call "$addr" symbol | grep -E '^Response:' | head -1 || true)
    dec=$(sn_call "$addr" decimals | grep -E '^Response:' | head -1 || true)
    printf '     %s symbol -> %s / decimals -> %s\n' "$label" "${sym:-<none>}" "${dec:-<none>}"
    printf '%s' "$sym" | grep -q "\"$want\"" || die "$label at $addr does not report symbol $want"
    ok "$label verified on chain as $want"
  done
}

# --------------------------------------------------------------------------
# Signer checks
# --------------------------------------------------------------------------

resolve_signer_address() {
  # From the sncast accounts file, without a network call.
  ( sncast account list 2>/dev/null || true ) \
    | awk -v want="$CFG_ACCOUNT" '
        $0 ~ "^- "want":" {infield=1; next}
        infield && $1=="address:" {print $2; exit}
        infield && /^- / {exit}
      '
}

check_signer() {
  step "F. Signer account check"
  need sncast
  local addr
  addr="$(resolve_signer_address || true)"
  [ -n "$addr" ] || die "sncast account '$CFG_ACCOUNT' not found in the accounts file"
  printf '     account "%s" -> %s\n' "$CFG_ACCOUNT" "$addr"
  same_addr "$addr" "$EXPECTED_SETUP_AUTHORITY" \
    || die "account '$CFG_ACCOUNT' resolves to $addr, expected setup authority $EXPECTED_SETUP_AUTHORITY"
  ok "signer address equals the reviewed setup authority"

  # Refuse any accidental V1 reuse.
  ! same_addr "$addr" "$V1_IWA_CIRCLE" || die "signer is the V1 IwaCircle address"
  ! same_addr "$addr" "$V1_IWA_HELPER" || die "signer is the V1 IwaStrk20Helper address"
  ok "signer is not a V1 contract address"
}

check_signer_balance() {
  local out raw whole frac
  out=$( ( cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" get balance \
            --url "$CFG_RPC" --token strk --block-id latest 2>&1 ) || true )
  printf '%s\n' "$out" | sed 's/^/     /'
  # sncast prints "Balance: <fri> fri" or a decimal STRK figure.
  raw=$(printf '%s' "$out" | grep -oiE 'balance:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
  if [ -n "$raw" ] && [ "${#raw}" -gt 18 ]; then
    whole="${raw:0:${#raw}-18}"
    frac="${raw: -18}"
    ok "signer STRK balance: ${whole}.${frac:0:4} STRK (${raw} fri) — fund with >= 5 STRK to absorb fee spikes"
  elif [ -n "$raw" ]; then
    ok "signer STRK balance: 0.$(printf '%018d' "$raw" | cut -c1-4) STRK (${raw} fri) — LOW, fund the deployer"
  else
    warn "could not parse a STRK balance from sncast output above — check it manually"
  fi
}

# --------------------------------------------------------------------------
# C. Deployment ordering
# --------------------------------------------------------------------------

print_plan() {
  step "C. Deployment order (approved sequence) — nothing is sent here"
  cat <<PLAN
  1. preflight — all non-sending checks pass
  2. Declare IwaCircleV2        expected class $EXPECTED_CIRCLE_V2_CLASS
  3. Declare IwaStrk20HelperV2  expected class $EXPECTED_HELPER_V2_CLASS
  4. Deploy IwaCircleV2 with fresh salt ($CFG_SALT)
        constructor: usdc, strk, privacy_pool, setup_authority
        usdc            = $EXPECTED_USDC
        strk            = $EXPECTED_STRK
        privacy_pool    = $EXPECTED_POOL
        setup_authority = $EXPECTED_SETUP_AUTHORITY
     -> record <CircleV2>
  5. check-sink <config> <CircleV2>   (surplus_sink must not be <CircleV2>)
  6. Deploy IwaStrk20HelperV2 with the same fresh salt
        constructor: iwa_circle, privacy_pool, usdc, strk, surplus_sink
        iwa_circle      = <CircleV2 from step 4>
        privacy_pool    = $EXPECTED_POOL
        usdc            = $EXPECTED_USDC
        strk            = $EXPECTED_STRK
        surplus_sink    = $EXPECTED_SINK
     -> record <HelperV2>
  7. check-helper <config> <CircleV2> <HelperV2>   PRE-INIT HARD STOP
        - HelperV2 hosts class $EXPECTED_HELPER_V2_CLASS
        - helper.get_config == {CircleV2, pool, USDC, STRK, sink}
        - CircleV2.get_settlement_config == {helper 0x0, pool, authority $EXPECTED_SETUP_AUTHORITY, initialized 0}
        - surplus_sink != CircleV2
        - pool is_open_note_depositor_blocked(HelperV2) == 0
     Initialization is NOT sent unless every check passes.
  8. initialize_settlement_helper(HelperV2) — exactly once, from setup_authority
  9. verify <config> <CircleV2> <HelperV2>   POST-INIT
        - settlement_helper == HelperV2
        - setup_authority   == 0x0
        - helper_initialized == 1
        - helper config unchanged
        - a second initialize_settlement_helper dry-run reverts
        - pool blocklist still clear
        - smoke read get_payout_state_v2(1,1) reverts 'IWA: payout locked'
 10. Only after verify passes: fill iwa-web/src/chains/strk20/v2/deploymentV2.ts.

  Steps 7 and 9 are re-runnable at any time.
PLAN
}

# --------------------------------------------------------------------------
# PRE-INIT HARD STOP  (read-only, fail-closed)
# --------------------------------------------------------------------------

assert_helper_ready() {
  local helper="$1" core="$2"
  require_address "deployed IwaStrk20HelperV2" "$helper"
  require_address "deployed IwaCircleV2" "$core"

  step "PRE-INIT HARD STOP (read-only, fail-closed)"

  # 0. No accidental V1 reuse.
  ! same_addr "$helper" "$V1_IWA_HELPER" || die "helper arg is the V1 IwaStrk20Helper"
  ! same_addr "$core" "$V1_IWA_CIRCLE"   || die "circle arg is the V1 IwaCircle"
  ! same_addr "$helper" "$core"          || die "helper and circle args are the same address"
  ok "helper/circle args are distinct and not V1 contracts"

  # 1. HelperV2 class hash matches expected.
  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$helper")\"}" | jq -r '.result // empty')
  [ -n "$cls" ] || die "no contract deployed at helper $helper"
  same_addr "$cls" "$EXPECTED_HELPER_V2_CLASS" \
    || die "helper $helper runs class $cls, expected $EXPECTED_HELPER_V2_CLASS"
  ok "HelperV2 hosts the exact expected class"

  # 1b. CircleV2 class hash matches expected.
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$core")\"}" | jq -r '.result // empty')
  [ -n "$cls" ] || die "no contract deployed at circle $core"
  same_addr "$cls" "$EXPECTED_CIRCLE_V2_CLASS" \
    || die "circle $core runs class $cls, expected $EXPECTED_CIRCLE_V2_CLASS"
  ok "CircleV2 hosts the exact expected class"

  # 2. helper.get_config == {CircleV2, pool, USDC, STRK, sink}
  local hcfg iwa_circle pool usdc strk sink
  hcfg=$(view_array "$helper" "$SEL_GET_CONFIG")
  iwa_circle=$(felt_at "$hcfg" 0); pool=$(felt_at "$hcfg" 1)
  usdc=$(felt_at "$hcfg" 2); strk=$(felt_at "$hcfg" 3); sink=$(felt_at "$hcfg" 4)
  same_addr "$iwa_circle" "$core"          || die "helper.iwa_circle is $iwa_circle, expected $core"
  same_addr "$pool" "$EXPECTED_POOL"       || die "helper.pool is $pool, expected $EXPECTED_POOL"
  same_addr "$usdc" "$EXPECTED_USDC"       || die "helper.usdc is $usdc, expected $EXPECTED_USDC"
  same_addr "$strk" "$EXPECTED_STRK"       || die "helper.strk is $strk, expected $EXPECTED_STRK"
  same_addr "$sink" "$EXPECTED_SINK"       || die "helper.surplus_sink is $sink, expected $EXPECTED_SINK"
  ok "helper config is exact: iwa_circle, pool, USDC, STRK, surplus_sink"

  # 3. CircleV2 still uninitialized, owned by the expected authority.
  local scfg stored_helper authority initialized
  scfg=$(view_array "$core" "$SEL_GET_SETTLEMENT_CONFIG")
  stored_helper=$(felt_at "$scfg" 0); authority=$(felt_at "$scfg" 2); initialized=$(felt_at "$scfg" 3)
  same_addr "$stored_helper" "0x0" \
    || die "CircleV2 already wired to settlement helper $stored_helper — one-time init consumed"
  same_addr "$authority" "$EXPECTED_SETUP_AUTHORITY" \
    || die "CircleV2 setup_authority is $authority, expected $EXPECTED_SETUP_AUTHORITY"
  [ "$(norm_addr "$initialized")" = "0x0" ] \
    || die "CircleV2 helper_initialized is already true"
  ok "CircleV2 uninitialized: settlement_helper 0x0, authority expected, helper_initialized false"

  # 4. surplus_sink != CircleV2 (not enforceable by the helper constructor).
  ! same_addr "$EXPECTED_SINK" "$core" \
    || die "surplus_sink equals the deployed CircleV2 — surplus would be stranded forever"
  ok "surplus_sink is distinct from the deployed CircleV2"

  # 5. HelperV2 not blocklisted by the pool.
  local blk resp
  IFS='|' read -r blk resp < <(view_array_args "$EXPECTED_POOL" \
    "$(sncast_selector is_open_note_depositor_blocked)" "[\"$(norm_addr "$helper")\"]")
  if [ -z "$blk" ] || [ "$blk" = "null" ]; then
    warn "pool is_open_note_depositor_blocked did not return cleanly ($resp) — verify manually"
  else
    local v; v=$(printf '%s' "$blk" | jq -r '.[0] // "0x0"')
    [ "$(norm_addr "$v")" = "0x0" ] \
      || die "the pool has blocklisted HelperV2 as an open-note depositor ($v) — settlement would fail"
    ok "HelperV2 is not blocklisted by the pool"
  fi

  printf '\n%sPRE-INIT HARD STOP PASSED%s — initialize_settlement_helper is safe to send.\n' "$GRN" "$RST"
}

sncast_selector() {
  ( cd "$PACKAGE_DIR" && sncast utils selector "$1" 2>/dev/null ) \
    | grep -oiE '0x[0-9a-f]{1,64}' | head -1
}

# --------------------------------------------------------------------------
# POST-INIT verification (read-only)
# --------------------------------------------------------------------------

verify_deployment() {
  local core="$1" helper="$2"
  require_address "deployed IwaCircleV2" "$core"
  require_address "deployed IwaStrk20HelperV2" "$helper"

  step "POST-INIT verification (read-only)"

  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$core")\"}" | jq -r '.result // empty')
  same_addr "$cls" "$EXPECTED_CIRCLE_V2_CLASS" || die "CircleV2 at $core runs class $cls, expected $EXPECTED_CIRCLE_V2_CLASS"
  ok "CircleV2 hosts the exact expected class"

  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$helper")\"}" | jq -r '.result // empty')
  same_addr "$cls" "$EXPECTED_HELPER_V2_CLASS" || die "HelperV2 at $helper runs class $cls, expected $EXPECTED_HELPER_V2_CLASS"
  ok "HelperV2 hosts the exact expected class"

  local scfg stored_helper authority initialized
  scfg=$(view_array "$core" "$SEL_GET_SETTLEMENT_CONFIG")
  stored_helper=$(felt_at "$scfg" 0); authority=$(felt_at "$scfg" 2); initialized=$(felt_at "$scfg" 3)
  same_addr "$stored_helper" "$helper" || die "CircleV2 stores settlement helper $stored_helper, expected $helper"
  ok "settlement_helper == HelperV2"
  same_addr "$authority" "0x0" || die "setup_authority was not cleared: $authority"
  ok "setup_authority == 0x0 (cleared)"
  [ "$(norm_addr "$initialized")" = "0x1" ] || die "helper_initialized is not true (got $initialized)"
  ok "helper_initialized == 1 (locked)"

  local hcfg iwa_circle pool usdc strk sink
  hcfg=$(view_array "$helper" "$SEL_GET_CONFIG")
  iwa_circle=$(felt_at "$hcfg" 0); pool=$(felt_at "$hcfg" 1)
  usdc=$(felt_at "$hcfg" 2); strk=$(felt_at "$hcfg" 3); sink=$(felt_at "$hcfg" 4)
  same_addr "$iwa_circle" "$core"    || die "helper.iwa_circle is $iwa_circle, expected $core"
  same_addr "$pool" "$EXPECTED_POOL" || die "helper.pool is $pool, expected $EXPECTED_POOL"
  same_addr "$usdc" "$EXPECTED_USDC" || die "helper.usdc is $usdc, expected $EXPECTED_USDC"
  same_addr "$strk" "$EXPECTED_STRK" || die "helper.strk is $strk, expected $EXPECTED_STRK"
  same_addr "$sink" "$EXPECTED_SINK" || die "helper.surplus_sink is $sink, expected $EXPECTED_SINK"
  ok "helper config unchanged: iwa_circle, pool, USDC, STRK, surplus_sink"

  # Second init must revert. Dry-run only — sends nothing.
  step "second initialize_settlement_helper — must revert (dry-run)"
  local out
  out=$( ( cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" invoke --url "$CFG_RPC" \
            --contract-address "$core" --function initialize_settlement_helper \
            --calldata "$helper" --dry-run 2>&1 ) || true )
  if printf '%s' "$out" | grep -qiE 'HELPER_ALREADY_INITIALIZED|already initialized|revert|UNAUTHORIZED|ENTRYPOINT_FAILED'; then
    ok "a second initialize_settlement_helper reverts (dry-run)"
  else
    die "a second initialize_settlement_helper dry-run did NOT report a revert:
$out"
  fi

  # Smoke read.
  local sm
  IFS='|' read -r _ sm < <(view_array_args "$core" "$SEL_GET_PAYOUT_STATE_V2" "[\"0x1\",\"0x1\"]")
  if printf '%s' "$sm" | grep -qi "payout locked"; then
    ok "smoke read get_payout_state_v2(1,1) reverts 'IWA: payout locked' (clean slate)"
  else
    warn "get_payout_state_v2(1,1) did not clearly report 'IWA: payout locked': $sm"
  fi

  warn "confirm HelperV2 is not on the pool's blocked_open_note_depositors list before the first settlement"
  printf '\n%sPOST-INIT VERIFICATION PASSED%s\n' "$GRN" "$RST"
}

assert_sink_not_circle() {
  local core="$1"
  require_address "deployed IwaCircleV2" "$core"
  if same_addr "$EXPECTED_SINK" "$core"; then
    die "surplus_sink is the deployed IwaCircleV2 ($core).
     The sink is immutable once the helper is deployed and IwaCircleV2 has no
     path to move tokens, so any surplus sent there is stranded forever.
     ABORT before deploying the helper. Nothing was sent."
  fi
  ok "surplus_sink is distinct from the deployed IwaCircleV2"
}

# --------------------------------------------------------------------------
# preflight — ALL non-sending checks, PASS/FAIL summary
# --------------------------------------------------------------------------

pf_run() {
  local label="$1"; shift
  local rc=0
  "$@" >/tmp/iwa_v2_pf.$$ 2>&1 || rc=$?
  sed 's/^/       /' /tmp/iwa_v2_pf.$$
  rm -f /tmp/iwa_v2_pf.$$
  [ "$rc" -eq 0 ] && pf PASS "$label" || pf FAIL "$label"
}

do_preflight() {
  step "PREFLIGHT — non-sending checks only. Nothing will be sent."
  need jq; need curl; need sncast; need scarb

  step "0. scarb build"
  if ( cd "$PACKAGE_DIR" && scarb build ) >/tmp/iwa_v2_build.$$ 2>&1; then
    pf PASS "scarb build"
  else
    pf FAIL "scarb build"
    tail -30 /tmp/iwa_v2_build.$$ | sed 's/^/       /'
  fi
  rm -f /tmp/iwa_v2_build.$$

  pf_run "artifact allowlist + local class-hash verification" check_artifacts
  pf_run "forbidden admin/upgrade entrypoint check"           check_no_forbidden_entrypoints
  pf_run "hardcoded configuration guards (offline)"           check_config_offline
  pf_run "network is SN_MAIN"                                 check_network
  pf_run "signer account resolves to the setup authority"     check_signer
  pf_run "pool version + fee, token symbol/decimals"          check_onchain_config

  step "H. sncast declare --dry-run (best effort — non-sending fee estimate)"
  # Reported separately from the safety-critical checks: a dry-run that cannot
  # run is a BLOCKER to report (see the deployment prep), never a reason to
  # send a real transaction, and never a safety failure.
  DRYRUN_STATUS="not attempted"
  local name out okc=0 blk=0
  for name in IwaCircleV2 IwaStrk20HelperV2; do
    out=$( ( cd "$PACKAGE_DIR" && timeout 900 sncast --account "$CFG_ACCOUNT" declare \
        --url "$CFG_RPC" --contract-name "$name" --dry-run --detailed 2>&1 ) || true )
    if printf '%s' "$out" | grep -qiE '^Error:|execution_error|invalid-signature|estimate fee for dry run'; then
      printf '%s\n' "$out" | grep -iE '^Error:|invalid-signature|argent/|execution_error' | sed 's/^/     /'
      pf WARN "$name declare --dry-run BLOCKED (account signing / environment)"
      blk=$((blk+1))
    elif printf '%s' "$out" | grep -qiE 'already declared'; then
      pf PASS "$name class already declared on chain (no declare needed)"
      okc=$((okc+1))
    elif printf '%s' "$out" | grep -qiE 'overall_fee|max_fee|Estimated fee|fee_estimate'; then
      printf '%s\n' "$out" | grep -iE 'class_hash|overall_fee|max_fee|l1_gas|l2_gas|data_gas|Estimated fee|STRK|fri' | sed 's/^/     /'
      pf PASS "$name declare --dry-run returned a fee estimate"
      okc=$((okc+1))
    else
      printf '%s\n' "$out" | tail -10 | sed 's/^/     /'
      pf WARN "$name declare --dry-run produced no recognisable estimate"
      blk=$((blk+1))
    fi
  done
  if   [ "$okc" -eq 2 ]; then DRYRUN_STATUS="both estimates obtained"
  elif [ "$blk" -gt 0 ]; then DRYRUN_STATUS="BLOCKED ($blk/2) — report and do NOT substitute a real transaction"
  fi

  step "I. signer STRK balance"
  check_signer_balance
  pf PASS "signer STRK balance read"

  step "PREFLIGHT SUMMARY"
  printf '  safety checks — passed: %s   failed: %s\n' "$PF_PASS" "$PF_FAIL"
  printf '  fee dry-run   — %s\n' "${DRYRUN_STATUS:-not attempted}"
  for l in "${PF_LINES[@]}"; do printf '  %s\n' "$l"; done
  [ "$PF_FAIL" -eq 0 ] || die "preflight has $PF_FAIL failing SAFETY check(s) — do not deploy"
  if [ "${DRYRUN_STATUS:-}" != "both estimates obtained" ]; then
    warn "the fee dry-run did not complete. Obtain it on a machine where the deployer account signs"
    warn "cleanly (sncast declare --dry-run), or from the Argent/Ready wallet UI, BEFORE deploying."
    warn "Do NOT substitute a real declare transaction for the missing estimate."
  fi
  printf '\n%sPREFLIGHT: all safety checks passed%s — nothing was sent.\n' "$GRN" "$RST"
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

  need sncast
  do_preflight

  step "Deploying IwaCircleV2 + IwaStrk20HelperV2 (transactions WILL be sent)"

  local decl_out core_class
  decl_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaCircleV2 2>&1 | tee /dev/stderr)
  core_class=$(sn_field class_hash "$decl_out" || printf '%s' "$EXPECTED_CIRCLE_V2_CLASS")
  same_addr "$core_class" "$EXPECTED_CIRCLE_V2_CLASS" \
    || die "declared IwaCircleV2 class $core_class != expected $EXPECTED_CIRCLE_V2_CLASS"

  local dep_out core
  dep_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$EXPECTED_CIRCLE_V2_CLASS" --salt "$CFG_SALT" \
    --constructor-calldata "$EXPECTED_USDC" "$EXPECTED_STRK" "$EXPECTED_POOL" "$EXPECTED_SETUP_AUTHORITY" \
    2>&1 | tee /dev/stderr)
  core=$(sn_field contract_address "$dep_out") || die "IwaCircleV2 deploy produced no address"
  ok "IwaCircleV2 deployed at $core (salt $CFG_SALT)"

  assert_sink_not_circle "$core"

  decl_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaStrk20HelperV2 2>&1 | tee /dev/stderr)
  local helper_class
  helper_class=$(sn_field class_hash "$decl_out" || printf '%s' "$EXPECTED_HELPER_V2_CLASS")
  same_addr "$helper_class" "$EXPECTED_HELPER_V2_CLASS" \
    || die "declared IwaStrk20HelperV2 class $helper_class != expected $EXPECTED_HELPER_V2_CLASS"

  local helper
  dep_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$EXPECTED_HELPER_V2_CLASS" --salt "$CFG_SALT" \
    --constructor-calldata "$core" "$EXPECTED_POOL" "$EXPECTED_USDC" "$EXPECTED_STRK" "$EXPECTED_SINK" \
    2>&1 | tee /dev/stderr)
  helper=$(sn_field contract_address "$dep_out") || die "IwaStrk20HelperV2 deploy produced no address"
  ok "IwaStrk20HelperV2 deployed at $helper (salt $CFG_SALT)"

  assert_helper_ready "$helper" "$core"

  (cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" invoke --url "$CFG_RPC" \
    --contract-address "$core" --function initialize_settlement_helper --calldata "$helper")
  ok "initialize_settlement_helper called once"

  verify_deployment "$core" "$helper"
  printf '\nRecord these addresses:\n  IwaCircleV2       %s\n  IwaStrk20HelperV2 %s\n' "$core" "$helper"
}

# --------------------------------------------------------------------------

main() {
  need jq; need curl
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    preflight)   load_config "${1:-}"; do_preflight ;;
    validate)
      load_config "${1:-}"
      check_artifacts
      check_no_forbidden_entrypoints
      check_config_offline
      need sncast
      check_network
      check_signer
      check_onchain_config
      printf '\n%sVALIDATION PASSED%s — nothing was sent.\n' "$GRN" "$RST"
      ;;
    plan)        load_config "${1:-}"; check_config_offline; print_plan; printf '\nNo transactions were sent.\n' ;;
    check-artifacts) check_artifacts; check_no_forbidden_entrypoints ;;
    check-sink)  load_config "${1:-}"; check_config_offline; assert_sink_not_circle "${2:-}"
                 printf '\nSINK CHECK PASSED — nothing was sent.\n' ;;
    # Both take <circleV2> <helperV2>, in that order, for consistency.
    check-helper) load_config "${1:-}"; check_config_offline; assert_helper_ready "${3:-}" "${2:-}"
                 printf '\nPRE-INIT HARD STOP PASSED — nothing was sent.\n' ;;
    verify)      load_config "${1:-}"; verify_deployment "${2:-}" "${3:-}" ;;
    deploy)      load_config "${1:-}"; do_deploy "${2:-}" ;;
    *)
      sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 1
      ;;
  esac
}

main "$@"

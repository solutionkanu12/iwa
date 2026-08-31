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
#   check-helper <config.json> <helper> <core> <helper-class>
#                                       read-only fail-closed pre-initialization
#                                       gate; must pass before the one-time init
#   verify   <config.json> <core> <helper> <core-class> <helper-class>
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

# Entry-point selectors of the pinned IwaCircle / IwaStrk20Helper classes,
# derived with starknet_keccak of the entry-point name. Stable because every
# gate that uses them first pins the class hash it is talking to.
readonly SEL_GET_SETTLEMENT_CONFIG="0x00dff80fd5377ea4fb11e78ea05ff6b4758553ff4352383b73215096c3ee54e0"
readonly SEL_GET_CONFIG="0x01847d98d2c5c239f7b89e5ccb00b2b0aa9d78cf297e3334b68e1707ed49d3b2"

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
CFG_SINK=""; CFG_SETUP_AUTHORITY=""; CFG_ACCOUNT=""; CFG_SALT=""

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
  CFG_SALT=$(cfg salt)

  # A recovery must never reuse the salt-0 addresses of an abandoned
  # deployment. If the config does not pin a salt, generate a fresh one here,
  # print it, and pass it deliberately to every deploy. Nothing is sent.
  if [ -z "$CFG_SALT" ]; then
    CFG_SALT=$(fresh_salt)
    printf '%sgenerated fresh deployment salt: %s%s (record it; it is used for every deploy in this run)\n' \
      "$YLW" "$CFG_SALT" "$RST"
  fi
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

# A fresh 128-bit random deployment salt, printed and passed deliberately so a
# recovery can never silently reuse the salt-0 addresses already occupied by an
# abandoned deployment. UDC address calculation is deterministic: same
# deployer + class + calldata + salt => same address, so a reused salt would
# collide and revert at deploy time (or worse, if inputs changed, silently
# occupy a predictable address).
fresh_salt() {
  printf '0x%s' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
}

# Extracts exactly one labeled hex field from sncast output, e.g. the
# `class_hash:` line of `sncast declare` or the `contract_address:` line of
# `sncast deploy`. Fails closed (non-zero) when the field line is absent or
# does not carry a well-formed hex token, so a changed sncast output format
# aborts the deployment instead of silently feeding a wrong value forward.
sn_field() {
  local label="$1" out="${2:-}" v
  [ -n "$out" ] || return 1
  v=$(printf '%s\n' "$out" | sed -n "s/^[[:space:]]*${label}:[[:space:]]*//p" | tail -1)
  [ -n "$v" ] || return 1
  v=$(printf '%s' "$v" | grep -oE '0x[0-9a-fA-F]{1,64}' | head -1 || true)
  [ -n "$v" ] && is_hex_address "$v" && printf '%s' "$v"
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

  # Salt policy: an explicit salt must be a non-zero hex felt. Salt 0x0 was
  # used by the abandoned deployment and, with identical constructor inputs,
  # would recompute the same occupied addresses. A fresh explicit salt is
  # required for recovery; when the config omits `salt`, load_config already
  # generated and printed one.
  if [ -n "$CFG_SALT" ]; then
    is_hex_address "$CFG_SALT" || die "salt is not a hex felt: $CFG_SALT"
    ! same_addr "$CFG_SALT" "0x0" \
      || die "salt must not be 0x0: the abandoned deployment already occupies the salt-0 addresses"
    ok "salt is explicit and non-zero ($CFG_SALT)"
  else
    ok "no salt in config — a fresh random salt is generated and printed at load time"
  fi
}

rpc_call() {
  local method="$1" params="$2"
  curl -s -m 30 -X POST "$CFG_RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

# Reads a view as a JSON felt array; fails closed on any RPC error so a broken
# or absent contract can never be mistaken for a healthy one.
view_array() {
  local addr="$1" sel="$2"
  local resp out
  resp=$(rpc_call starknet_call \
    "{\"block_id\":\"latest\",\"request\":{\"contract_address\":\"$(norm_addr "$addr")\",\"entry_point_selector\":\"$sel\",\"calldata\":[]}}")
  out=$(printf '%s' "$resp" | jq -r '.result // empty' 2>/dev/null || true)
  [ -n "$out" ] && [ "$out" != "null" ] \
    || die "view $sel at $addr failed: $resp"
  printf '%s' "$out"
}

# Extracts one felt at the given index from a view JSON array; fails closed
# when the array is shorter than expected.
felt_at() {
  local arr="$1" idx="$2" v
  v=$(printf '%s' "$arr" | jq -r --argjson i "$idx" '.[$i] // empty')
  [ -n "$v" ] && [ "$v" != "null" ] \
    || die "view returned no felt at index $idx: $arr"
  printf '%s' "$v"
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
  2. Deploy IwaCircle with a fresh salt ($CFG_SALT)
        constructor: usdc_token, strk_token, privacy_pool, setup_authority
        usdc_token      = $CFG_USDC
        strk_token      = $CFG_STRK
        privacy_pool    = $CFG_POOL
        setup_authority = $CFG_SETUP_AUTHORITY
  3. Deploy IwaStrk20Helper with a fresh salt
        constructor: iwa_circle, privacy_pool, usdc_token, strk_token, surplus_sink
        iwa_circle      = <IwaCircle address from step 2>
        privacy_pool    = $CFG_POOL
        usdc_token      = $CFG_USDC
        strk_token      = $CFG_STRK
        surplus_sink    = $CFG_SINK
  4. assert_helper_ready(helper, core) — fail-closed read-only gate:
        helper hosts the IwaStrk20Helper class
        helper.get_config() matches core, pool, USDC, STRK, sink exactly
        core is uninitialized: settlement_helper 0, authority intact,
        helper_initialized false
     Initialization is NOT sent unless every check passes.
  5. initialize_settlement_helper(helper) — exactly once, from setup_authority
  6. Verify stored helper equals the deployed helper
  7. Verify setup authority is cleared to zero
  8. Verify no replacement setter exists                     [validate]
  9. Verify helper config matches every expected address     [verify]

  Steps 6-9 are re-run by: $0 verify <config.json> <core> <helper> <core-class> <helper-class>
PLAN
}

# --------------------------------------------------------------------------
# Post-deployment verification
# --------------------------------------------------------------------------

resp_value() { grep -E '^Response:' | head -1 | sed 's/^Response: *//'; }

# Fail-closed read-only gate that must pass immediately before the one-time
# initialize_settlement_helper is sent. It re-derives every fact from the chain
# and compares with normalized exact equality — it never trusts a value the
# operator typed, an sncast parse, or a stored string. Any mismatch aborts
# before a transaction is sent.
assert_helper_ready() {
  local helper="$1" core="$2" helper_class="$3"
  require_address "deployed IwaStrk20Helper" "$helper"
  require_address "deployed IwaCircle" "$core"
  require_address "expected IwaStrk20Helper class hash" "$helper_class"

  step "Pre-initialization helper gate (read-only, fail-closed)"

  # 1. The helper address must host the exact helper class.
  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$helper")\"}" | jq -r '.result // empty')
  [ -n "$cls" ] \
    || die "no contract deployed at helper $helper — refusing to initialize a dead address"
  same_addr "$cls" "$helper_class" \
    || die "helper $helper runs class $cls, expected $helper_class — refusing to initialize"
  ok "helper hosts the exact IwaStrk20Helper class ($helper_class)"

  # 2. The helper's immutable config must be exact.
  local hcfg iwa_circle pool usdc strk sink
  hcfg=$(view_array "$helper" "$SEL_GET_CONFIG")
  iwa_circle=$(felt_at "$hcfg" 0)
  pool=$(felt_at "$hcfg" 1)
  usdc=$(felt_at "$hcfg" 2)
  strk=$(felt_at "$hcfg" 3)
  sink=$(felt_at "$hcfg" 4)
  same_addr "$iwa_circle" "$core" \
    || die "helper iwa_circle is $iwa_circle, expected deployed circle $core — refusing to initialize"
  same_addr "$pool" "$CFG_POOL" \
    || die "helper privacy_pool is $pool, expected $CFG_POOL — refusing to initialize"
  same_addr "$usdc" "$CFG_USDC" \
    || die "helper usdc_token is $usdc, expected $CFG_USDC — refusing to initialize"
  same_addr "$strk" "$CFG_STRK" \
    || die "helper strk_token is $strk, expected $CFG_STRK — refusing to initialize"
  same_addr "$sink" "$CFG_SINK" \
    || die "helper surplus_sink is $sink, expected $CFG_SINK — refusing to initialize"
  ok "helper config is exact: iwa_circle, privacy_pool, USDC, STRK, surplus_sink"

  # 3. The circle must still be uninitialized and owned by the right authority.
  local scfg stored_helper authority initialized
  scfg=$(view_array "$core" "$SEL_GET_SETTLEMENT_CONFIG")
  stored_helper=$(felt_at "$scfg" 0)
  authority=$(felt_at "$scfg" 2)
  initialized=$(felt_at "$scfg" 3)
  same_addr "$stored_helper" "0x0" \
    || die "core is already wired to settlement helper $stored_helper — one-time initialization consumed"
  same_addr "$authority" "$CFG_SETUP_AUTHORITY" \
    || die "core setup_authority is $authority, expected $CFG_SETUP_AUTHORITY — refusing to initialize"
  [ "$(norm_addr "$initialized")" = "0x0" ] \
    || die "core helper_initialized is already true — refusing re-initialization"
  ok "core is uninitialized and ready: settlement_helper 0, authority intact, helper_initialized false"
}

verify_deployment() {
  local core="$1" helper="$2" core_class="$3" helper_class="$4"
  require_address "deployed IwaCircle" "$core"
  require_address "deployed IwaStrk20Helper" "$helper"
  require_address "expected IwaCircle class hash" "$core_class"
  require_address "expected IwaStrk20Helper class hash" "$helper_class"

  step "Post-deployment verification (read-only)"

  # Both addresses must host their exact classes.
  local cls
  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$core")\"}" | jq -r '.result // empty')
  same_addr "$cls" "$core_class" \
    || die "IwaCircle at $core runs class $cls, expected $core_class"
  ok "IwaCircle hosts the exact class"

  cls=$(rpc_call starknet_getClassHashAt \
    "{\"block_id\":\"latest\",\"contract_address\":\"$(norm_addr "$helper")\"}" | jq -r '.result // empty')
  same_addr "$cls" "$helper_class" \
    || die "IwaStrk20Helper at $helper runs class $cls, expected $helper_class"
  ok "IwaStrk20Helper hosts the exact class"

  # Circle: stored helper exact, authority cleared, initialization locked.
  local scfg stored_helper authority initialized
  scfg=$(view_array "$core" "$SEL_GET_SETTLEMENT_CONFIG")
  stored_helper=$(felt_at "$scfg" 0)
  authority=$(felt_at "$scfg" 2)
  initialized=$(felt_at "$scfg" 3)
  same_addr "$stored_helper" "$helper" \
    || die "circle stores settlement helper $stored_helper, expected $helper"
  ok "stored settlement helper matches the deployed helper"
  same_addr "$authority" "0x0" \
    || die "setup_authority was not cleared: $authority"
  ok "setup_authority is cleared to 0x0"
  [ "$(norm_addr "$initialized")" = "0x1" ] \
    || die "helper_initialized is not true (got $initialized)"
  ok "helper initialization is locked (helper_initialized true)"

  # Helper: every configured address exact.
  local hcfg iwa_circle pool usdc strk sink
  hcfg=$(view_array "$helper" "$SEL_GET_CONFIG")
  iwa_circle=$(felt_at "$hcfg" 0)
  pool=$(felt_at "$hcfg" 1)
  usdc=$(felt_at "$hcfg" 2)
  strk=$(felt_at "$hcfg" 3)
  sink=$(felt_at "$hcfg" 4)
  same_addr "$iwa_circle" "$core" \
    || die "helper iwa_circle is $iwa_circle, expected deployed circle $core"
  same_addr "$pool" "$CFG_POOL" \
    || die "helper privacy_pool is $pool, expected $CFG_POOL"
  same_addr "$usdc" "$CFG_USDC" \
    || die "helper usdc_token is $usdc, expected $CFG_USDC"
  same_addr "$strk" "$CFG_STRK" \
    || die "helper strk_token is $strk, expected $CFG_STRK"
  same_addr "$sink" "$CFG_SINK" \
    || die "helper surplus_sink is $sink, expected $CFG_SINK"
  ok "helper config is exact: iwa_circle, privacy_pool, USDC, STRK, surplus_sink"

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
  # artifacts anywhere in this function. sncast output is parsed by labeled
  # field and fails closed on any format drift; a wrong parse can never be
  # forwarded to the next step.
  local decl_out core_class
  decl_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaCircle 2>&1 | tee /dev/stderr)
  core_class=$(sn_field class_hash "$decl_out") \
    || die "IwaCircle declare output produced no parseable class_hash field"
  [ -n "$core_class" ] || die "IwaCircle declare produced no class hash"

  local dep_out core
  dep_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$core_class" --salt "$CFG_SALT" \
    --constructor-calldata "$CFG_USDC" "$CFG_STRK" "$CFG_POOL" "$CFG_SETUP_AUTHORITY" \
    2>&1 | tee /dev/stderr)
  core=$(sn_field contract_address "$dep_out") \
    || die "IwaCircle deploy output produced no parseable contract_address field"
  [ -n "$core" ] || die "IwaCircle deploy produced no address"
  ok "IwaCircle deployed at $core (salt $CFG_SALT)"

  # Policy gate. Nothing below this line runs if the sink collides with the
  # circle: no helper deployment, no initialization.
  assert_sink_not_circle "$core"

  decl_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" declare \
    --url "$CFG_RPC" --contract-name IwaStrk20Helper 2>&1 | tee /dev/stderr)
  helper_class=$(sn_field class_hash "$decl_out") \
    || die "IwaStrk20Helper declare output produced no parseable class_hash field"
  [ -n "$helper_class" ] || die "IwaStrk20Helper declare produced no class hash"

  local helper
  dep_out=$(cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" deploy \
    --url "$CFG_RPC" --class-hash "$helper_class" --salt "$CFG_SALT" \
    --constructor-calldata "$core" "$CFG_POOL" "$CFG_USDC" "$CFG_STRK" "$CFG_SINK" \
    2>&1 | tee /dev/stderr)
  helper=$(sn_field contract_address "$dep_out") \
    || die "IwaStrk20Helper deploy output produced no parseable contract_address field"
  [ -n "$helper" ] || die "IwaStrk20Helper deploy produced no address"
  ok "IwaStrk20Helper deployed at $helper (salt $CFG_SALT)"

  # Fail-closed pre-initialization gate. Nothing below runs unless the helper
  # address hosts the exact class, the helper config is exact, and the circle
  # is still uninitialized — all re-read from the chain. This is the gate that
  # would have stopped the abandoned deployment.
  assert_helper_ready "$helper" "$core" "$helper_class"

  (cd "$PACKAGE_DIR" && sncast --account "$CFG_ACCOUNT" invoke --url "$CFG_RPC" \
    --contract-address "$core" --function initialize_settlement_helper \
    --calldata "$helper")
  ok "initialize_settlement_helper called once"

  verify_deployment "$core" "$helper" "$core_class" "$helper_class"
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
    check-helper)
      load_config "${1:-}"
      check_config_offline
      assert_helper_ready "${2:-}" "${3:-}" "${4:-}"
      printf '\nHELPER GATE PASSED — initialization is safe to send (nothing was sent).\n'
      ;;
    verify)
      load_config "${1:-}"
      verify_deployment "${2:-}" "${3:-}" "${4:-}" "${5:-}"
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

#!/usr/bin/env node
// Read-only preflight for the live STRK20 demo.
//
// It sends no transaction and holds no account. Two tiers of gates:
//
//   OFFLINE  crypto parity — the exact signature the demo will produce is
//            re-derived and checked against the acceptance predicate the
//            contract itself applies, and every pinned vector is compared to
//            the constants in contracts/starknet/tests/test_hash_parity.cairo.
//            Drift on either side fails here, with no network involved.
//
//   ON-CHAIN wiring — chain id, the class hash at each production address,
//            the one-time settlement wiring (helper set, setup authority
//            cleared, initialization locked), and the immutable helper config.
//            All read-only.
//
// Usage:
//   node lib/preflight.mjs --offline            crypto parity only, no network
//   node lib/preflight.mjs [demo.config.json]   offline gates + on-chain reads
//
// Exits non-zero on any failed gate. Fail-closed by construction: an
// unreachable RPC, an absent contract, or a malformed view is a FAIL, never a
// skip.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { verifyIwa, feltHex } from "./iwa.mjs";
import { computeParityVectors, CAIRO_CONSTANT_NAMES, FIXTURE } from "./parity.mjs";
import {
  SN_MAIN_CHAIN_ID,
  loadDemoConfig,
  makeProvider,
  getChainId,
  classHashAt,
  callView,
  feltEq,
  normFelt,
} from "./chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PARITY_TEST = resolve(HERE, "../../../contracts/starknet/tests/test_hash_parity.cairo");

// Stark curve group order, used only to build the high-s negative control.
const CURVE_ORDER = 0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;

let failures = 0;
const pass = (msg) => console.log("  PASS  " + msg);
const fail = (msg) => {
  failures += 1;
  console.log("  FAIL  " + msg);
};
const gate = (cond, msg, detail) => {
  if (cond) pass(msg);
  else fail(detail ? msg + " — " + detail : msg);
};
const section = (t) => console.log("\n--- " + t + " ---");

// Parses `const NAME: felt252 = 0x...;` out of the Cairo parity test, so the
// pinned on-chain expectations are read from that test rather than duplicated
// here.
function readCairoConstants(path) {
  const src = readFileSync(path, "utf8");
  const out = {};
  const re = /const\s+([A-Z_0-9]+)\s*:\s*[A-Za-z0-9_]+\s*=\s*([\s\S]*?);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[2].replace(/\s+/g, "").replace(/_/g, "");
    if (/^0x[0-9a-fA-F]+$/.test(raw) || /^\d+$/.test(raw)) out[m[1]] = BigInt(raw);
  }
  return out;
}

function offlineGates() {
  section("A. JS -> Cairo crypto parity (offline)");

  const v = computeParityVectors();
  let pinned;
  try {
    pinned = readCairoConstants(PARITY_TEST);
  } catch (e) {
    fail("cannot read the Cairo parity test at " + PARITY_TEST + ": " + e.message);
    return;
  }

  for (const [name, cairoName] of Object.entries(CAIRO_CONSTANT_NAMES)) {
    const expected = pinned[cairoName];
    if (expected === undefined) {
      fail(cairoName + " is not pinned in test_hash_parity.cairo");
      continue;
    }
    gate(
      expected === v[name],
      name + " matches the Cairo constant " + cairoName,
      "js=" + feltHex(v[name]) + " cairo=" + feltHex(expected)
    );
  }

  // The fixture inputs must agree too, or both sides could match on outputs
  // computed from different inputs.
  gate(pinned.SECRET_A === FIXTURE.SECRET_A, "SECRET_A fixture matches the Cairo test");
  gate(pinned.AMOUNT === FIXTURE.AMOUNT, "AMOUNT fixture matches the Cairo test");
  gate(
    pinned.PAYOUT_AMOUNT === FIXTURE.PAYOUT_AMOUNT,
    "PAYOUT_AMOUNT fixture matches the Cairo test"
  );
  gate(pinned.OPEN_NOTE === FIXTURE.OPEN_NOTE, "OPEN_NOTE fixture matches the Cairo test");

  // The decisive gate: the signature this tooling produces satisfies the exact
  // predicate the contract applies (range and canonical low-s guards, then
  // core::ecdsa::check_ecdsa_signature).
  gate(
    verifyIwa(v.KEY_A, v.CONTRIB, v.SIG_R, v.SIG_S) === true,
    "the JS signature satisfies the on-chain acceptance predicate"
  );

  // Negative controls: the predicate must reject what the contract rejects.
  gate(
    verifyIwa(v.KEY_A, v.CONTRIB, v.SIG_R, CURVE_ORDER - v.SIG_S) === false,
    "the high-s malleable twin is rejected (canonical low-s enforced)"
  );
  gate(
    verifyIwa(v.KEY_A, v.CONTRIB + 1n, v.SIG_R, v.SIG_S) === false,
    "a signature over a different message is rejected"
  );
  gate(verifyIwa(0n, v.CONTRIB, v.SIG_R, v.SIG_S) === false, "a zero auth key is rejected");
}

async function onchainGates(cfgPath) {
  section("B. Production wiring (read-only on-chain)");

  let cfg;
  try {
    cfg = loadDemoConfig(cfgPath);
  } catch (e) {
    fail(e.message);
    return;
  }

  const provider = makeProvider(cfg.rpc_url);

  let chainId;
  try {
    chainId = await getChainId(provider);
  } catch (e) {
    fail("RPC unreachable at " + cfg.rpc_url + ": " + e.message);
    return;
  }
  gate(
    feltEq(chainId, SN_MAIN_CHAIN_ID) === (cfg.network === "mainnet"),
    "chain id " + chainId + " matches the configured network " + cfg.network
  );

  const classChecks = [
    ["IwaCircle", cfg.iwa_circle, cfg.iwa_circle_class],
    ["IwaStrk20Helper", cfg.iwa_helper, cfg.iwa_helper_class],
    ["STRK20 privacy pool", cfg.privacy_pool, cfg.privacy_pool_class],
  ];
  for (const [label, addr, expectedClass] of classChecks) {
    try {
      const actual = await classHashAt(provider, addr);
      gate(
        feltEq(actual, expectedClass),
        label + " at " + normFelt(addr) + " runs the pinned class",
        "on-chain=" + normFelt(actual) + " pinned=" + normFelt(expectedClass)
      );
    } catch (e) {
      fail(label + " is not deployed at " + normFelt(addr) + ": " + e.message);
    }
  }

  // SettlementConfig { settlement_helper, privacy_pool, setup_authority, helper_initialized }
  try {
    const scfg = await callView(provider, cfg.iwa_circle, "get_settlement_config");
    gate(
      scfg.length >= 4,
      "get_settlement_config returned the expected shape",
      "len=" + scfg.length
    );
    gate(feltEq(scfg[0], cfg.iwa_helper), "circle settlement helper is the deployed helper");
    gate(feltEq(scfg[1], cfg.privacy_pool), "circle privacy pool is the verified STRK20 pool");
    gate(feltEq(scfg[2], "0x0"), "setup authority is cleared to 0x0");
    gate(feltEq(scfg[3], "0x1"), "settlement helper initialization is locked");
  } catch (e) {
    fail("get_settlement_config failed on the circle: " + e.message);
  }

  // HelperConfig { iwa_circle, privacy_pool, usdc_token, strk_token, surplus_sink }
  try {
    const hcfg = await callView(provider, cfg.iwa_helper, "get_config");
    gate(hcfg.length >= 5, "get_config returned the expected shape", "len=" + hcfg.length);
    gate(feltEq(hcfg[0], cfg.iwa_circle), "helper points at the deployed circle");
    gate(feltEq(hcfg[1], cfg.privacy_pool), "helper points at the verified STRK20 pool");
    gate(feltEq(hcfg[2], cfg.usdc_token), "helper USDC matches the configured token");
    gate(feltEq(hcfg[3], cfg.strk_token), "helper STRK matches the configured token");
    gate(feltEq(hcfg[4], cfg.surplus_sink), "helper surplus sink matches the configured sink");
  } catch (e) {
    fail("get_config failed on the helper: " + e.message);
  }
}

/**
 * Runs the gates and returns the failure count. Exported so every execution
 * script can require a green preflight in-process before it builds anything —
 * the send paths must never run against unverified wiring.
 */
export async function runPreflight({ cfgPath, offlineOnly = false } = {}) {
  failures = 0;
  console.log("IWA STRK20 demo preflight (read-only; sends nothing)");

  offlineGates();

  if (offlineOnly) console.log("\n(--offline: on-chain wiring gates were not run)");
  else await onchainGates(cfgPath ?? resolve(HERE, "../demo.config.json"));

  console.log(
    "\n" +
      (failures === 0 ? "PREFLIGHT PASS" : "PREFLIGHT FAIL — " + failures + " gate(s) failed")
  );
  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  runPreflight({
    cfgPath: args.find((a) => !a.startsWith("--")),
    offlineOnly: args.includes("--offline"),
  })
    .then((f) => process.exit(f === 0 ? 0 : 1))
    .catch((e) => {
      console.error("preflight aborted: " + (e.stack ?? e.message));
      process.exit(1);
    });
}

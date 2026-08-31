// Read-only Starknet access for the STRK20 demo tooling.
//
// Every function here is a view or an RPC read. Nothing in this module can
// sign, declare, deploy, invoke, approve, or transfer. Execution scripts must
// obtain their account separately, so a preflight can never send a transaction
// by accident.

import { RpcProvider, hash } from "starknet";
import { readFileSync } from "node:fs";

export const SN_MAIN_CHAIN_ID = "0x534e5f4d41494e";

/** Normalizes a felt/address to lowercase unpadded hex for equality checks.
 * Starknet addresses are felts: 0x0abc and 0xabc are the same value. */
export function normFelt(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = typeof v === "bigint" ? "0x" + v.toString(16) : String(v).trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(s)) return null;
  return "0x" + s.slice(2).toLowerCase().replace(/^0+(?=.)/, "");
}

export function feltEq(a, b) {
  const x = normFelt(a);
  const y = normFelt(b);
  return x !== null && y !== null && x === y;
}

export function isFelt(v) {
  return normFelt(v) !== null;
}

/** Loads a demo config and fails closed on unreplaced placeholders. */
export function loadDemoConfig(path) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const required = [
    "network",
    "rpc_url",
    "iwa_circle",
    "iwa_circle_class",
    "iwa_helper",
    "iwa_helper_class",
    "privacy_pool",
    "privacy_pool_class",
    "usdc_token",
    "strk_token",
    "surplus_sink",
  ];
  const missing = required.filter(
    (k) => !cfg[k] || String(cfg[k]).startsWith("REPLACE_ME")
  );
  if (missing.length > 0) {
    throw new Error(`demo config is incomplete: ${missing.join(", ")}`);
  }
  return cfg;
}

export function makeProvider(rpcUrl) {
  return new RpcProvider({ nodeUrl: rpcUrl });
}

export async function getChainId(provider) {
  return await provider.getChainId();
}

/** Class hash actually deployed at an address. Throws when nothing is there. */
export async function classHashAt(provider, address) {
  return await provider.getClassHashAt(address, "latest");
}

/** Calls a no-argument view and returns its raw felt array. */
export async function callView(provider, address, entrypoint, calldata = []) {
  return await provider.callContract(
    {
      contractAddress: address,
      entrypoint,
      calldata,
    },
    "latest"
  );
}

export function selector(name) {
  return hash.getSelectorFromName(name);
}

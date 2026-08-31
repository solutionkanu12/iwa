// Loads the pinned StarkWare privacy SDK from vendor/ and asserts the exact
// assumptions this tooling depends on.
//
// The SDK is vendored, not installed from a registry, so nothing can silently
// swap it out. This loader still re-checks the pin at runtime: package name,
// version, and every export and pool view the demo actually calls. Any drift
// aborts before a proof is built or a transaction is signed.
//
// Verified against the vendored copy (@starkware-libs/starknet-privacy-sdk
// 0.14.3-rc.5), which corresponds to Cairo revision
// 66e3caae8c0201227a6719696d004e30d90aea65 pinned in Scarb.toml.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract } from "starknet";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(HERE, "../vendor/starknet-privacy-sdk");

export const PINNED_SDK_NAME = "@starkware-libs/starknet-privacy-sdk";
export const PINNED_SDK_VERSION = "0.14.3-rc.5";

/** Pool contract version the pinned protocol reports: short string "2.0". */
export const PINNED_POOL_VERSION = 0x322e30n;

/** Exports this tooling calls. Missing any of them is a hard failure. */
const REQUIRED_ROOT_EXPORTS = ["createPrivateTransfers", "createEmptyRegistry", "Open"];

/** Pool views the demo relies on, beyond what the SDK itself calls. */
const REQUIRED_POOL_VIEWS = [
  "get_fee_amount",
  "get_version",
  "get_note",
  "get_public_key",
  "is_open_note_depositor_blocked",
];

function sdkPath(rel) {
  return pathToFileURL(resolve(SDK_ROOT, rel)).href;
}

/** Reads and pins the vendored SDK package identity. */
export function assertSdkPin() {
  const pkg = JSON.parse(readFileSync(resolve(SDK_ROOT, "package.json"), "utf8"));
  if (pkg.name !== PINNED_SDK_NAME) {
    throw new Error(`vendored SDK name is ${pkg.name}, expected ${PINNED_SDK_NAME}`);
  }
  if (pkg.version !== PINNED_SDK_VERSION) {
    throw new Error(
      `vendored SDK version is ${pkg.version}, expected ${PINNED_SDK_VERSION} — re-verify the ` +
        `integration research before changing this pin`
    );
  }
  return pkg;
}

/**
 * Loads the SDK and its ABI, asserting every export this tooling uses exists.
 * Returns the module namespaces rather than re-exporting, so a future SDK
 * rename surfaces here instead of as an undefined call deep in a flow.
 */
export async function loadSdk() {
  assertSdkPin();

  const sdk = await import(sdkPath("dist/index.js"));
  for (const name of REQUIRED_ROOT_EXPORTS) {
    if (sdk[name] === undefined) throw new Error(`pinned SDK is missing export ${name}`);
  }

  const { PrivacyPoolABI } = await import(sdkPath("dist/internal/abi.js"));
  if (!Array.isArray(PrivacyPoolABI) || PrivacyPoolABI.length === 0) {
    throw new Error("pinned SDK PrivacyPoolABI is missing or empty");
  }

  const { ContractDiscoveryProvider } = await import(sdkPath("dist/internal/contract-discovery.js"));
  if (typeof ContractDiscoveryProvider !== "function") {
    throw new Error("pinned SDK is missing ContractDiscoveryProvider");
  }

  return { sdk, PrivacyPoolABI, ContractDiscoveryProvider };
}

/**
 * Builds a starknet.js Contract for the pool that structurally satisfies the
 * SDK's PoolContractInterface, then proves it by calling the views the demo
 * needs. Read-only; sends nothing.
 */
export async function loadPoolContract(provider, poolAddress, PrivacyPoolABI) {
  const pool = new Contract({
    abi: PrivacyPoolABI,
    address: poolAddress,
    providerOrAccount: provider,
  });
  for (const view of REQUIRED_POOL_VIEWS) {
    if (typeof pool[view] !== "function") {
      throw new Error(`pool ABI does not expose ${view} — the pinned pool assumption is wrong`);
    }
  }
  const version = BigInt(await pool.get_version());
  if (version !== PINNED_POOL_VERSION) {
    throw new Error(
      `pool reports version 0x${version.toString(16)}, expected 0x${PINNED_POOL_VERSION.toString(16)} ("2.0")`
    );
  }
  return pool;
}

/** Live pool fee in STRK wei, pulled from the caller on every apply_actions. */
export async function livePoolFee(pool) {
  return BigInt(await pool.get_fee_amount());
}

/**
 * The pool refuses open-note credits from a blocked depositor. Payout and
 * recovery both credit an open note from the IWA helper, so this is a live
 * precondition, not a static one.
 */
export async function assertHelperNotBlocked(pool, helperAddress) {
  const blocked = await pool.is_open_note_depositor_blocked(helperAddress);
  if (blocked) {
    throw new Error(
      `the pool has blocked ${helperAddress} as an open-note depositor — payout and recovery ` +
        `cannot settle until the pool operator unblocks it`
    );
  }
  return false;
}

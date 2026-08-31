// Secret loading for the STRK20 demo.
//
// Secrets come from the environment only. They are never read from the repo,
// never written to disk, and never printed — every accessor below returns a
// value, and the only thing this module ever logs is a name and a redacted
// fingerprint. Load a local env file with Node itself:
//
//   node --env-file=.env.local 04_deposit.mjs
//
// .env.local is gitignored. Do not add secrets to demo.config.json.

import { ec } from "starknet";

const CURVE_ORDER = ec.starkCurve.CURVE.n;

/** Names of every secret this tooling reads. Used by the doctor output. */
export const SECRET_NAMES = [
  "IWA_ACCOUNT_ADDRESS",
  "IWA_ACCOUNT_PRIVATE_KEY",
  "IWA_VIEWING_KEY",
  "IWA_MEMBER_A_SECRET",
  "IWA_MEMBER_A_AUTH_PRIVATE_KEY",
  "IWA_MEMBER_B_SECRET",
  "IWA_MEMBER_B_AUTH_PRIVATE_KEY",
  "IWA_PROVER_URL",
];

class MissingSecret extends Error {
  constructor(name, why) {
    super(`missing or invalid ${name}${why ? ` — ${why}` : ""}`);
    this.name = "MissingSecret";
  }
}

function raw(name) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new MissingSecret(name, "not set");
  return v.trim();
}

/** A felt-shaped secret as a bigint. Rejects anything that is not hex. */
export function secretFelt(name) {
  const v = raw(name);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new MissingSecret(name, "not a 0x hex felt");
  const n = BigInt(v);
  if (n === 0n) throw new MissingSecret(name, "must not be zero");
  return n;
}

/** A Stark-curve private key: felt-shaped and inside the group order. */
export function secretPrivateKey(name) {
  const n = secretFelt(name);
  if (n >= CURVE_ORDER) throw new MissingSecret(name, "not a valid Stark private key (>= order)");
  return n;
}

export function secretUrl(name) {
  const v = raw(name);
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new MissingSecret(name, "not a URL");
  }
  if (u.protocol !== "https:") throw new MissingSecret(name, "must be https");
  return u.toString();
}

/** Present, never the value: first 6 and last 4 hex digits of a hash-free preview. */
export function fingerprint(value) {
  const s = typeof value === "bigint" ? "0x" + value.toString(16) : String(value);
  if (s.length <= 14) return "0x" + "*".repeat(Math.max(0, s.length - 2));
  return s.slice(0, 6) + "…" + s.slice(-4);
}

/** Reports which secrets are set, without revealing any of them. */
export function secretStatus() {
  return SECRET_NAMES.map((name) => {
    const v = process.env[name];
    return { name, set: v !== undefined && v.trim() !== "" };
  });
}

export { MissingSecret };

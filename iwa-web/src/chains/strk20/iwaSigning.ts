// chains/strk20/iwaSigning.ts — IWA settlement hashing and signing, browser side.
//
// This is a port of scripts/demo/lib/iwa.mjs. Both are locked to the deployed
// contract by the SAME fixed vectors that contracts/starknet/tests/
// test_hash_parity.cairo asserts against the real corelib functions, and
// iwaSigning.test.ts pins them here. If this file ever drifts from the chain,
// that test fails offline.
//
// The key signed here is the member's IWA settlement key. It is NOT the wallet
// account key and NOT the STRK20 viewing key — the wallet holds those and this
// app never sees them. It authorizes accounting transitions only; it cannot
// move tokens on its own or spend from the pool.
//
// Signature convention: Cairo's `check_ecdsa_signature` reconstructs both the
// public key point and R from their x-coordinates and accepts when
// `(zG + rQ).x == sR.x` OR `(zG - rQ).x == sR.x`. Because it compares only
// x-coordinates and tries both signs of rQ, the y-root the VM picks is
// irrelevant: signing with the true private key is correct, and no key
// normalization is applied. Only the canonical low-s the contract's
// `verify_settlement_hash` demands is enforced.

import { ec } from "starknet";

const CURVE_ORDER = ec.starkCurve.CURVE.n;

/** Domain tags, exactly the Cairo short-string constants in iwa_types.cairo. */
export const DOMAIN = {
  INVITE: "IWA_INVITE_V1",
  CONTRIBUTION_SETTLEMENT: "IWA_CONTRIBUTION_SETTLEMENT_V1",
  CURE_SETTLEMENT: "IWA_CURE_SETTLEMENT_V1",
  PAYOUT_AUTH: "IWA_PAYOUT_V1",
  PAYOUT_SETTLEMENT: "IWA_PAYOUT_SETTLEMENT_V1",
  RECOVERY_SETTLEMENT: "IWA_RECOVERY_SETTLEMENT_V1",
} as const;

/** Cairo short-string felt: ASCII bytes, big-endian. */
export function shortStringToFelt(str: string): bigint {
  if (str.length > 31) throw new Error(`short string too long: ${str}`);
  let hex = "";
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f) throw new Error(`short string must be ASCII: ${str}`);
    hex += code.toString(16).padStart(2, "0");
  }
  return BigInt(`0x${hex}`);
}

export type FeltIn = bigint | string | number;

const toFelt = (v: FeltIn): bigint => (typeof v === "bigint" ? v : BigInt(v));

/** Equivalent of Cairo `poseidon_hash_span(array![...].span())`. */
export function iwaHash(...vals: (FeltIn | keyof typeof DOMAIN | string)[]): bigint {
  const felts = vals.map((v) =>
    typeof v === "string" && v.startsWith("IWA_") ? shortStringToFelt(v) : toFelt(v as FeltIn),
  );
  return ec.starkCurve.poseidonHashMany(felts);
}

/** member_ref = poseidon([IWA_INVITE_V1, secret, auth_public_key]) */
export function memberRef(secret: FeltIn, authPublicKeyX: FeltIn): bigint {
  return iwaHash(DOMAIN.INVITE, secret, authPublicKeyX);
}

export interface SettlementHashArgs {
  circleId: FeltIn;
  round: FeltIn;
  memberRef: FeltIn;
  helper: FeltIn;
  pool: FeltIn;
  token: FeltIn;
  amount: FeltIn;
  nonce: FeltIn;
}

export function contributionSettlementHash(a: SettlementHashArgs): bigint {
  return iwaHash(
    DOMAIN.CONTRIBUTION_SETTLEMENT,
    a.circleId,
    a.round,
    a.memberRef,
    a.helper,
    a.pool,
    a.token,
    a.amount,
    a.nonce,
  );
}

export function cureSettlementHash(a: SettlementHashArgs): bigint {
  return iwaHash(
    DOMAIN.CURE_SETTLEMENT,
    a.circleId,
    a.round,
    a.memberRef,
    a.helper,
    a.pool,
    a.token,
    a.amount,
    a.nonce,
  );
}

export function payoutAuthorizationHash(a: {
  circleId: FeltIn;
  round: FeltIn;
  memberRef: FeltIn;
  amount: FeltIn;
  nonce: FeltIn;
}): bigint {
  return iwaHash(DOMAIN.PAYOUT_AUTH, a.circleId, a.round, a.memberRef, a.amount, a.nonce);
}

export function payoutSettlementHash(a: SettlementHashArgs & { openNoteId: FeltIn }): bigint {
  return iwaHash(
    DOMAIN.PAYOUT_SETTLEMENT,
    a.circleId,
    a.round,
    a.memberRef,
    a.helper,
    a.pool,
    a.token,
    a.amount,
    a.openNoteId,
    a.nonce,
  );
}

export function recoverySettlementHash(a: SettlementHashArgs & { openNoteId: FeltIn }): bigint {
  return iwaHash(
    DOMAIN.RECOVERY_SETTLEMENT,
    a.circleId,
    a.round,
    a.memberRef,
    a.helper,
    a.pool,
    a.token,
    a.amount,
    a.openNoteId,
    a.nonce,
  );
}

const padded = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

/** Derives the auth public key (the x-coordinate registered on chain). */
export function authPublicKey(privateKey: bigint): bigint {
  const bytes = ec.starkCurve.getPublicKey(padded(privateKey), false);
  let hex = "";
  for (const b of bytes.slice(1, 33)) hex += b.toString(16).padStart(2, "0");
  return BigInt(`0x${hex}`);
}

export interface IwaRawSignature {
  r: bigint;
  s: bigint;
}

/** Signs a message hash and enforces the canonical low-s the contract requires. */
export function signIwa(privateKey: bigint, messageHash: bigint): IwaRawSignature {
  const d = privateKey % CURVE_ORDER;
  const { r, s } = ec.starkCurve.sign(padded(messageHash), padded(d));
  return { r, s: s > CURVE_ORDER / 2n ? CURVE_ORDER - s : s };
}

/** Point from x, mirroring Cairo's `EcPointTrait::new_nz_from_x`. */
function pointFromX(x: bigint) {
  const { Fp, a, b } = ec.starkCurve.CURVE;
  const y2 = Fp.add(Fp.add(Fp.mul(Fp.mul(x, x), x), Fp.mul(a, x)), b);
  let y: bigint;
  try {
    y = Fp.sqrt(y2);
  } catch {
    return null;
  }
  if (Fp.mul(y, y) !== y2) return null;
  return ec.starkCurve.ProjectivePoint.fromAffine({ x, y });
}

/**
 * Off-chain mirror of the contract's full acceptance predicate: the range and
 * canonical low-s guards of `iwa_types::verify_settlement_hash`, then a
 * faithful re-implementation of corelib's `check_ecdsa_signature`.
 *
 * A `true` here is the same statement the chain makes, so no signature that
 * would be rejected on chain is ever put into a transaction.
 */
export function verifyIwa(
  authPublicKeyX: bigint,
  messageHash: bigint,
  r: bigint,
  s: bigint,
): boolean {
  const n = CURVE_ORDER;
  if (authPublicKeyX === 0n) return false;
  if (r <= 0n || s <= 0n || r >= n || s >= n || s > n / 2n) return false;

  const q = pointFromX(authPublicKeyX);
  if (q === null) return false;
  const rPoint = pointFromX(r);
  if (rPoint === null) return false;

  const ZERO = ec.starkCurve.ProjectivePoint.ZERO;
  const xOf = (p: typeof ZERO): bigint | null => (p.equals(ZERO) ? null : p.toAffine().x);

  const sRx = xOf(rPoint.multiply(s));
  if (sRx === null) return false;

  const z = messageHash % n;
  const zG = z === 0n ? ZERO : ec.starkCurve.ProjectivePoint.BASE.multiply(z);
  const rQ = q.multiply(r % n);

  return xOf(zG.add(rQ)) === sRx || xOf(zG.subtract(rQ)) === sRx;
}

export const feltHex = (v: bigint): string => `0x${v.toString(16)}`;

/**
 * A member identity held in memory for one session. The private key is never
 * persisted, logged, or sent anywhere; only `authPublicKeyX` and `memberRef`
 * ever leave this process, and both are public commitments.
 */
export interface MemberIdentity {
  readonly label: string;
  readonly authPublicKeyX: bigint;
  readonly memberRef: bigint;
  readonly inviteSecret: bigint;
  readonly privateKey: bigint;
}

export function deriveMemberIdentity(
  label: string,
  inviteSecret: bigint,
  privateKey: bigint,
): MemberIdentity {
  const authPublicKeyX = authPublicKey(privateKey);
  return {
    label,
    authPublicKeyX,
    memberRef: memberRef(inviteSecret, authPublicKeyX),
    inviteSecret,
    privateKey,
  };
}

/** Signs, then refuses to return anything the chain would reject. */
export function signChecked(
  identity: MemberIdentity,
  messageHash: bigint,
  what: string,
): IwaRawSignature {
  const sig = signIwa(identity.privateKey, messageHash);
  if (!verifyIwa(identity.authPublicKeyX, messageHash, sig.r, sig.s)) {
    throw new Error(
      `refusing to submit: the ${what} signature for member ${identity.label} does not satisfy ` +
        "the contract acceptance predicate",
    );
  }
  return sig;
}

// IWA domain crypto for the demo: member refs, settlement message hashes,
// and Stark-curve signatures.
//
// Hash construction MUST match the deployed IwaCircle, which hashes with the
// Cairo corelib `poseidon_hash_span(array![...].span())` (iwa_types.cairo).
// This module uses starknet.js 10.5.0 `ec.starkCurve.poseidonHashMany`, the
// exact primitive the pinned privacy SDK uses for its own pool hashes, and is
// locked by a fixed-vector parity test in the Cairo test suite
// (contracts/starknet/tests/test_hash_parity.cairo).

import { ec, encode } from "starknet";

// Domain tags, exactly as the Cairo short-string constants in iwa_types.cairo.
export const DOMAIN = {
  INVITE: "IWA_INVITE_V1",
  CONTRIBUTION_SETTLEMENT: "IWA_CONTRIBUTION_SETTLEMENT_V1",
  CURE_SETTLEMENT: "IWA_CURE_SETTLEMENT_V1",
  PAYOUT_AUTH: "IWA_PAYOUT_V1",
  PAYOUT_SETTLEMENT: "IWA_PAYOUT_SETTLEMENT_V1",
  RECOVERY_SETTLEMENT: "IWA_RECOVERY_SETTLEMENT_V1",
};

/** Cairo short-string felt: ASCII bytes, big-endian. */
export function shortStringToFelt(str) {
  if (str.length > 31) throw new Error(`short string too long: ${str}`);
  return BigInt("0x" + Buffer.from(str, "ascii").toString("hex"));
}

export function toFelt(v) {
  return BigInt(v);
}

/**
 * Equivalent of Cairo `poseidon_hash_span(array![...vals].span())`.
 * Same primitive the pinned SDK uses for pool hashes; parity locked by
 * test_hash_parity.cairo.
 */
export function iwaHash(...vals) {
  const felts = vals.map((v) =>
    typeof v === "string" ? shortStringToFelt(v) : toFelt(v)
  );
  return ec.starkCurve.poseidonHashMany(felts);
}

/** member_ref = poseidon([IWA_INVITE_V1, secret, auth_public_key]) */
export function memberRef(secret, authPublicKey) {
  return iwaHash(DOMAIN.INVITE, secret, authPublicKey);
}

export function contributionSettlementHash({
  circleId,
  round,
  memberRef,
  helper,
  pool,
  token,
  amount,
  nonce,
}) {
  return iwaHash(
    DOMAIN.CONTRIBUTION_SETTLEMENT,
    circleId,
    round,
    memberRef,
    helper,
    pool,
    token,
    amount,
    nonce
  );
}

export function cureSettlementHash({
  circleId,
  round,
  memberRef,
  helper,
  pool,
  token,
  amount,
  nonce,
}) {
  return iwaHash(
    DOMAIN.CURE_SETTLEMENT,
    circleId,
    round,
    memberRef,
    helper,
    pool,
    token,
    amount,
    nonce
  );
}

export function payoutAuthorizationHash({ circleId, round, memberRef, amount, nonce }) {
  return iwaHash(DOMAIN.PAYOUT_AUTH, circleId, round, memberRef, amount, nonce);
}

export function payoutSettlementHash({
  circleId,
  round,
  memberRef,
  helper,
  pool,
  token,
  amount,
  openNoteId,
  nonce,
}) {
  return iwaHash(
    DOMAIN.PAYOUT_SETTLEMENT,
    circleId,
    round,
    memberRef,
    helper,
    pool,
    token,
    amount,
    openNoteId,
    nonce
  );
}

export function recoverySettlementHash({
  circleId,
  round,
  memberRef,
  helper,
  pool,
  token,
  amount,
  openNoteId,
  nonce,
}) {
  return iwaHash(
    DOMAIN.RECOVERY_SETTLEMENT,
    circleId,
    round,
    memberRef,
    helper,
    pool,
    token,
    amount,
    openNoteId,
    nonce
  );
}

/**
 * Sign an IWA message hash with a member's Stark-curve auth key, then enforce
 * canonical low-s (the contract's `verify_settlement_hash` rejects s > n/2).
 *
 * No key normalization is applied, and none is needed. Cairo's
 * `core::ecdsa::check_ecdsa_signature` reconstructs both the public key point
 * and the R point from their x-coordinates, then accepts when
 * `(zG + rQ).x == sR.x` OR `(zG - rQ).x == sR.x`. Because it compares only
 * x-coordinates and tries both signs of rQ, the y-root the VM picks for the
 * reconstructed key is irrelevant: a signature made with the true private key
 * d verifies on-chain, and so would one made with n - d. Signing with the true
 * d is also what every standard ECDSA verifier expects, so that is what we do.
 * Negating s into the low half maps R to -R, which leaves sR.x unchanged and
 * therefore keeps the signature valid under the very same check.
 *
 * Locked end-to-end by contracts/starknet/tests/test_hash_parity.cairo, which
 * feeds this function's exact output to the deployed verifier.
 */
export function signIwa(privateKey, messageHash) {
  const curveOrder = ec.starkCurve.CURVE.n;
  const d = privateKey % curveOrder;
  const { r, s } = ec.starkCurve.sign(feltHexPadded(messageHash), feltHexPadded(d));
  const canonicalS = s > curveOrder / 2n ? curveOrder - s : s;
  return { r, s: canonicalS };
}

/**
 * Reconstruct a curve point from its x-coordinate, mirroring Cairo's
 * `EcPointTrait::new_nz_from_x`. Returns null when x is not on the curve.
 * The y-root returned here need not match the VM's choice: every caller below
 * compares x-coordinates only, exactly as the corelib does.
 */
function pointFromX(x) {
  const { Fp, a, b } = ec.starkCurve.CURVE;
  const y2 = Fp.add(Fp.add(Fp.mul(Fp.mul(x, x), x), Fp.mul(a, x)), b);
  let y;
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
 * canonical low-s guards of `iwa_types::verify_settlement_hash`, followed by a
 * faithful re-implementation of `core::ecdsa::check_ecdsa_signature`
 * (corelib 2.18: `(zG + rQ).x == sR.x || (zG - rQ).x == sR.x`).
 *
 * It takes the on-chain auth public key (the x-coordinate), not a private key,
 * so `true` here is the same statement the chain makes. Use it as the demo
 * preflight: never broadcast a settlement whose signature fails this check.
 */
export function verifyIwa(authPublicKeyX, messageHash, r, s) {
  const n = ec.starkCurve.CURVE.n;
  if (authPublicKeyX === 0n) return false;
  if (r <= 0n || s <= 0n || r >= n || s >= n || s > n / 2n) return false;

  const q = pointFromX(authPublicKeyX);
  if (q === null) return false;
  const rPoint = pointFromX(r);
  if (rPoint === null) return false;

  const ZERO = ec.starkCurve.ProjectivePoint.ZERO;
  const xOf = (point) => (point.equals(ZERO) ? null : point.toAffine().x);

  const sRx = xOf(rPoint.multiply(s));
  if (sRx === null) return false;

  const z = messageHash % n;
  const zG = z === 0n ? ZERO : ec.starkCurve.ProjectivePoint.BASE.multiply(z);
  const rQ = q.multiply(r % n);

  return xOf(zG.add(rQ)) === sRx || xOf(zG.subtract(rQ)) === sRx;
}

/** Derive the auth public key (x-coordinate) from a private key. */
export function authPublicKey(privateKey) {
  const bytes = ec.starkCurve.getPublicKey(feltHexPadded(privateKey), false);
  return BigInt("0x" + Buffer.from(bytes.slice(1, 33)).toString("hex"));
}

/** Felt as a 0x hex string. */
export function feltHex(v) {
  return "0x" + v.toString(16);
}

/** Felt as a fixed-width 32-byte hex string (for @scure/starknet APIs). */
function feltHexPadded(v) {
  return "0x" + v.toString(16).padStart(64, "0");
}

export { encode };
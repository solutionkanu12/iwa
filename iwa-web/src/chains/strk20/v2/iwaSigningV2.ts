// chains/strk20/v2/iwaSigningV2.ts — IWA V2 (Candidate P) destination-registration
// hashing and signing, browser side.
//
// This is the exact off-chain mirror of `contracts/starknet/src/iwa_types_v2.cairo`
// `payout_dest_v2_hash` / `recovery_dest_v2_hash` / `verify_dest_v2_signature`,
// which the A3 matrix (`test_payout_settlement_v2.cairo`) exercises end to end
// against the genuine pinned pool. `contracts/starknet/tests/test_hash_parity_v2.cairo`
// pins a fixed vector on the Cairo side; `iwaSigningV2.test.ts` pins the SAME
// vector here, so this file cannot drift from the chain without a test failing
// offline.
//
// The key signed here is the member's IWA settlement/auth key — NOT the wallet
// account key and NOT the STRK20 viewing key. In V2 it authorizes ONE thing:
// binding a precommitted private destination note id + the state-derived amount
// + a monotonic epoch + an expiry, BEFORE the STRK20 transaction is assembled.
// There is no assembly-time settlement signature in V2.

import {
  DOMAIN,
  iwaHash,
  signChecked,
  verifyIwa,
  type FeltIn,
  type IwaRawSignature,
  type MemberIdentity,
} from "../iwaSigning";

/**
 * V2 destination-registration domain tags — the Cairo short-string constants in
 * `iwa_types_v2.cairo` (`PAYOUT_DEST_V2_DOMAIN_TAG` / `RECOVERY_DEST_V2_DOMAIN_TAG`).
 */
export const DOMAIN_V2 = {
  PAYOUT_DEST: "IWA_PAYOUT_DEST_V2",
  RECOVERY_DEST: "IWA_RECOVERY_DEST_V2",
} as const;

/** `iwa_types_v2::IWA_PROTOCOL_VERSION_V2`. Bound into every V2 hash. */
export const IWA_PROTOCOL_VERSION_V2 = 2n;

// A defensive re-export so callers never need to reach past this module for the
// V1 domain constants when they are doing V2 work.
export { DOMAIN as DOMAIN_V1 };

export interface DestinationV2HashArgs {
  /** The IwaCircleV2 contract address. */
  circleContract: FeltIn;
  /** The IwaStrk20HelperV2 contract address. */
  helper: FeltIn;
  /** The STRK20 privacy pool address. */
  pool: FeltIn;
  /** The circle's settlement token (USDC or STRK). */
  token: FeltIn;
  circleId: FeltIn;
  round: FeltIn;
  /** The scheduled recipient's member_ref, taken from circle state. */
  memberRef: FeltIn;
  /** The open-note id the wallet resolved from `wallet_strk20PrepareInvoke`. */
  noteId: FeltIn;
  /** The pot / recovery amount, taken from circle state — never caller-supplied. */
  amount: FeltIn;
  /** Strictly greater than the member's current on-chain dest epoch. */
  destEpoch: FeltIn;
  /** Unix seconds; the contract rejects registration and settlement after it. */
  expiry: FeltIn;
  /** Single-use in `(circle_id, member_ref, nonce)`. */
  nonce: FeltIn;
}

function destV2Hash(tag: string, a: DestinationV2HashArgs): bigint {
  // Exactly the felt order of `iwa_types_v2::dest_hash`:
  //   [tag, IWA_PROTOCOL_VERSION_V2, circle_contract, helper, pool, token,
  //    circle_id, round, member_ref, note_id, amount, dest_epoch, expiry, nonce]
  return iwaHash(
    tag,
    IWA_PROTOCOL_VERSION_V2,
    a.circleContract,
    a.helper,
    a.pool,
    a.token,
    a.circleId,
    a.round,
    a.memberRef,
    a.noteId,
    a.amount,
    a.destEpoch,
    a.expiry,
    a.nonce,
  );
}

/** `iwa_types_v2::payout_dest_v2_hash`. */
export function payoutDestV2Hash(a: DestinationV2HashArgs): bigint {
  return destV2Hash(DOMAIN_V2.PAYOUT_DEST, a);
}

/** `iwa_types_v2::recovery_dest_v2_hash`. */
export function recoveryDestV2Hash(a: DestinationV2HashArgs): bigint {
  return destV2Hash(DOMAIN_V2.RECOVERY_DEST, a);
}

/**
 * The contract's V2 signature acceptance predicate
 * (`iwa_types_v2::verify_dest_v2_signature`) is byte-for-byte the same as V1's
 * `verify_settlement_hash` — canonical Stark ECDSA with the range and low-s
 * guards — so the V1 mirror `verifyIwa` is the correct check here too.
 */
export { verifyIwa as verifyDestV2Signature };

export interface SignedDestinationV2 {
  readonly hash: bigint;
  readonly r: bigint;
  readonly s: bigint;
}

/**
 * Signs a V2 payout-destination registration with the member's IWA auth key and
 * refuses to return anything the chain would reject. `identity.authPublicKeyX`
 * MUST be the key registered for `args.memberRef` on chain, or the contract will
 * reject the registration regardless of a locally-valid signature.
 */
export function signPayoutDestinationV2(
  identity: MemberIdentity,
  args: DestinationV2HashArgs,
): SignedDestinationV2 {
  const hash = payoutDestV2Hash(args);
  const sig: IwaRawSignature = signChecked(identity, hash, "V2 payout destination registration");
  return { hash, r: sig.r, s: sig.s };
}

/** Signs a V2 recovery-destination registration (same mechanism as payout). */
export function signRecoveryDestinationV2(
  identity: MemberIdentity,
  args: DestinationV2HashArgs,
): SignedDestinationV2 {
  const hash = recoveryDestV2Hash(args);
  const sig: IwaRawSignature = signChecked(identity, hash, "V2 recovery destination registration");
  return { hash, r: sig.r, s: sig.s };
}

// The single source of the JS/Cairo parity fixture.
//
// These exact inputs are mirrored by contracts/starknet/tests/test_hash_parity.cairo,
// which asserts the values computed here against the corelib functions the
// deployed IwaCircle actually runs. Both `00_vectors.mjs` (which regenerates
// the pinned Cairo constants) and `lib/preflight.mjs` (which re-checks them
// before any live run) import from here, so the two can never drift apart.

import {
  memberRef,
  contributionSettlementHash,
  cureSettlementHash,
  payoutAuthorizationHash,
  payoutSettlementHash,
  recoverySettlementHash,
  signIwa,
  authPublicKey,
} from "./iwa.mjs";

/** Fixed, non-secret test inputs. This private key is a published fixture and
 * must never be used to hold value. */
export const FIXTURE = {
  SECRET_A: 0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeffn,
  KEY_A_PRIV: 0x1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234n,
  HELPER: 0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbbn,
  POOL: 0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812an,
  USDC: 0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fbn,
  AMOUNT: 1_000_000n,
  PAYOUT_AMOUNT: 2_000_000n,
  OPEN_NOTE: 0xdeadbeefcafebaben,
  CIRCLE_ID: 1n,
  ROUND: 1n,
};

/** Recomputes every pinned vector, including the signature the chain must accept. */
export function computeParityVectors() {
  const f = FIXTURE;
  const KEY_A = authPublicKey(f.KEY_A_PRIV);
  const ref = memberRef(f.SECRET_A, KEY_A);
  const common = {
    circleId: f.CIRCLE_ID,
    round: f.ROUND,
    memberRef: ref,
    helper: f.HELPER,
    pool: f.POOL,
    token: f.USDC,
  };

  const contrib = contributionSettlementHash({ ...common, amount: f.AMOUNT, nonce: 1n });
  const cure = cureSettlementHash({ ...common, amount: f.AMOUNT, nonce: 2n });
  const payAuth = payoutAuthorizationHash({
    circleId: f.CIRCLE_ID,
    round: f.ROUND,
    memberRef: ref,
    amount: f.PAYOUT_AMOUNT,
    nonce: 3n,
  });
  const paySettle = payoutSettlementHash({
    ...common,
    amount: f.PAYOUT_AMOUNT,
    openNoteId: f.OPEN_NOTE,
    nonce: 4n,
  });
  const recSettle = recoverySettlementHash({
    ...common,
    amount: f.PAYOUT_AMOUNT,
    openNoteId: f.OPEN_NOTE,
    nonce: 5n,
  });

  const { r, s } = signIwa(f.KEY_A_PRIV, contrib);

  return {
    KEY_A,
    MEMBER_REF: ref,
    CONTRIB: contrib,
    CURE: cure,
    PAYOUT_AUTH: payAuth,
    PAYOUT_SETTLE: paySettle,
    RECOVERY_SETTLE: recSettle,
    SIG_R: r,
    SIG_S: s,
  };
}

/** Maps a computed vector name onto the constant name pinned in the Cairo test. */
export const CAIRO_CONSTANT_NAMES = {
  KEY_A: "KEY_A",
  MEMBER_REF: "EXPECTED_MEMBER_REF",
  CONTRIB: "EXPECTED_CONTRIB",
  CURE: "EXPECTED_CURE",
  PAYOUT_AUTH: "EXPECTED_PAYOUT_AUTH",
  PAYOUT_SETTLE: "EXPECTED_PAYOUT_SETTLE",
  RECOVERY_SETTLE: "EXPECTED_RECOVERY_SETTLE",
  SIG_R: "SIG_R",
  SIG_S: "SIG_S",
};

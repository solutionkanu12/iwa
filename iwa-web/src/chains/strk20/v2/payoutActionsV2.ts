// chains/strk20/v2/payoutActionsV2.ts — V2 (Candidate P) calldata builders.
//
// Two transactions, in this order:
//
//   1. register_payout_destination(circle_id, round, note_id, amount,
//        dest_epoch, expiry, nonce, signature_r, signature_s)
//      A PLAIN Starknet call to IwaCircleV2 from the member's wallet account
//      (account.execute), NOT a STRK20 action. Binds the precommitted note id +
//      the STATE-DERIVED amount. No token moves.
//
//   2. the STRK20 settlement action set, submitted through the wallet's
//      strk20InvokeTransaction:
//        [ transfer OPEN -> self ]   creates the open note, id = ${openNoteIds[0]}
//        [ invoke -> IwaStrk20HelperV2 ] SettlePayout, calldata:
//          privacy_invoke(operation=SettlePayout, circle_id, round, member_ref,
//                         token, open_note_id=${openNoteIds[0]}, nonce=0,
//                         signature_r=0, signature_s=0)
//      Candidate P carries NO assembly-time signature and NO nonce: the V2
//      helper REQUIRES nonce == r == s == 0 (NO_ASSEMBLY_SIGNATURE), and the
//      amount is read from IwaCircleV2 state, never from calldata.
//
// There is deliberately NO public-ERC20 payout builder in this module. The only
// value-moving path is the STRK20 action set above, through the pinned pool.

import type { STRK20_ACTION } from "@starknet-io/types-js";

import { FIRST_OPEN_NOTE } from "../strk20Actions";

/** IwaOperation discriminant for the payout leg (iwa_strk20_helper.cairo order). */
export const V2_SETTLE_PAYOUT = 2 as const;
/** IwaOperation discriminant for the recovery leg. */
export const V2_SETTLE_RECOVERY = 3 as const;

const felt = (v: string | number | bigint): string => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`felt must be non-negative: ${v}`);
  return `0x${n.toString(16)}`;
};

const u128 = (v: string | number | bigint): string => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`u128 must be non-negative: ${v}`);
  if (n >= 1n << 128n) throw new Error(`value does not fit in u128: ${v}`);
  return `0x${n.toString(16)}`;
};

const u64 = (v: string | number | bigint): string => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`u64 must be non-negative: ${v}`);
  if (n >= 1n << 64n) throw new Error(`value does not fit in u64: ${v}`);
  return `0x${n.toString(16)}`;
};

export interface RegisterPayoutDestinationArgs {
  circleId: number;
  round: number;
  /** The wallet-resolved open-note id. Must be non-zero. */
  noteId: bigint;
  /** From `get_payout_state_v2(...).amount` — NEVER a user input. */
  amount: bigint;
  /** Strictly greater than `get_dest_epoch(circle_id, member_ref)`. */
  destEpoch: bigint;
  /** Unix seconds. */
  expiry: bigint;
  /** Single-use felt in `(circle_id, member_ref, nonce)`. */
  nonce: bigint;
  signature: { r: bigint; s: bigint };
}

export interface StarknetCall {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

/**
 * The plain `account.execute` call for step 1. `circleV2Address` is the
 * IwaCircleV2 contract; there is no other target this call may go to.
 */
export function buildRegisterPayoutDestinationCall(
  circleV2Address: string,
  args: RegisterPayoutDestinationArgs,
): StarknetCall {
  if (args.noteId === 0n) throw new Error("noteId must be non-zero");
  if (args.amount <= 0n) throw new Error("amount must be positive");
  if (args.destEpoch <= 0n) throw new Error("destEpoch must be positive");
  return {
    contractAddress: felt(circleV2Address),
    entrypoint: "register_payout_destination",
    calldata: [
      felt(args.circleId),
      felt(args.round),
      felt(args.noteId),
      u128(args.amount),
      u64(args.destEpoch),
      u64(args.expiry),
      felt(args.nonce),
      felt(args.signature.r),
      felt(args.signature.s),
    ],
  };
}

/**
 * `privacy_invoke` calldata for the V2 payout/recovery leg. Nine felts, exactly
 * `iwa_strk20_helper::privacy_invoke`. nonce / signature_r / signature_s are
 * forced to `0x0` — the V2 helper rejects anything else on these legs.
 */
export function v2PrivacyInvokeCalldata(args: {
  operation: typeof V2_SETTLE_PAYOUT | typeof V2_SETTLE_RECOVERY;
  circleId: number;
  round: number;
  memberRef: bigint;
  token: string;
  /** Literal felt or the `${openNoteIds[0]}` placeholder. */
  openNoteId: string;
}): string[] {
  return [
    felt(args.operation),
    felt(args.circleId),
    felt(args.round),
    felt(args.memberRef),
    felt(args.token),
    args.openNoteId === FIRST_OPEN_NOTE ? args.openNoteId : felt(args.openNoteId),
    "0x0", // nonce — Candidate P carries none
    "0x0", // signature_r — no assembly-time signature
    "0x0", // signature_s
  ];
}

export interface PayoutSettlementActionsV2Args {
  helperV2Address: string;
  circleId: number;
  round: number;
  memberRef: bigint;
  token: string;
  /**
   * The Starknet address the open note is created for. In Candidate P this is
   * the member's OWN wallet address — the note whose id they precommitted.
   */
  selfAddress: string;
}

/**
 * The STRK20 action set for step 2. The open note MUST be the first action so
 * `${openNoteIds[0]}` resolves to it.
 */
export function buildPayoutSettlementActionsV2(
  args: PayoutSettlementActionsV2Args,
): STRK20_ACTION[] {
  return [
    { type: "transfer", token: felt(args.token), amount: "OPEN", recipient: felt(args.selfAddress) },
    {
      type: "invoke",
      contract: felt(args.helperV2Address),
      calldata: v2PrivacyInvokeCalldata({
        operation: V2_SETTLE_PAYOUT,
        circleId: args.circleId,
        round: args.round,
        memberRef: args.memberRef,
        token: args.token,
        openNoteId: FIRST_OPEN_NOTE,
      }),
    },
  ];
}

/**
 * Locates the wallet-resolved `open_note_id` in a `wallet_strk20PrepareInvoke`
 * response.
 *
 * The invoke calldata we submitted is a contiguous, uniquely-shaped run in the
 * resolved apply-actions calldata:
 *   [ SettlePayout(=2), circle_id, round, member_ref, token, X, 0, 0, 0 ]
 * where `member_ref` is a full Poseidon felt and the trailing three zeros are
 * the forced nonce/r/s. We match positions 0..4 and 6..8 against known values
 * and return X (position 5), which must be a non-zero felt.
 *
 * If the wallet did NOT substitute the placeholder (X is still the literal
 * `${openNoteIds[0]}` string), or the run is absent, this returns null and the
 * caller aborts — nothing is on chain.
 */
export function extractResolvedOpenNoteId(
  built: unknown,
  anchors: {
    operation: typeof V2_SETTLE_PAYOUT | typeof V2_SETTLE_RECOVERY;
    circleId: number;
    round: number;
    memberRef: bigint;
    token: string;
  },
): bigint | null {
  const want = [
    BigInt(anchors.operation),
    BigInt(anchors.circleId),
    BigInt(anchors.round),
    anchors.memberRef,
    BigInt(anchors.token),
  ];

  const feltOrNull = (v: unknown): bigint | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(t)) return null;
    try {
      return BigInt(t);
    } catch {
      return null;
    }
  };

  let found: bigint | null = null;

  const walk = (node: unknown): void => {
    if (found !== null) return;
    if (Array.isArray(node)) {
      for (let i = 0; i + 9 <= node.length; i++) {
        let ok = true;
        for (let k = 0; k < 5; k++) {
          if (feltOrNull(node[i + k]) !== want[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (
          feltOrNull(node[i + 6]) !== 0n ||
          feltOrNull(node[i + 7]) !== 0n ||
          feltOrNull(node[i + 8]) !== 0n
        ) {
          continue;
        }
        const x = feltOrNull(node[i + 5]);
        if (x !== null && x !== 0n) {
          found = x;
          return;
        }
      }
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };

  walk(built);
  return found;
}

/**
 * The V2 frontend payout surface, enumerated so a test can assert it contains
 * NO public-ERC20 transfer path. Every entry either builds a plain
 * `register_payout_destination` call to IwaCircleV2 or a STRK20 action set that
 * routes value through the pinned pool.
 */
export const V2_PAYOUT_SURFACE: readonly {
  readonly name: string;
  readonly kind: "circle-call" | "strk20-actions";
  readonly target: "IwaCircleV2" | "STRK20-pool";
}[] = [
  { name: "buildRegisterPayoutDestinationCall", kind: "circle-call", target: "IwaCircleV2" },
  { name: "buildPayoutSettlementActionsV2", kind: "strk20-actions", target: "STRK20-pool" },
];

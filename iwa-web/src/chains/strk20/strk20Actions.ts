// chains/strk20/strk20Actions.ts — STRK20 action builders for IWA.
//
// Pure functions: they take plain values and return `STRK20_ACTION[]`. No
// wallet, no network, no key material, so every shape below is unit-testable
// without a browser or a wallet extension.
//
// The calldata order in an `invoke` action is the whole contract with the
// helper: the pool deserializes it straight into `privacy_invoke`, adding no
// envelope, length prefix, or operation tag. It must therefore match
// IwaStrk20Helper::privacy_invoke exactly:
//
//   privacy_invoke(operation, circle_id, round, member_ref, token,
//                  open_note_id, nonce, signature_r, signature_s)
//
// The wallet expands two placeholders inside that calldata: `${openNoteIds[N]}`
// for the id of the Nth open note in the same transaction, and `${poolAddress}`
// for the pool. IWA uses the first — it is what lets a payout reference a note
// that does not exist yet when the calldata is built.

import type { STRK20_ACTION } from "@starknet-io/types-js";

import { STARKNET_MAINNET } from "../starknetProduction";

/** IwaOperation discriminants, in declaration order in iwa_strk20_helper.cairo. */
export const IWA_OPERATION = {
  SettleContribution: 0,
  SettleCure: 1,
  SettlePayout: 2,
  SettleRecovery: 3,
} as const;

export type IwaOperation = (typeof IWA_OPERATION)[keyof typeof IWA_OPERATION];

/** The wallet placeholder for the first open note created in this transaction. */
export const FIRST_OPEN_NOTE = "${openNoteIds[0]}";

/**
 * A member's settlement signature. Produced by the member's IWA auth key,
 * which is a settlement-authorization key — not the wallet account key and not
 * the STRK20 viewing key, neither of which this app ever sees.
 */
export interface IwaSignature {
  readonly r: string;
  readonly s: string;
}

/**
 * Signs IWA settlement messages. Implemented outside this module so key
 * custody is the host application's decision and no key is ever passed
 * through the action builders.
 */
export interface MemberAuthSigner {
  readonly memberRef: string;
  signContributionSettlement(args: ContributionSigningArgs): Promise<IwaSignature>;
  signPayoutSettlement(args: PayoutSigningArgs): Promise<IwaSignature>;
}

export interface ContributionSigningArgs {
  circleId: number;
  round: number;
  token: string;
  amount: string;
  nonce: string;
}

export interface PayoutSigningArgs extends ContributionSigningArgs {
  /** Resolved on chain; the signature binds the note the pool will fill. */
  openNoteId: string;
}

const felt = (v: string | number | bigint): string => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`felt must be non-negative: ${v}`);
  return `0x${n.toString(16)}`;
};

/**
 * Serializes `privacy_invoke`. `openNoteId` may be a literal felt or the
 * wallet placeholder, which is why it is not passed through `felt()`.
 */
export function privacyInvokeCalldata(args: {
  operation: IwaOperation;
  circleId: number;
  round: number;
  memberRef: string;
  token: string;
  openNoteId: string;
  nonce: string;
  signature: IwaSignature;
}): string[] {
  return [
    felt(args.operation),
    felt(args.circleId),
    felt(args.round),
    felt(args.memberRef),
    felt(args.token),
    args.openNoteId === FIRST_OPEN_NOTE ? args.openNoteId : felt(args.openNoteId),
    felt(args.nonce),
    felt(args.signature.r),
    felt(args.signature.s),
  ];
}

/**
 * Shield: move public ERC-20 into the pool as a private note.
 *
 * Two user-visible transactions, always: the ERC-20 `approve` must land on
 * chain before the private deposit, so the wallet prompts twice. Label both in
 * the UI or the second prompt reads as a duplicate-transaction bug.
 */
export function buildShieldActions(args: { token: string; amount: string }): STRK20_ACTION[] {
  return [{ type: "deposit", token: felt(args.token), amount: felt(args.amount) }];
}

/**
 * Contribution settlement: withdraw the exact obligation to the helper, then
 * invoke it.
 *
 * No open note. Contribution binds no output, the helper returns an empty
 * span, and creating an open note that nothing fills reverts the whole
 * transaction with UNDEPOSITED_OPEN_NOTES.
 *
 * The pool applies the withdrawal (phase 6) before the invoke (phase 7), so
 * the tokens are already in the helper when it checks its inbound balance.
 */
export function buildContributionActions(args: {
  circleId: number;
  round: number;
  memberRef: string;
  token: string;
  amount: string;
  nonce: string;
  signature: IwaSignature;
  helper?: string;
}): STRK20_ACTION[] {
  const helper = felt(args.helper ?? STARKNET_MAINNET.iwaHelper);
  return [
    { type: "withdraw", token: felt(args.token), amount: felt(args.amount), recipient: helper },
    {
      type: "invoke",
      contract: helper,
      calldata: privacyInvokeCalldata({
        operation: IWA_OPERATION.SettleContribution,
        circleId: args.circleId,
        round: args.round,
        memberRef: args.memberRef,
        token: args.token,
        openNoteId: "0",
        nonce: args.nonce,
        signature: args.signature,
      }),
    },
  ];
}

/**
 * Payout settlement: open a note for the scheduled recipient, then invoke.
 *
 * Exactly one open note. The helper returns one OpenNoteDeposit and approves
 * the pool for exactly that amount, which the pool pulls into the note. The
 * open note must be the first action so `${openNoteIds[0]}` resolves to it.
 */
export function buildPayoutActions(args: {
  circleId: number;
  round: number;
  memberRef: string;
  token: string;
  recipient: string;
  nonce: string;
  signature: IwaSignature;
  helper?: string;
}): STRK20_ACTION[] {
  const helper = felt(args.helper ?? STARKNET_MAINNET.iwaHelper);
  return [
    { type: "transfer", token: felt(args.token), amount: "OPEN", recipient: felt(args.recipient) },
    {
      type: "invoke",
      contract: helper,
      calldata: privacyInvokeCalldata({
        operation: IWA_OPERATION.SettlePayout,
        circleId: args.circleId,
        round: args.round,
        memberRef: args.memberRef,
        token: args.token,
        openNoteId: FIRST_OPEN_NOTE,
        nonce: args.nonce,
        signature: args.signature,
      }),
    },
  ];
}

/**
 * Guards the protocol rules that are invisible until the transaction reverts.
 * Cheap to run before every submission.
 */
export function assertActionsWellFormed(actions: STRK20_ACTION[]): void {
  if (actions.length === 0) throw new Error("a STRK20 transaction needs at least one action");

  const invokes = actions.filter((a) => a.type === "invoke");
  if (invokes.length > 1) {
    throw new Error("the pool permits at most one invoke action per transaction");
  }

  const openNotes = actions.filter((a) => a.type === "transfer" && a.amount === "OPEN");
  const usesFirstOpenNote = invokes.some((a) =>
    a.type === "invoke" ? a.calldata.includes(FIRST_OPEN_NOTE) : false,
  );

  if (openNotes.length > 0 && invokes.length === 0) {
    throw new Error(
      "an open note with no invoke to fill it reverts the transaction (UNDEPOSITED_OPEN_NOTES)",
    );
  }
  if (usesFirstOpenNote && openNotes.length === 0) {
    throw new Error(`${FIRST_OPEN_NOTE} was referenced but no open note is created`);
  }
}

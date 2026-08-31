// IWA circle and helper domain layer for the demo.
//
// Calls are built as raw `{ contractAddress, entrypoint, calldata }` and views
// are decoded from raw felt arrays. That is deliberate: the deployed classes
// are pinned by hash in the preflight, so the encoding below is checked against
// the exact bytecode that will run, and no separately built ABI file can drift
// away from it.
//
// Every layout here is transcribed from contracts/starknet/src/iwa_types.cairo
// and iwa_circle.cairo at the deployed revision. Enum discriminants are the
// declaration order Cairo's Serde uses.

import { callView, normFelt, feltEq } from "./chain.mjs";
import {
  memberRef as computeMemberRef,
  contributionSettlementHash,
  cureSettlementHash,
  payoutAuthorizationHash,
  payoutSettlementHash,
  recoverySettlementHash,
  signIwa,
  verifyIwa,
  authPublicKey,
  feltHex,
} from "./iwa.mjs";

// --- Enum discriminants (declaration order in iwa_types.cairo) ---

export const SupportedAsset = { Usdc: 0, Strk: 1 };

export const CircleStatus = [
  "Created",
  "OpenForMembers",
  "Active",
  "PausedForNewActions",
  "SettlementPending",
  "Completed",
];

export const ContributionStatus = ["Pending", "OnTime", "LateWithinGrace", "MissedDefault"];

export const PayoutStatus = [
  "Scheduled",
  "DeferredLocked",
  "SettlementAuthorized",
  "RecoveryPending",
  "NoFundedRecovery",
  "Paid",
  "Recovered",
];

/** IwaOperation, declaration order in iwa_strk20_helper.cairo. */
export const IwaOperation = {
  SettleContribution: 0,
  SettleCure: 1,
  SettlePayout: 2,
  SettleRecovery: 3,
};

// --- Decoding helpers ---

const num = (felt) => BigInt(felt);
const asInt = (felt) => Number(BigInt(felt));
const u256 = (lo, hi) => BigInt(lo) + (BigInt(hi) << 128n);

function variant(table, felt, what) {
  const i = asInt(felt);
  if (i < 0 || i >= table.length) throw new Error(`unknown ${what} discriminant ${i}`);
  return table[i];
}

// --- Views ---

/** CircleView: 12 felts, in declaration order. */
export async function getCircle(provider, circleAddress, circleId) {
  const r = await callView(provider, circleAddress, "get_circle", [String(circleId)]);
  if (r.length < 12) throw new Error(`get_circle returned ${r.length} felts, expected 12`);
  return {
    id: asInt(r[0]),
    asset: asInt(r[1]) === SupportedAsset.Usdc ? "Usdc" : "Strk",
    contributionAmount: num(r[2]),
    cadenceSeconds: num(r[3]),
    gracePeriodSeconds: num(r[4]),
    memberLimit: asInt(r[5]),
    currentRound: asInt(r[6]),
    status: variant(CircleStatus, r[7], "CircleStatus"),
    createdAt: num(r[8]),
    organizer: normFelt(r[9]),
    payoutOrderLocked: asInt(r[10]) === 1,
    joinedCount: asInt(r[11]),
  };
}

export async function getPayoutOrder(provider, circleAddress, circleId) {
  const r = await callView(provider, circleAddress, "get_payout_order", [String(circleId)]);
  const len = asInt(r[0]);
  return r.slice(1, 1 + len).map((f) => normFelt(f));
}

export async function isMember(provider, circleAddress, circleId, ref) {
  const r = await callView(provider, circleAddress, "is_member", [String(circleId), feltHex(ref)]);
  return asInt(r[0]) === 1;
}

export async function getMemberAuthKey(provider, circleAddress, circleId, ref) {
  const r = await callView(provider, circleAddress, "get_member_auth_key", [
    String(circleId),
    feltHex(ref),
  ]);
  return BigInt(r[0]);
}

/** ContributionObligation: 8 felts. */
export async function getContributionObligation(provider, circleAddress, circleId, round, ref) {
  const r = await callView(provider, circleAddress, "get_contribution_obligation", [
    String(circleId),
    String(round),
    feltHex(ref),
  ]);
  if (r.length < 8) throw new Error(`get_contribution_obligation returned ${r.length} felts`);
  return {
    circleId: asInt(r[0]),
    round: asInt(r[1]),
    memberRef: normFelt(r[2]),
    asset: asInt(r[3]) === SupportedAsset.Usdc ? "Usdc" : "Strk",
    requiredAmount: num(r[4]),
    dueAt: num(r[5]),
    graceEndsAt: num(r[6]),
    status: variant(ContributionStatus, r[7], "ContributionStatus"),
  };
}

/** PayoutState: 5 felts. */
export async function getPayoutState(provider, circleAddress, circleId, round) {
  const r = await callView(provider, circleAddress, "get_payout_state", [
    String(circleId),
    String(round),
  ]);
  if (r.length < 5) throw new Error(`get_payout_state returned ${r.length} felts`);
  return {
    circleId: asInt(r[0]),
    round: asInt(r[1]),
    scheduledMemberRef: normFelt(r[2]),
    amount: num(r[3]),
    status: variant(PayoutStatus, r[4], "PayoutStatus"),
  };
}

/** RoundLiability: circle_id, round, token, then three u256 (2 felts each). */
export async function getRoundLiability(provider, circleAddress, circleId, round) {
  const r = await callView(provider, circleAddress, "get_round_liability", [
    String(circleId),
    String(round),
  ]);
  if (r.length < 9) throw new Error(`get_round_liability returned ${r.length} felts`);
  return {
    circleId: asInt(r[0]),
    round: asInt(r[1]),
    token: normFelt(r[2]),
    settledInflows: u256(r[3], r[4]),
    settledOutflows: u256(r[5], r[6]),
    outstanding: u256(r[7], r[8]),
  };
}

export async function isContributionNonceConsumed(provider, circleAddress, circleId, ref, nonce) {
  const r = await callView(provider, circleAddress, "is_contribution_nonce_consumed", [
    String(circleId),
    feltHex(ref),
    feltHex(nonce),
  ]);
  return asInt(r[0]) === 1;
}

export async function isPayoutNonceConsumed(provider, circleAddress, circleId, ref, nonce) {
  const r = await callView(provider, circleAddress, "is_payout_nonce_consumed", [
    String(circleId),
    feltHex(ref),
    feltHex(nonce),
  ]);
  return asInt(r[0]) === 1;
}

export async function isPayoutSettlementNonceConsumed(
  provider,
  circleAddress,
  circleId,
  ref,
  nonce
) {
  const r = await callView(provider, circleAddress, "is_payout_settlement_nonce_consumed", [
    String(circleId),
    feltHex(ref),
    feltHex(nonce),
  ]);
  return asInt(r[0]) === 1;
}

/** Helper-side accounted custody for a token, as u256. */
export async function getHelperTokenLiability(provider, helperAddress, token) {
  const r = await callView(provider, helperAddress, "get_token_liability", [normFelt(token)]);
  return u256(r[0], r[1]);
}

export async function getHelperSurplus(provider, helperAddress, token) {
  const r = await callView(provider, helperAddress, "get_surplus", [normFelt(token)]);
  return u256(r[0], r[1]);
}

// --- Transparent (non-pool) calls ---

/**
 * create_circle(token, contribution_amount: u128, cadence_seconds: u64,
 *               grace_period_seconds: u64, member_limit: u8,
 *               payout_order: Span<felt252>)
 */
export function createCircleCall(circleAddress, { token, contributionAmount, cadenceSeconds, gracePeriodSeconds, memberLimit, payoutOrder }) {
  return {
    contractAddress: normFelt(circleAddress),
    entrypoint: "create_circle",
    calldata: [
      normFelt(token),
      feltHex(contributionAmount),
      String(cadenceSeconds),
      String(gracePeriodSeconds),
      String(memberLimit),
      String(payoutOrder.length),
      ...payoutOrder.map((r) => feltHex(r)),
    ],
  };
}

export function joinCircleCall(circleAddress, { circleId, inviteSecret, authPublicKey: key }) {
  return {
    contractAddress: normFelt(circleAddress),
    entrypoint: "join_circle",
    calldata: [String(circleId), feltHex(inviteSecret), feltHex(key)],
  };
}

export function finalizeRoundPayoutAccountingCall(circleAddress, { circleId, round }) {
  return {
    contractAddress: normFelt(circleAddress),
    entrypoint: "finalize_round_payout_accounting",
    calldata: [String(circleId), String(round)],
  };
}

export function authorizePayoutSettlementCall(circleAddress, { circleId, round, nonce, r, s }) {
  return {
    contractAddress: normFelt(circleAddress),
    entrypoint: "authorize_payout_settlement",
    calldata: [String(circleId), String(round), feltHex(nonce), feltHex(r), feltHex(s)],
  };
}

export function erc20ApproveCall(token, spender, amount) {
  const lo = amount & ((1n << 128n) - 1n);
  const hi = amount >> 128n;
  return {
    contractAddress: normFelt(token),
    entrypoint: "approve",
    calldata: [normFelt(spender), feltHex(lo), feltHex(hi)],
  };
}

// --- Member identity ---

/**
 * Derives one demo member identity from its two secrets. The auth private key
 * never leaves this process; only the public key (an x-coordinate) and the
 * member_ref commitment are ever sent on chain or printed.
 */
export function deriveMember(label, inviteSecret, authPrivateKey) {
  const key = authPublicKey(authPrivateKey);
  return {
    label,
    inviteSecret,
    authPrivateKey,
    authPublicKey: key,
    memberRef: computeMemberRef(inviteSecret, key),
  };
}

// --- privacy_invoke calldata ---

/**
 * Serializes `privacy_invoke(operation, circle_id, round, member_ref, token,
 * open_note_id, nonce, signature_r, signature_s)` — nine felts, no envelope.
 * The pool forwards this verbatim; the helper ABI is the whole encoding.
 */
export function privacyInvokeCalldata({
  operation,
  circleId,
  round,
  memberRef,
  token,
  openNoteId,
  nonce,
  r,
  s,
}) {
  return [
    String(operation),
    String(circleId),
    String(round),
    feltHex(memberRef),
    normFelt(token),
    feltHex(openNoteId),
    feltHex(nonce),
    feltHex(r),
    feltHex(s),
  ];
}

// --- Signing, always self-checked against the on-chain predicate ---

function signChecked(member, messageHash, what) {
  const { r, s } = signIwa(member.authPrivateKey, messageHash);
  if (!verifyIwa(member.authPublicKey, messageHash, r, s)) {
    throw new Error(
      `refusing to submit: the ${what} signature for member ${member.label} does not satisfy the ` +
        `contract acceptance predicate`
    );
  }
  return { r, s, messageHash };
}

export function signContributionSettlement(member, args) {
  return signChecked(
    member,
    contributionSettlementHash({ ...args, memberRef: member.memberRef }),
    "contribution settlement"
  );
}

export function signCureSettlement(member, args) {
  return signChecked(
    member,
    cureSettlementHash({ ...args, memberRef: member.memberRef }),
    "cure settlement"
  );
}

export function signPayoutAuthorization(member, args) {
  return signChecked(
    member,
    payoutAuthorizationHash({ ...args, memberRef: member.memberRef }),
    "payout authorization"
  );
}

export function signPayoutSettlement(member, args) {
  return signChecked(
    member,
    payoutSettlementHash({ ...args, memberRef: member.memberRef }),
    "payout settlement"
  );
}

export function signRecoverySettlement(member, args) {
  return signChecked(
    member,
    recoverySettlementHash({ ...args, memberRef: member.memberRef }),
    "recovery settlement"
  );
}

export { feltEq };

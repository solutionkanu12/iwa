// chains/strk20/iwaStrk20Client.ts — IWA operations over the Starknet Wallet API.
//
// Every private operation goes through exactly three wallet methods:
//
//   account.strk20PrepareInvoke(actions, true)  dry run: builds the call with
//                                               an empty proof. Not submittable;
//                                               used to catch a calldata-shape
//                                               mistake before the user signs.
//   account.strk20InvokeTransaction(actions)    submit: the wallet proves and
//                                               sends, and returns the hash.
//   account.strk20Balances(tokens)              shielded balances. Prompts for
//                                               consent, so it is only called
//                                               when the user asks to see them.
//
// The wallet owns the viewing key, note discovery, proof generation, and
// submission. Nothing private reaches this module.

import type { STRK20_ACTION, STRK20_BALANCE_ENTRY, STRK20_CALL_AND_PROOF } from "@starknet-io/types-js";

import { STARKNET_MAINNET } from "../starknetProduction";
import type { ConnectedWallet } from "./walletConnect";
import {
  assertActionsWellFormed,
  buildContributionActions,
  buildPayoutActions,
  buildShieldActions,
  type MemberAuthSigner,
} from "./strk20Actions";

/** Wallet API errors a dapp is expected to handle, not swallow. */
export type Strk20ErrorKind =
  | "NOT_REGISTERED"
  | "INSUFFICIENT_PRIVATE_BALANCE"
  | "PRIVACY_LEAK"
  | "INVALID_REQUEST_PAYLOAD"
  | "USER_REFUSED_OP"
  | "API_VERSION_NOT_SUPPORTED"
  | "UNKNOWN_ERROR";

export class Strk20WalletError extends Error {
  readonly kind: Strk20ErrorKind;
  constructor(kind: Strk20ErrorKind, message: string) {
    super(message);
    this.name = "Strk20WalletError";
    this.kind = kind;
  }
}

const ERROR_COPY: Record<Strk20ErrorKind, string> = {
  // The Wallet API has no registration method: STRK20_ACTION is only
  // deposit | withdraw | transfer | invoke, and there is no wallet_strk20Register.
  // Registration publishes the account's public viewing key to the pool, and
  // only the wallet can do it because only the wallet holds that key.
  // strk20PrepareInvoke merely *builds*, so it can never register — it reports
  // NOT_REGISTERED instead. Register from inside the wallet first.
  NOT_REGISTERED:
    "This account has not registered its viewing key with the STRK20 pool. A dapp cannot register " +
    "on your behalf — the Wallet API has no registration action. Open your wallet and complete its " +
    "own private-balance setup (shield once from inside the wallet), then retry here.",
  INSUFFICIENT_PRIVATE_BALANCE:
    "Not enough shielded balance for this action. Shield more first, and remember new notes take about 10 blocks to mature.",
  PRIVACY_LEAK: "The wallet refused this action because it would leak private information.",
  INVALID_REQUEST_PAYLOAD:
    "The wallet rejected the action payload. This is an application bug, not a wallet problem.",
  USER_REFUSED_OP: "You declined the operation in your wallet.",
  API_VERSION_NOT_SUPPORTED: "This wallet does not support the STRK20 API version IWA requires.",
  UNKNOWN_ERROR: "The wallet reported an unknown error.",
};

/**
 * Renders any rejection as readable text.
 *
 * Wallets reject with JSON-RPC error objects as often as with `Error`
 * instances, and `String({code, message})` yields "[object Object]" — which is
 * how a real failure ends up looking like nothing happened. Every shape is
 * unwrapped here so the UI always has something actionable to show.
 */
export function describeUnknownError(e: unknown): string {
  if (e === null || e === undefined) return "empty rejection (no error value)";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name || "Error with no message";

  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts: string[] = [];
    if (o.code !== undefined) parts.push(`code ${String(o.code)}`);
    if (typeof o.message === "string" && o.message !== "") parts.push(o.message);
    if (typeof o.data === "string" && o.data !== "") parts.push(o.data);
    if (parts.length > 0) return parts.join(": ");
    try {
      return JSON.stringify(e);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  return String(e);
}

/** Maps a raw wallet rejection onto a typed error with copy the UI can show. */
export function toStrk20Error(e: unknown): Strk20WalletError {
  if (e instanceof Strk20WalletError) return e;
  const raw = describeUnknownError(e);
  const kinds: Strk20ErrorKind[] = [
    "NOT_REGISTERED",
    "INSUFFICIENT_PRIVATE_BALANCE",
    "PRIVACY_LEAK",
    "INVALID_REQUEST_PAYLOAD",
    "USER_REFUSED_OP",
    "API_VERSION_NOT_SUPPORTED",
  ];
  const kind = kinds.find((k) => raw.toUpperCase().includes(k)) ?? "UNKNOWN_ERROR";
  return new Strk20WalletError(kind, `${ERROR_COPY[kind]} (${raw})`);
}

/**
 * Confirms the connected account still exposes the STRK20 methods before a
 * call is attempted. A wallet that was swapped, locked, or downgraded after
 * connect otherwise fails deep inside the SDK with an opaque message.
 */
export function assertStrk20Capable(wallet: ConnectedWallet): void {
  const account = wallet.account as unknown as Record<string, unknown>;
  for (const method of ["strk20PrepareInvoke", "strk20InvokeTransaction", "strk20Balances"]) {
    if (typeof account[method] !== "function") {
      throw new Strk20WalletError(
        "API_VERSION_NOT_SUPPORTED",
        `the connected account does not expose ${method} — reconnect the wallet`,
      );
    }
  }
}

export interface Strk20Submission {
  readonly transactionHash: string;
}

/**
 * Dry run. Builds and returns the call with an empty proof — never submittable
 * — so a calldata-shape mistake surfaces before the user is asked to sign a
 * long-running proving operation.
 */
export async function dryRun(
  wallet: ConnectedWallet,
  actions: STRK20_ACTION[],
  onEvent: (message: string) => void = () => {},
): Promise<STRK20_CALL_AND_PROOF> {
  assertActionsWellFormed(actions);
  assertStrk20Capable(wallet);

  onEvent(`calling strk20PrepareInvoke with ${actions.length} action(s), simulate=true`);
  let built: STRK20_CALL_AND_PROOF;
  try {
    built = await wallet.account.strk20PrepareInvoke(actions, true);
  } catch (e) {
    onEvent(`strk20PrepareInvoke rejected: ${describeUnknownError(e)}`);
    throw toStrk20Error(e);
  }

  // A resolved-but-empty result is the failure that looks like success. Treat
  // a missing call as an error rather than rendering an empty preview.
  if (built === null || built === undefined || built.call === undefined) {
    onEvent("strk20PrepareInvoke resolved without a call");
    throw new Strk20WalletError(
      "UNKNOWN_ERROR",
      "the wallet returned no call from strk20PrepareInvoke — nothing to preview",
    );
  }

  onEvent(
    `strk20PrepareInvoke resolved: entry_point=${String(built.call.entry_point ?? "?")}, ` +
      `calldata felts=${built.call.calldata?.length ?? 0}`,
  );
  return built;
}

/**
 * Submits. The wallet shows its own approval UI and may take a long time,
 * because SNIP-36 proof generation happens wallet-side — callers must tolerate
 * a long-running call and must not race it with a timeout.
 */
export async function submit(
  wallet: ConnectedWallet,
  actions: STRK20_ACTION[],
  onEvent: (message: string) => void = () => {},
): Promise<Strk20Submission> {
  assertActionsWellFormed(actions);
  assertStrk20Capable(wallet);

  onEvent(`calling strk20InvokeTransaction with ${actions.length} action(s)`);
  try {
    const { transaction_hash } = await wallet.account.strk20InvokeTransaction(actions);
    if (!transaction_hash) {
      throw new Strk20WalletError("UNKNOWN_ERROR", "the wallet returned no transaction hash");
    }
    onEvent(`submitted ${transaction_hash}`);
    return { transactionHash: transaction_hash };
  } catch (e) {
    onEvent(`strk20InvokeTransaction rejected: ${describeUnknownError(e)}`);
    throw toStrk20Error(e);
  }
}

/**
 * Shielded balances. This prompts the user for consent to read private data,
 * so call it only as a deliberate balance-display feature — never to probe
 * whether a wallet supports STRK20.
 */
export async function shieldedBalances(
  wallet: ConnectedWallet,
  tokens: string[] = [STARKNET_MAINNET.usdcToken, STARKNET_MAINNET.strkToken],
): Promise<STRK20_BALANCE_ENTRY[]> {
  try {
    return await wallet.account.strk20Balances(tokens);
  } catch (e) {
    throw toStrk20Error(e);
  }
}

// --- IWA operations ---

export interface ShieldRequest {
  token?: string;
  amount: string;
}

export async function shield(
  wallet: ConnectedWallet,
  req: ShieldRequest,
  opts: { dryRunOnly?: boolean } = {},
): Promise<Strk20Submission | STRK20_CALL_AND_PROOF> {
  const actions = buildShieldActions({
    token: req.token ?? STARKNET_MAINNET.usdcToken,
    amount: req.amount,
  });
  return opts.dryRunOnly ? dryRun(wallet, actions) : submit(wallet, actions);
}

export interface ContributionRequest {
  circleId: number;
  round: number;
  token?: string;
  amount: string;
  nonce: string;
}

/**
 * One pool transaction: withdraw the obligation to the helper, then invoke it.
 * The member's settlement signature comes from the injected signer, so no key
 * passes through this module.
 */
export async function contribute(
  wallet: ConnectedWallet,
  signer: MemberAuthSigner,
  req: ContributionRequest,
  opts: { dryRunOnly?: boolean } = {},
): Promise<Strk20Submission | STRK20_CALL_AND_PROOF> {
  const token = req.token ?? STARKNET_MAINNET.usdcToken;
  const signature = await signer.signContributionSettlement({
    circleId: req.circleId,
    round: req.round,
    token,
    amount: req.amount,
    nonce: req.nonce,
  });
  const actions = buildContributionActions({
    circleId: req.circleId,
    round: req.round,
    memberRef: signer.memberRef,
    token,
    amount: req.amount,
    nonce: req.nonce,
    signature,
  });
  return opts.dryRunOnly ? dryRun(wallet, actions) : submit(wallet, actions);
}

export interface PayoutRequest {
  circleId: number;
  round: number;
  token?: string;
  amount: string;
  nonce: string;
  /** Public Starknet address the open note is created for. */
  recipient: string;
  /**
   * The payout settlement signature binds the open note id, which only exists
   * once the wallet assembles the transaction. The signer is therefore given
   * the placeholder-resolved id by the caller; when it is not yet known, the
   * dry run is the only safe path.
   */
  openNoteId: string;
}

export async function payout(
  wallet: ConnectedWallet,
  signer: MemberAuthSigner,
  req: PayoutRequest,
  opts: { dryRunOnly?: boolean } = {},
): Promise<Strk20Submission | STRK20_CALL_AND_PROOF> {
  const token = req.token ?? STARKNET_MAINNET.usdcToken;
  const signature = await signer.signPayoutSettlement({
    circleId: req.circleId,
    round: req.round,
    token,
    amount: req.amount,
    nonce: req.nonce,
    openNoteId: req.openNoteId,
  });
  const actions = buildPayoutActions({
    circleId: req.circleId,
    round: req.round,
    memberRef: signer.memberRef,
    token,
    recipient: req.recipient,
    nonce: req.nonce,
    signature,
  });
  return opts.dryRunOnly ? dryRun(wallet, actions) : submit(wallet, actions);
}

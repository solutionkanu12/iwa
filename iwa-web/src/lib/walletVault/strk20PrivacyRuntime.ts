import type { SignerInterface } from "starknet";

import {
  decodePinnedStrk20ServerActions,
  type PinnedStrk20ServerAction,
  type PinnedStrk20ServerActionType,
} from "./strk20PoolActionDecoder";

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * Exact package/revision selected by B0.2 compatibility proof. The boundary is
 * structural so browser code remains buildable without embedding a provider or
 * package credential; the approved SDK adapter is injected by the chain layer.
 */
export const IWA_STRK20_PRIVACY_SDK_PACKAGE = "@starkware-libs/starknet-privacy-sdk";
export const IWA_STRK20_PRIVACY_SDK_VERSION = "0.14.3-rc.5";

export interface Strk20PublicContext {
  readonly walletId: string;
  readonly networkId: string;
  readonly poolAddress: string;
  readonly accountAddress: string;
}

/** Internal only: callers outside the vault must never construct this from UI state. */
export interface Strk20PrivateContext extends Strk20PublicContext {
  readonly account: {
    readonly address: string;
    readonly signer: SignerInterface;
  };
  readonly viewingKey: bigint;
}

export interface Strk20PrivacyCall {
  readonly contractAddress: string;
  readonly entrypoint: string;
  readonly calldata: readonly string[];
}

export interface Strk20PrivacyCallAndProof {
  readonly call: Strk20PrivacyCall;
  readonly proof: {
    readonly data: string;
    readonly proofFacts: readonly string[];
    readonly output: readonly string[];
  };
}

export interface Strk20PrivacyBuilder {
  register(): Strk20PrivacyBuilder;
  invoke(builder: (args: unknown) => Strk20PrivacyCall): Strk20PrivacyBuilder;
  execute(): Promise<{ readonly callAndProof: Strk20PrivacyCallAndProof }>;
}

export interface Strk20PrivacyTransfers {
  build(options?: Record<string, unknown>): Strk20PrivacyBuilder;
  discoverNotes(): Promise<{
    readonly notes: Iterable<readonly [bigint, readonly { readonly amount: bigint }[]]>;
  }>;
}

export interface Strk20PrivacySdkFactory {
  createPrivateTransfers(input: {
    readonly account: { readonly address: string; readonly signer: SignerInterface };
    readonly viewingKeyProvider: { getViewingKey(): Promise<bigint> };
    readonly provingProvider: unknown;
    readonly discoveryProvider: unknown;
    readonly poolContractAddress: string;
  }): Strk20PrivacyTransfers;
}

/** Protocol-local inspection may consume the viewing scalar; it is never an Iwa backend request. */
export type Strk20RegistrationProbe = (context: Strk20PrivateContext) => Promise<boolean>;

/** The signer submits the proof call locally to Starknet; the payload has no viewing scalar. */
export type Strk20ProofSubmitter = (input: {
  readonly context: Strk20PublicContext;
  readonly callAndProof: Strk20PrivacyCallAndProof;
}) => Promise<void>;

export interface IwaStrk20PrivacyRuntimeDependencies {
  readonly sdk: Strk20PrivacySdkFactory;
  readonly provingProvider: unknown;
  readonly discoveryProvider: unknown;
  readonly probeRegistration: Strk20RegistrationProbe;
  readonly submit: Strk20ProofSubmitter;
  /** Chain-adapter only. It is never exposed by the vault or React lifecycle. */
  readonly buildIwaHelperOperation?: (
    transfers: Strk20PrivacyTransfers,
    intent: IwaHelperPrivateInvoke,
  ) => Strk20PrivacyBuilder;
}

export interface Strk20PrivateStateSummary {
  readonly noteCount: number;
  readonly balances: readonly { readonly token: string; readonly amount: string }[];
}

export interface IwaHelperPrivateInvoke {
  readonly walletId: string;
  readonly networkId: string;
  readonly poolAddress: string;
  readonly accountAddress: string;
  readonly helperAddress: string;
  /** The pool hard-codes this selector for an Invoke server action. */
  readonly helperEntrypoint: "privacy_invoke";
  /** Current IwaStrk20Helper IwaOperation discriminant, bound to calldata[0]. */
  readonly operation: 0 | 1 | 2 | 3;
  /** Exact nine-felt IwaStrk20Helper::privacy_invoke argument list. */
  readonly helperCalldata: readonly string[];
  /** Bound to calldata[6], preventing a replacement/replayed Iwa authorization. */
  readonly nonce: string;
  /** The only pool-to-external value movement permitted by this B2-B intent. */
  readonly expectedWithdrawal: { readonly token: string; readonly amount: string };
  /** Optional fresh public funding, always from the active Iwa Starknet account. */
  readonly expectedFunding?: { readonly token: string; readonly amount: string };
  /** Exact ordered transcript of every proof-bound pool action. */
  readonly expectedServerActionTypes: readonly PinnedStrk20ServerActionType[];
}

function fail(): never {
  throw new Error("Iwa STRK20 private-state operation rejected");
}

function assertIdentifier(value: string): void {
  if (value.length === 0 || value.length > 256 || /[|\r\n]/.test(value)) fail();
}

function assertContext(context: Strk20PublicContext): void {
  assertIdentifier(context.walletId);
  assertIdentifier(context.networkId);
  canonicalNonZeroFelt(context.poolAddress);
  canonicalNonZeroFelt(context.accountAddress);
}

function canonicalFelt(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail();
  try {
    const felt = BigInt(value);
    if (felt < 0n || felt >= STARK_FIELD_PRIME) fail();
    return `0x${felt.toString(16)}`;
  } catch {
    fail();
  }
}

function canonicalNonZeroFelt(value: string): string {
  const felt = canonicalFelt(value);
  if (felt === "0x0") fail();
  return felt;
}

function canonicalFeltArray(value: readonly unknown[], maxLength: number): readonly string[] {
  if (value.length > maxLength) fail();
  return value.map((felt) => {
    if (typeof felt !== "string") fail();
    return canonicalFelt(felt);
  });
}

function sameFelts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((felt, index) => felt === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertScreeningSuffix(value: readonly string[]): void {
  // v0.14.3-rc.5 encodes ScreeningAttestation as Option: None is [0x1];
  // Some is [0x0, issued_at:u64, sig_r, sig_s]. It is outside the proof
  // action span and cannot alter the decoded helper action.
  if (value.length === 1 && value[0] === "0x1") return;
  if (value.length !== 4 || value[0] !== "0x0") fail();
  const issuedAt = BigInt(canonicalFelt(value[1] ?? ""));
  if (issuedAt > 0xffff_ffff_ffff_ffffn) fail();
  canonicalFelt(value[2] ?? "");
  canonicalFelt(value[3] ?? "");
}

function assertHelperIntent(intent: IwaHelperPrivateInvoke): {
  readonly helperAddress: string;
  readonly helperCalldata: readonly string[];
  readonly expectedWithdrawal: { readonly token: string; readonly amount: string };
  readonly expectedFunding: { readonly token: string; readonly amount: string } | undefined;
  readonly expectedServerActionTypes: readonly PinnedStrk20ServerActionType[];
} {
  if (intent.helperEntrypoint !== "privacy_invoke") fail();
  const helperAddress = canonicalNonZeroFelt(intent.helperAddress);
  const helperCalldata = canonicalFeltArray(intent.helperCalldata, 9);
  if (helperCalldata.length !== 9 || helperCalldata[0] !== `0x${intent.operation.toString(16)}`) fail();
  if (helperCalldata[6] !== canonicalFelt(intent.nonce)) fail();
  const expectedWithdrawal = {
    token: canonicalNonZeroFelt(intent.expectedWithdrawal.token),
    amount: canonicalNonZeroFelt(intent.expectedWithdrawal.amount),
  };
  if (helperCalldata[4] !== expectedWithdrawal.token) fail();
  const expectedFunding = intent.expectedFunding === undefined
    ? undefined
    : {
      token: canonicalNonZeroFelt(intent.expectedFunding.token),
      amount: canonicalNonZeroFelt(intent.expectedFunding.amount),
    };
  if (intent.expectedServerActionTypes.length === 0 || intent.expectedServerActionTypes.length > 128) fail();
  const expectedServerActionTypes = intent.expectedServerActionTypes.map((type) => {
    if (![
      "WriteOnce",
      "Append",
      "TransferFrom",
      "TransferTo",
      "EmitViewingKeySet",
      "EmitWithdrawal",
      "EmitDeposit",
      "EmitOpenNoteCreated",
      "EmitEncNoteCreated",
      "EmitNoteUsed",
      "Invoke",
      "InvokeWithComputation",
    ].includes(type)) {
      fail();
    }
    return type;
  });
  return { helperAddress, helperCalldata, expectedWithdrawal, expectedFunding, expectedServerActionTypes };
}

function assertPoolEnvelope(
  callAndProof: Strk20PrivacyCallAndProof,
  context: Strk20PublicContext,
): readonly PinnedStrk20ServerAction[] {
  if (
    canonicalNonZeroFelt(callAndProof.call.contractAddress) !== canonicalNonZeroFelt(context.poolAddress) ||
    callAndProof.call.entrypoint !== "apply_actions"
  ) {
    fail();
  }
  const output = canonicalFeltArray(callAndProof.proof.output, 8_193);
  if (output.length < 2) fail();
  canonicalNonZeroFelt(output[0] ?? ""); // pool class hash, proof-bound on chain
  const actionSpan = output.slice(1);
  const submitted = canonicalFeltArray(callAndProof.call.calldata, 8_197);
  if (!sameFelts(submitted.slice(0, actionSpan.length), actionSpan)) fail();
  assertScreeningSuffix(submitted.slice(actionSpan.length));
  return decodePinnedStrk20ServerActions(actionSpan);
}

function assertBoundIwaHelperAction(
  actions: readonly PinnedStrk20ServerAction[],
  context: Strk20PublicContext,
  intent: IwaHelperPrivateInvoke,
): void {
  const expected = assertHelperIntent(intent);
  if (actions.length === 0 || actions.length > 128) fail();
  if (!sameStrings(actions.map((action) => action.type), expected.expectedServerActionTypes)) fail();

  const externalInvocations: Array<{ readonly index: number; readonly action: Extract<PinnedStrk20ServerAction, { readonly type: "Invoke" | "InvokeWithComputation" }> }> = [];
  const transferFrom: Array<{ readonly index: number; readonly action: Extract<PinnedStrk20ServerAction, { readonly type: "TransferFrom" }> }> = [];
  const transferTo: Array<{ readonly index: number; readonly action: Extract<PinnedStrk20ServerAction, { readonly type: "TransferTo" }> }> = [];
  actions.forEach((action, index) => {
    if (action.type === "Invoke" || action.type === "InvokeWithComputation") externalInvocations.push({ index, action });
    if (action.type === "TransferFrom") transferFrom.push({ index, action });
    if (action.type === "TransferTo") transferTo.push({ index, action });
  });

  // The pool has a single invoke phase. Iwa permits exactly one Invoke, never
  // the distinct computation entrypoint, and it must target this helper.
  if (externalInvocations.length !== 1 || externalInvocations[0]?.action.type !== "Invoke") fail();
  const invoke = externalInvocations[0];
  if (
    invoke === undefined ||
    invoke.action.contractAddress !== expected.helperAddress ||
    !sameFelts(invoke.action.calldata, expected.helperCalldata)
  ) {
    fail();
  }

  // IwaStrk20Helper expects its exact inbound balance before the invocation.
  // Reject all other pool transfers, including a substituted recipient/token or
  // a second transfer that would make a visually similar proof spend more.
  if (transferTo.length !== 1) fail();
  const withdrawal = transferTo[0];
  if (
    withdrawal === undefined ||
    withdrawal.action.toAddress !== expected.helperAddress ||
    withdrawal.action.token !== expected.expectedWithdrawal.token ||
    withdrawal.action.amount !== expected.expectedWithdrawal.amount ||
    withdrawal.index >= invoke.index
  ) {
    fail();
  }

  if (expected.expectedFunding === undefined) {
    if (transferFrom.length !== 0) fail();
  } else {
    if (transferFrom.length !== 1) fail();
    const funding = transferFrom[0];
    if (
      funding === undefined ||
      funding.action.fromAddress !== canonicalNonZeroFelt(context.accountAddress) ||
      funding.action.token !== expected.expectedFunding.token ||
      funding.action.amount !== expected.expectedFunding.amount ||
      funding.index >= withdrawal.index
    ) {
      fail();
    }
  }
}

function publicContext(context: Strk20PrivateContext): Strk20PublicContext {
  return {
    walletId: context.walletId,
    networkId: context.networkId,
    poolAddress: context.poolAddress,
    accountAddress: context.accountAddress,
  };
}

function samePublicContext(left: Strk20PublicContext, right: Strk20PublicContext): boolean {
  return left.walletId === right.walletId &&
    left.networkId === right.networkId &&
    left.poolAddress === right.poolAddress &&
    left.accountAddress === right.accountAddress;
}

function assertCallAndProof(value: unknown): asserts value is Strk20PrivacyCallAndProof {
  if (typeof value !== "object" || value === null) fail();
  const result = value as { readonly callAndProof?: unknown };
  const callAndProof = result.callAndProof;
  if (typeof callAndProof !== "object" || callAndProof === null) fail();
  const record = callAndProof as { readonly call?: unknown; readonly proof?: unknown };
  if (typeof record.call !== "object" || record.call === null || typeof record.proof !== "object" || record.proof === null) fail();
  const call = record.call as Partial<Strk20PrivacyCall>;
  const proof = record.proof as Partial<Strk20PrivacyCallAndProof["proof"]>;
  if (
    typeof call.contractAddress !== "string" ||
    typeof call.entrypoint !== "string" ||
    !Array.isArray(call.calldata) ||
    typeof proof.data !== "string" ||
    !Array.isArray(proof.proofFacts) ||
    !Array.isArray(proof.output)
  ) {
    fail();
  }
}

/**
 * Bounded direct-SDK runtime. It knows neither browser storage nor Iwa account
 * APIs. A caller must already have the vault's private capability to supply a
 * `Strk20PrivateContext`.
 */
export class IwaStrk20PrivacyRuntime {
  constructor(private readonly dependencies: IwaStrk20PrivacyRuntimeDependencies) {}

  async ensureRegistered(context: Strk20PrivateContext): Promise<{ readonly registration: "submitted" | "alreadyRegistered" }> {
    assertContext(context);
    if (context.account.address !== context.accountAddress || context.viewingKey <= 0n) fail();
    if (await this.dependencies.probeRegistration(context)) return { registration: "alreadyRegistered" };

    const transfers = this.transfersFor(context);
    const result = await transfers.build().register().execute();
    assertCallAndProof(result);
    await this.dependencies.submit({ context: publicContext(context), callAndProof: result.callAndProof });
    return { registration: "submitted" };
  }

  async discover(context: Strk20PrivateContext): Promise<Strk20PrivateStateSummary> {
    assertContext(context);
    if (context.account.address !== context.accountAddress || context.viewingKey <= 0n) fail();
    if (!(await this.dependencies.probeRegistration(context))) fail();
    const discovered = await this.transfersFor(context).discoverNotes();
    if (typeof discovered !== "object" || discovered === null || discovered.notes === undefined) fail();

    const balances = new Map<bigint, bigint>();
    let noteCount = 0;
    for (const entry of discovered.notes) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "bigint" || !Array.isArray(entry[1])) fail();
      for (const note of entry[1]) {
        if (typeof note !== "object" || note === null || typeof note.amount !== "bigint" || note.amount < 0n) fail();
        balances.set(entry[0], (balances.get(entry[0]) ?? 0n) + note.amount);
        noteCount += 1;
      }
    }
    return {
      noteCount,
      balances: [...balances.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([token, amount]) => ({ token: `0x${token.toString(16)}`, amount: amount.toString(10) })),
    };
  }

  async invokeIwaHelper(context: Strk20PrivateContext, intent: IwaHelperPrivateInvoke): Promise<void> {
    assertContext(context);
    if (!samePublicContext(publicContext(context), intent)) fail();
    if (!(await this.dependencies.probeRegistration(context))) fail();
    if (this.dependencies.buildIwaHelperOperation === undefined) fail();
    const builder = this.dependencies.buildIwaHelperOperation(this.transfersFor(context), intent);
    const result = await builder.execute();
    assertCallAndProof(result);
    const actions = assertPoolEnvelope(result.callAndProof, publicContext(context));
    assertBoundIwaHelperAction(actions, publicContext(context), intent);
    await this.dependencies.submit({ context: publicContext(context), callAndProof: result.callAndProof });
  }

  private transfersFor(context: Strk20PrivateContext): Strk20PrivacyTransfers {
    return this.dependencies.sdk.createPrivateTransfers({
      // This is the exact SDK direct-user shape proven in B0.1/B0.2. No
      // WalletAccountV6, injected extension, or wallet API enters this path.
      account: { address: context.account.address, signer: context.account.signer },
      viewingKeyProvider: { getViewingKey: async () => context.viewingKey },
      provingProvider: this.dependencies.provingProvider,
      discoveryProvider: this.dependencies.discoveryProvider,
      poolContractAddress: context.poolAddress,
    });
  }
}

import type { SignerInterface } from "starknet";

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
  readonly calldata: readonly unknown[];
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
  /** Internal chain adapter callback, never a UI-supplied arbitrary call. */
  readonly build: (builder: Strk20PrivacyBuilder) => Strk20PrivacyBuilder;
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
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(context.poolAddress) || !/^0x[0-9a-fA-F]{1,64}$/.test(context.accountAddress)) fail();
}

function canonicalFelt(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail();
  try {
    const felt = BigInt(value);
    if (felt <= 0n) fail();
    return `0x${felt.toString(16)}`;
  } catch {
    fail();
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
    if (!samePublicContext(publicContext(context), intent) || !/^0x[0-9a-fA-F]{1,64}$/.test(intent.helperAddress)) fail();
    if (!(await this.dependencies.probeRegistration(context))) fail();
    const builder = intent.build(this.transfersFor(context).build({
      autoDiscover: { notes: "refresh", channels: "refresh" },
      autoSelectNotes: "naive",
    }));
    const result = await builder.execute();
    assertCallAndProof(result);
    // The B2-B helper seam is deliberately not an arbitrary private-call
    // facility. Even a chain-layer caller cannot redirect this proof to a
    // different contract or entrypoint. B2-C may add a reviewed fixed intent,
    // but must not loosen this boundary into a UI-supplied transaction.
    if (
      canonicalFelt(result.callAndProof.call.contractAddress) !== canonicalFelt(intent.helperAddress) ||
      result.callAndProof.call.entrypoint !== "privacy_invoke"
    ) {
      fail();
    }
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

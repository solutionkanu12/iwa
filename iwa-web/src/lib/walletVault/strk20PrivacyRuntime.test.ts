import { CairoOption, CairoOptionVariant, CallData, CairoCustomEnum } from "starknet";
import { describe, expect, it, vi } from "vitest";

import { PrivacyPoolABI } from "../../../../scripts/demo/vendor/starknet-privacy-sdk/dist/internal/abi.js";

import {
  IwaStrk20PrivacyRuntime,
  type IwaHelperPrivateInvoke,
  type Strk20PrivacySdkFactory,
} from "./strk20PrivacyRuntime";

const context = {
  walletId: "wallet-strk20-runtime",
  networkId: "SN_IWA_DEVNET",
  poolAddress: "0xaaaa",
  accountAddress: "0x5678",
  account: { address: "0x5678", signer: {} as never },
  viewingKey: 19n,
};

const poolDecoder = new CallData(PrivacyPoolABI);
const helperCalldata = ["0x0", "0x1", "0x2", "0x3", "0x7777", "0x0", "0x6", "0x7", "0x8"];

type HelperServerAction = "TransferFrom" | "TransferTo" | "EmitDeposit" | "Invoke" | "InvokeWithComputation";

function serverAction(variant: HelperServerAction, input: Record<string, unknown>): CairoCustomEnum {
  return new CairoCustomEnum({
    WriteOnce: undefined,
    Append: undefined,
    TransferFrom: variant === "TransferFrom" ? input : undefined,
    TransferTo: variant === "TransferTo" ? input : undefined,
    EmitViewingKeySet: undefined,
    EmitWithdrawal: undefined,
    EmitDeposit: variant === "EmitDeposit" ? input : undefined,
    EmitOpenNoteCreated: undefined,
    EmitEncNoteCreated: undefined,
    EmitNoteUsed: undefined,
    Invoke: variant === "Invoke" ? input : undefined,
    InvokeWithComputation: variant === "InvokeWithComputation" ? input : undefined,
  });
}

function validServerActions(): CairoCustomEnum[] {
  return [
    serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7777n, amount: 9n }),
    serverAction("Invoke", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) }),
  ];
}

function genuineHelperPoolResult(options: {
  actions?: CairoCustomEnum[];
  outerAddress?: string;
  outerEntrypoint?: string;
} = {}) {
  const callCalldata = poolDecoder.compile("apply_actions", [
    options.actions ?? validServerActions(),
    new CairoOption(CairoOptionVariant.None),
  ]).map((felt) => `0x${BigInt(felt).toString(16)}`);
  return {
    callAndProof: {
      call: {
        contractAddress: options.outerAddress ?? context.poolAddress,
        entrypoint: options.outerEntrypoint ?? "apply_actions",
        calldata: callCalldata,
      },
      proof: { data: "proof", proofFacts: ["fact"], output: ["0xc1a55", ...callCalldata.slice(0, -1)] },
    },
  };
}

function helperIntent(overrides: Partial<IwaHelperPrivateInvoke> = {}): IwaHelperPrivateInvoke {
  return {
    walletId: context.walletId,
    networkId: context.networkId,
    poolAddress: context.poolAddress,
    accountAddress: context.accountAddress,
    helperAddress: "0x9876",
    helperEntrypoint: "privacy_invoke",
    operation: 0,
    helperCalldata,
    nonce: "0x6",
    expectedWithdrawal: { token: "0x7777", amount: "0x9" },
    expectedServerActionTypes: ["TransferTo", "Invoke"],
    ...overrides,
  };
}

function fakeSdk(options: {
  registered: boolean;
  notes?: Map<bigint, Array<{ amount: bigint }>>;
  executeResult?: ReturnType<typeof genuineHelperPoolResult>;
}) {
  const register = vi.fn(function register() {
    return builder;
  });
  const invoke = vi.fn(function invoke() {
    return builder;
  });
  const execute = vi.fn(async () => options.executeResult ?? ({
    callAndProof: {
      call: { contractAddress: "0x1234", entrypoint: "privacy_invoke", calldata: [] },
      proof: { data: "proof", proofFacts: ["fact"], output: [] },
    },
  }));
  const builder = { register, invoke, execute };
  const transfers = {
    build: vi.fn(() => builder),
    discoverNotes: vi.fn(async () => ({ notes: options.notes ?? new Map() })),
  };
  const createPrivateTransfers = vi.fn((_: Parameters<Strk20PrivacySdkFactory["createPrivateTransfers"]>[0]) => transfers);
  const factory: Strk20PrivacySdkFactory = { createPrivateTransfers };
  return { factory, createPrivateTransfers, transfers, register, invoke, execute };
}

function helperRuntime(result = genuineHelperPoolResult()) {
  const sdk = fakeSdk({ registered: true, executeResult: result });
  const submit = vi.fn(async () => undefined);
  const runtime = new IwaStrk20PrivacyRuntime({
    sdk: sdk.factory,
    provingProvider: {},
    discoveryProvider: {},
    probeRegistration: async () => true,
    submit,
    buildIwaHelperOperation: (transfers) => transfers.build().invoke(() => ({
      contractAddress: "0x9876",
      entrypoint: "privacy_invoke",
      calldata: helperCalldata,
    })),
  });
  return { runtime, submit, sdk };
}

describe("Iwa STRK20 direct SDK runtime", () => {
  it("uses the SDK direct { address, signer } route for registration and never an injected wallet route", async () => {
    const sdk = fakeSdk({ registered: false });
    const submit = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    const runtime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: { testOnly: true },
      discoveryProvider: { testOnly: true },
      probeRegistration: probe,
      submit,
    });

    const result = await runtime.ensureRegistered(context);

    expect(result).toEqual({ registration: "submitted" });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: context.accountAddress,
    }));
    expect(sdk.createPrivateTransfers).toHaveBeenCalledTimes(1);
    const params = sdk.createPrivateTransfers.mock.calls[0]?.[0];
    expect(params?.account).toEqual(context.account);
    expect(await params?.viewingKeyProvider.getViewingKey()).toBe(19n);
    expect(params?.poolContractAddress).toBe(context.poolAddress);
    expect(sdk.register).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        walletId: context.walletId,
        networkId: context.networkId,
        poolAddress: context.poolAddress,
        accountAddress: context.accountAddress,
      }),
    }));
  });

  it("does not submit a duplicate registration when a protocol probe confirms the persisted identity", async () => {
    const sdk = fakeSdk({ registered: true, executeResult: genuineHelperPoolResult() });
    const submit = vi.fn(async () => undefined);
    const runtime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: {},
      discoveryProvider: {},
      probeRegistration: async () => true,
      submit,
    });

    await expect(runtime.ensureRegistered(context)).resolves.toEqual({ registration: "alreadyRegistered" });
    expect(sdk.createPrivateTransfers).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns a minimized private-state summary without returning notes or the viewing key", async () => {
    const sdk = fakeSdk({
      registered: true,
      notes: new Map([
        [0x1n, [{ amount: 2n }, { amount: 3n }]],
        [0x2n, [{ amount: 7n }]],
      ]),
    });
    const runtime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: {},
      discoveryProvider: {},
      probeRegistration: async () => true,
      submit: async () => undefined,
    });

    await expect(runtime.discover(context)).resolves.toEqual({
      noteCount: 3,
      balances: [
        { token: "0x1", amount: "5" },
        { token: "0x2", amount: "7" },
      ],
    });

    const wrongViewingRuntime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: {},
      discoveryProvider: {},
      probeRegistration: async (candidate) => candidate.viewingKey === context.viewingKey,
      submit: async () => undefined,
    });
    await expect(wrongViewingRuntime.discover({ ...context, viewingKey: 20n })).rejects.toThrow();
  });

  it("binds an Iwa helper private-invoke intent to its exact wallet, account, network, pool, and helper context", async () => {
    const sdk = fakeSdk({ registered: true, executeResult: genuineHelperPoolResult() });
    const submit = vi.fn(async () => undefined);
    const runtime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: {},
      discoveryProvider: {},
      probeRegistration: async () => true,
      submit,
      buildIwaHelperOperation: (transfers) => transfers.build().invoke(() => ({
        contractAddress: "0x9876",
        entrypoint: "privacy_invoke",
        calldata: helperCalldata,
      })),
    });

    await runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: context.accountAddress,
      helperAddress: "0x9876",
      helperEntrypoint: "privacy_invoke",
      operation: 0,
      helperCalldata,
      nonce: "0x6",
      expectedWithdrawal: { token: "0x7777", amount: "0x9" },
      expectedServerActionTypes: ["TransferTo", "Invoke"],
    });

    expect(sdk.invoke).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: "0x9998",
      helperAddress: "0x9876",
      helperEntrypoint: "privacy_invoke",
      operation: 0,
      helperCalldata,
      nonce: "0x6",
      expectedWithdrawal: { token: "0x7777", amount: "0x9" },
      expectedServerActionTypes: ["TransferTo", "Invoke"],
    })).rejects.toThrow();

    await expect(runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: context.accountAddress,
      helperAddress: "0x9999",
      helperEntrypoint: "privacy_invoke",
      operation: 0,
      helperCalldata,
      nonce: "0x6",
      expectedWithdrawal: { token: "0x7777", amount: "0x9" },
      expectedServerActionTypes: ["TransferTo", "Invoke"],
    })).rejects.toThrow();
  });
});

describe("Iwa STRK20 helper proof intent binding", () => {
  it("accepts only the canonical pool.apply_actions proof containing the exact helper intent", async () => {
    const harness = helperRuntime();

    await expect(harness.runtime.invokeIwaHelper(context, helperIntent())).resolves.toBeUndefined();
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a pool address substitution", async () => {
    const harness = helperRuntime(genuineHelperPoolResult({ outerAddress: "0xbbbb" }));
    await expect(harness.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("rejects a substituted helper address or computation entrypoint", async () => {
    const wrongHelper = helperRuntime(genuineHelperPoolResult({
      actions: [
        serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7777n, amount: 9n }),
        serverAction("Invoke", { contract_address: 0x4444n, calldata: helperCalldata.map(BigInt) }),
      ],
    }));
    await expect(wrongHelper.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const wrongEntrypoint = helperRuntime(genuineHelperPoolResult({
      actions: [
        serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7777n, amount: 9n }),
        serverAction("InvokeWithComputation", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) }),
      ],
    }));
    await expect(wrongEntrypoint.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
  });

  it("rejects modified helper calldata, recipient, token, or amount", async () => {
    const cases = [
      genuineHelperPoolResult({ actions: [
        serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7777n, amount: 9n }),
        serverAction("Invoke", { contract_address: 0x9876n, calldata: [0n, 1n, 2n, 3n, 0x7777n, 0n, 6n, 7n, 9n] }),
      ] }),
      genuineHelperPoolResult({ actions: [
        serverAction("TransferTo", { to_addr: 0xdeadn, token: 0x7777n, amount: 9n }),
        serverAction("Invoke", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) }),
      ] }),
      genuineHelperPoolResult({ actions: [
        serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7778n, amount: 9n }),
        serverAction("Invoke", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) }),
      ] }),
      genuineHelperPoolResult({ actions: [
        serverAction("TransferTo", { to_addr: 0x9876n, token: 0x7777n, amount: 10n }),
        serverAction("Invoke", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) }),
      ] }),
    ];

    for (const result of cases) {
      const harness = helperRuntime(result);
      await expect(harness.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
      expect(harness.submit).not.toHaveBeenCalled();
    }
  });

  it("rejects an account-context substitution and an unapproved fresh funding transfer", async () => {
    const harness = helperRuntime();
    await expect(harness.runtime.invokeIwaHelper(context, helperIntent({ accountAddress: "0x9999" }))).rejects.toThrow();

    const extraFunding = helperRuntime(genuineHelperPoolResult({
      actions: [
        serverAction("TransferFrom", { from_addr: 0x5678n, token: 0x7777n, amount: 9n }),
        ...validServerActions(),
      ],
    }));
    await expect(extraFunding.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
  });

  it("rejects additional or duplicate helper invokes", async () => {
    const duplicate = helperRuntime(genuineHelperPoolResult({
      actions: [...validServerActions(), serverAction("Invoke", { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) })],
    }));
    await expect(duplicate.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const extraHelper = helperRuntime(genuineHelperPoolResult({
      actions: [...validServerActions(), serverAction("Invoke", { contract_address: 0x4444n, calldata: helperCalldata.map(BigInt) })],
    }));
    await expect(extraHelper.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
  });

  it("rejects an unexpected or reordered proof-bound action transcript", async () => {
    const extraPassive = helperRuntime(genuineHelperPoolResult({
      actions: [
        serverAction("EmitDeposit", { user_addr: 0x5678n, token: 0x7777n, amount: 9n }),
        ...validServerActions(),
      ],
    }));
    await expect(extraPassive.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const exactPassive = helperRuntime(genuineHelperPoolResult({
      actions: [
        serverAction("EmitDeposit", { user_addr: 0x5678n, token: 0x7777n, amount: 9n }),
        ...validServerActions(),
      ],
    }));
    await expect(exactPassive.runtime.invokeIwaHelper(context, helperIntent({
      expectedServerActionTypes: ["EmitDeposit", "TransferTo", "Invoke"],
    }))).resolves.toBeUndefined();
  });

  it("rejects truncated, malformed, and unknown server-action encodings", async () => {
    const base = genuineHelperPoolResult();
    const truncated = {
      callAndProof: {
        ...base.callAndProof,
        call: { ...base.callAndProof.call, calldata: base.callAndProof.call.calldata.slice(0, -2) },
        proof: { ...base.callAndProof.proof, output: base.callAndProof.proof.output.slice(0, -1) },
      },
    };
    await expect(helperRuntime(truncated).runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const malformedOutput = [...base.callAndProof.proof.output];
    malformedOutput[2] = "not-a-felt";
    await expect(helperRuntime({
      callAndProof: { ...base.callAndProof, proof: { ...base.callAndProof.proof, output: malformedOutput } },
    }).runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const unknownOutput = [...base.callAndProof.proof.output];
    const unknownCalldata = [...base.callAndProof.call.calldata];
    unknownOutput[2] = "0xc";
    unknownCalldata[1] = "0xc";
    await expect(helperRuntime({
      callAndProof: {
        ...base.callAndProof,
        call: { ...base.callAndProof.call, calldata: unknownCalldata },
        proof: { ...base.callAndProof.proof, output: unknownOutput },
      },
    }).runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const malformedScreening = {
      callAndProof: {
        ...base.callAndProof,
        call: { ...base.callAndProof.call, calldata: [...base.callAndProof.call.calldata.slice(0, -1), "0x0"] },
      },
    };
    await expect(helperRuntime(malformedScreening).runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
  });

  it("rejects a proof envelope containing a value outside the Stark field", async () => {
    const base = genuineHelperPoolResult();
    const nonFeltClassHash = {
      callAndProof: {
        ...base.callAndProof,
        proof: {
          ...base.callAndProof.proof,
          output: ["0x8000000000000000000000000000000000000000000000000000000000000000", ...base.callAndProof.proof.output.slice(1)],
        },
      },
    };
    const harness = helperRuntime(nonFeltClassHash);
    await expect(harness.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("rejects a reordered helper invocation and a direct helper outer call", async () => {
    const reordered = helperRuntime(genuineHelperPoolResult({
      actions: [validServerActions()[1]!, validServerActions()[0]!],
    }));
    await expect(reordered.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();

    const directOuter = helperRuntime(genuineHelperPoolResult({
      outerAddress: "0x9876",
      outerEntrypoint: "privacy_invoke",
    }));
    await expect(directOuter.runtime.invokeIwaHelper(context, helperIntent())).rejects.toThrow();
  });
});

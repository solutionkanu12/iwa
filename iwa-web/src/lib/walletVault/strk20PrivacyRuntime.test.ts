import { describe, expect, it, vi } from "vitest";

import {
  IwaStrk20PrivacyRuntime,
  type Strk20PrivacySdkFactory,
} from "./strk20PrivacyRuntime";

const context = {
  walletId: "wallet-strk20-runtime",
  networkId: "SN_IWA_DEVNET",
  poolAddress: "0x1234",
  accountAddress: "0x5678",
  account: { address: "0x5678", signer: {} as never },
  viewingKey: 19n,
};

function fakeSdk(options: { registered: boolean; notes?: Map<bigint, Array<{ amount: bigint }>> }) {
  const register = vi.fn(function register() {
    return builder;
  });
  const invoke = vi.fn(function invoke() {
    return builder;
  });
  const execute = vi.fn(async () => ({
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
    const sdk = fakeSdk({ registered: true });
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
    const sdk = fakeSdk({ registered: true });
    const submit = vi.fn(async () => undefined);
    const runtime = new IwaStrk20PrivacyRuntime({
      sdk: sdk.factory,
      provingProvider: {},
      discoveryProvider: {},
      probeRegistration: async () => true,
      submit,
    });

    await runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: context.accountAddress,
      helperAddress: "0x1234",
      build: (builder) => builder.invoke(() => ({
        contractAddress: "0x1234",
        entrypoint: "privacy_invoke",
        calldata: ["0x1"],
      })),
    });

    expect(sdk.invoke).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: "0x9998",
      helperAddress: "0x1234",
      build: (builder) => builder,
    })).rejects.toThrow();

    await expect(runtime.invokeIwaHelper(context, {
      walletId: context.walletId,
      networkId: context.networkId,
      poolAddress: context.poolAddress,
      accountAddress: context.accountAddress,
      helperAddress: "0x9999",
      build: (builder) => builder.invoke(() => ({
        contractAddress: "0x1234",
        entrypoint: "privacy_invoke",
        calldata: [],
      })),
    })).rejects.toThrow();
  });
});

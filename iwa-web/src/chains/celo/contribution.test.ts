import { describe, expect, it } from "vitest";
import { fromDataSuffix } from "@celo/attribution-tags";

import { ContributionHistory } from "../../core/contributionHistory";
import { standingFrom } from "../../lib/standing";
import type { Circle, ContributionObligation } from "../../core/domain/types";
import { IwaSavingsAgent } from "../../core/savingsAgent";
import { CeloContributionService, type CeloCircleBinding } from "./contribution";
import { encodeContribute } from "./circleCalldata";
import { CNGN_MAINNET, IWA_CELO_ATTRIBUTION_TAG } from "./config";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";

const TAG = "celo_448874a99d90";
const PAYER = "0x00000000000000000000000000000000000000aa";
const CIRCLE = "0x00000000000000000000000000000000000000bb";
const OTHER = "0x00000000000000000000000000000000000000cc";
const AMOUNT = "5000000";

const circle: Circle = {
  id: "circle-1",
  asset: "USDC",
  contributionAmount: AMOUNT,
  cadenceSeconds: 604_800,
  gracePeriodSeconds: 86_400,
  memberLimit: 3,
  currentRound: 1,
  status: "ACTIVE",
  payoutOrder: ["m1", "m2", "m3"],
};

const obligation: ContributionObligation = {
  circleId: "circle-1",
  round: 1,
  memberRef: "m1",
  dueAt: 1_000,
  graceEndsAt: 2_000,
  status: "PENDING",
};

function binding(extra: Partial<CeloCircleBinding> = {}): CeloCircleBinding {
  return {
    circleId: "circle-1",
    chainId: 42220,
    token: CNGN_MAINNET.address,
    circleContract: CIRCLE,
    contributionAmount: AMOUNT,
    ...extra,
  };
}

function mockProvider(opts: {
  chainId?: string;
  balance?: bigint;
  allowance?: bigint;
  sendError?: Error;
  receiptStatus?: string | null;
} = {}) {
  const sends: { method: string; params?: unknown }[] = [];
  const provider: CeloProviderLike & { sends: typeof sends } = {
    sends,
    async request(args: { method: string; params?: unknown[] | object }) {
      if (args.method === "eth_chainId") return opts.chainId ?? "0xa4ec";
      if (args.method === "eth_call") {
        const tx = (args.params as { data: string }[])[0];
        const selector = tx.data.slice(0, 10);
        const value =
          selector === "0x70a08231"
            ? (opts.balance ?? 10_000_000n)
            : (opts.allowance ?? 0n);
        return "0x" + value.toString(16).padStart(64, "0");
      }
      if (args.method === "eth_sendTransaction") {
        if (opts.sendError) throw opts.sendError;
        sends.push(args);
        return "0x" + "ab".repeat(32);
      }
      if (args.method === "eth_getTransactionReceipt") {
        if (opts.receiptStatus === null) return null;
        return {
          status: opts.receiptStatus ?? "0x1",
          transactionHash: (args.params as string[])[0],
        };
      }
      throw new Error(`unexpected ${args.method}`);
    },
  };
  return provider;
}

function sentTx(provider: ReturnType<typeof mockProvider>, index = 0) {
  return (provider.sends[index]?.params as { to: string; data: string }[])[0];
}

function codes(data: string): string[] {
  return fromDataSuffix(data as `0x${string}`)?.codes ?? [];
}

describe("Celo cNGN contribution to IwaCircleCelo", () => {
  it("binds the circle contract, tags contribute() exactly once, and records standing", async () => {
    const inner = mockProvider({ balance: 10_000_000n, allowance: 10_000_000n });
    const history = new ContributionHistory();
    const service = new CeloContributionService(binding(), inner, history);
    const prepared = await service.prepare(circle, obligation, PAYER);
    expect(prepared.amount).toBe(AMOUNT);
    expect(prepared.circleContract).toBe(normalizeAddress(CIRCLE));
    expect(prepared.requiresOnChainApproval).toBe(false);

    const settled = await service.submit(
      circle,
      obligation,
      prepared,
      { confirmed: true, actionId: prepared.action.actionId },
      900,
    );
    expect(settled.status).toBe("ON_TIME");
    expect(history.list()).toHaveLength(1);
    expect(standingFrom(history.standingOutcomes()).onTimeCount).toBe(1);

    const tx = sentTx(inner);
    expect(tx.to.toLowerCase()).toBe(CIRCLE.toLowerCase());
    expect(tx.data.startsWith(encodeContribute())).toBe(true);
    expect(codes(tx.data).filter((c) => c === TAG)).toEqual([TAG]);
    expect(IWA_CELO_ATTRIBUTION_TAG).toBe(TAG);
  });

  it("approves the circle contract then calls contribute when allowance is short", async () => {
    const inner = mockProvider({ allowance: 0n, balance: 10_000_000n });
    const service = new CeloContributionService(binding(), inner, new ContributionHistory());
    const prepared = await service.prepare(circle, obligation, PAYER);
    expect(prepared.requiresOnChainApproval).toBe(true);
    await service.submit(
      circle,
      obligation,
      prepared,
      { confirmed: true, actionId: prepared.action.actionId },
      900,
    );
    expect(inner.sends).toHaveLength(2);
    expect(sentTx(inner, 0).to.toLowerCase()).toBe(CNGN_MAINNET.address.toLowerCase());
    expect(sentTx(inner, 0).data.startsWith("0x095ea7b3")).toBe(true);
    expect(sentTx(inner, 1).to.toLowerCase()).toBe(CIRCLE.toLowerCase());
    expect(sentTx(inner, 1).data.startsWith(encodeContribute())).toBe(true);
    expect(codes(sentTx(inner, 0).data).filter((c) => c === TAG)).toHaveLength(1);
    expect(codes(sentTx(inner, 1).data).filter((c) => c === TAG)).toHaveLength(1);
  });

  it("rejects the wrong chain before any send", async () => {
    const inner = mockProvider({ chainId: "0xaa36a7" });
    const service = new CeloContributionService(binding(), inner, new ContributionHistory());
    await expect(service.readBalance(PAYER)).rejects.toThrow(/Celo mainnet/);
    expect(inner.sends).toHaveLength(0);
  });

  it("rejects amount or circle-contract overrides", async () => {
    const inner = mockProvider({ allowance: 10_000_000n });
    const history = new ContributionHistory();
    const service = new CeloContributionService(binding(), inner, history);
    const prepared = await service.prepare(circle, obligation, PAYER);
    const mutatedAmount = {
      ...prepared,
      action: {
        ...prepared.action,
        request: { ...prepared.action.request, amount: "1" },
      },
      amount: "1",
    };
    await expect(
      service.submit(
        circle,
        obligation,
        mutatedAmount,
        { confirmed: true, actionId: prepared.action.actionId },
        900,
      ),
    ).rejects.toThrow(/amount/);
    const mutatedRecipient = {
      ...prepared,
      circleContract: normalizeAddress(OTHER),
    };
    await expect(
      service.submit(
        circle,
        obligation,
        mutatedRecipient,
        { confirmed: true, actionId: prepared.action.actionId },
        900,
      ),
    ).rejects.toThrow(/recipient/);
    expect(history.list()).toHaveLength(0);
    expect(inner.sends).toHaveLength(0);
  });

  it("does not mark a contribution complete when the wallet rejects", async () => {
    const inner = mockProvider({
      allowance: 10_000_000n,
      sendError: new Error("user rejected"),
    });
    const history = new ContributionHistory();
    const service = new CeloContributionService(binding(), inner, history);
    const prepared = await service.prepare(circle, obligation, PAYER);
    await expect(
      service.submit(
        circle,
        obligation,
        prepared,
        { confirmed: true, actionId: prepared.action.actionId },
        900,
      ),
    ).rejects.toThrow(/rejected/);
    expect(history.list()).toHaveLength(0);
  });

  it("does not mark a contribution complete when the transaction fails", async () => {
    const inner = mockProvider({ allowance: 10_000_000n, receiptStatus: "0x0" });
    const history = new ContributionHistory();
    const service = new CeloContributionService(binding(), inner, history);
    const prepared = await service.prepare(circle, obligation, PAYER);
    await expect(
      service.submit(
        circle,
        obligation,
        prepared,
        { confirmed: true, actionId: prepared.action.actionId },
        900,
      ),
    ).rejects.toThrow(/failed/);
    expect(history.list()).toHaveLength(0);
  });

  it("refuses to send without explicit confirmation matching the prepared action", async () => {
    const inner = mockProvider({ allowance: 10_000_000n });
    const history = new ContributionHistory();
    const service = new CeloContributionService(binding(), inner, history);
    const prepared = await service.prepare(circle, obligation, PAYER);
    const agent = new IwaSavingsAgent();
    expect(() =>
      agent.requireConfirmation(prepared.action, { confirmed: false }),
    ).toThrow(/explicit confirmation/);
    await expect(
      service.submit(circle, obligation, prepared, { confirmed: false }, 900),
    ).rejects.toThrow(/explicit confirmation/);
    await expect(
      service.submit(
        circle,
        obligation,
        prepared,
        { confirmed: true, actionId: "forged" },
        900,
      ),
    ).rejects.toThrow(/does not match/);
    expect(inner.sends).toHaveLength(0);
    expect(history.list()).toHaveLength(0);
  });

  it("refuses an untagged raw send through the adapter provider", async () => {
    const inner = mockProvider({ allowance: 10_000_000n });
    const service = new CeloContributionService(binding(), inner, new ContributionHistory());
    await service.prepare(circle, obligation, PAYER);
    await expect(
      service.taggedProvider.request({
        method: "eth_sendRawTransaction",
        params: ["0xdead"],
      }),
    ).rejects.toThrow(/raw/i);
  });

  it("refuses to prepare when the cNGN balance is insufficient", async () => {
    const inner = mockProvider({ balance: 1n });
    const service = new CeloContributionService(binding(), inner, new ContributionHistory());
    await expect(service.prepare(circle, obligation, PAYER)).rejects.toThrow(
      /insufficient/,
    );
    expect(inner.sends).toHaveLength(0);
  });
});

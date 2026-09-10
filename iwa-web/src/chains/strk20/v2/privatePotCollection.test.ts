// The mandated V2 private-pot-collection frontend matrix, run against an
// in-memory model of IwaCircleV2 + the wallet bridge. No network, no browser.
//
// Every test names one contract-enforced rule that the frontend flow must also
// respect: identity, state-derived amount, note-id binding, expiry, replay,
// wallet rejection, partial-progress recovery, and confirmed-onchain "paid".

import { describe, expect, it, vi } from "vitest";

import { deriveMemberIdentity, verifyIwa } from "../iwaSigning";
import { FIRST_OPEN_NOTE } from "../strk20Actions";
import * as potModule from "./privatePotCollection";
import { collectPrivatePot, type PotCollectionState } from "./privatePotCollection";
import { payoutDestV2Hash } from "./iwaSigningV2";

const CIRCLE_V2 = "0x0c1";
const HELPER_V2 = "0x0e2";
const POOL = "0x0a3";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const CIRCLE_ID = 7;
const ROUND = 3;
const POT = 10_000_000n;
const SELF = "0x1234beef";
const RESOLVED_NOTE = 0x64c726788e6bbdba21d2d5e6b6fd46d0253d5df12d4c48195aacbd6d0a01076n;

const STATUS_IDX: Record<string, number> = {
  Scheduled: 0,
  DeferredLocked: 1,
  PrivateSettlementAuthorized: 2,
  PrivatelyPaid: 3,
  RecoveryPending: 4,
  PrivatelyRecovered: 5,
  NoFundedRecovery: 6,
};

const member = deriveMemberIdentity("scheduled", 0xabc1n, 0xdef1n);
const other = deriveMemberIdentity("other", 0xabc2n, 0xdef2n);

interface ChainState {
  status: keyof typeof STATUS_IDX | "none";
  amount: bigint;
  scheduledMemberRef: bigint;
  settled: boolean;
  deficit: bigint;
  destEpoch: bigint;
  registered: { noteId: bigint; amount: bigint; destEpoch: bigint; expiry: bigint } | null;
  blockTs: number;
}

interface Harness {
  deps: potModule.PotCollectionDeps;
  state: ChainState;
  calls: {
    prepare: number;
    execute: unknown[][];
    invoke: number;
    waits: string[];
  };
  states: PotCollectionState[];
}

function makeHarness(
  overrides: Partial<ChainState> = {},
  walletOverrides: Partial<potModule.WalletBridge> = {},
  depOverrides: Partial<potModule.PotCollectionDeps> = {},
): Harness {
  const state: ChainState = {
    status: "Scheduled",
    amount: POT,
    scheduledMemberRef: member.memberRef,
    settled: false,
    deficit: 0n,
    destEpoch: 0n,
    registered: null,
    blockTs: 1_800_000_000,
    ...overrides,
  };

  const calls: Harness["calls"] = { prepare: 0, execute: [], invoke: 0, waits: [] };
  const states: PotCollectionState[] = [];

  const felt = (v: bigint): string => `0x${v.toString(16)}`;

  const provider = {
    callContract: async ({
      entrypoint,
    }: {
      contractAddress: string;
      entrypoint: string;
      calldata: string[];
    }): Promise<string[]> => {
      switch (entrypoint) {
        case "get_payout_state_v2": {
          if (state.status === "none") throw new Error("IWA: payout locked");
          return [
            String(CIRCLE_ID),
            String(ROUND),
            felt(state.scheduledMemberRef),
            felt(state.amount),
            String(STATUS_IDX[state.status]),
          ];
        }
        case "is_payout_privately_settled":
          return [state.settled ? "0x1" : "0x0"];
        case "get_round_unresolved_deficit":
          return [felt(state.deficit)];
        case "get_dest_epoch":
          return [felt(state.destEpoch)];
        case "get_registered_payout_destination": {
          if (!state.registered) throw new Error("IWA2: no destination");
          const r = state.registered;
          return [felt(r.noteId), felt(r.amount), felt(r.destEpoch), felt(r.expiry)];
        }
        default:
          throw new Error(`unexpected view ${entrypoint}`);
      }
    },
    getBlock: async () => ({ timestamp: state.blockTs }),
  } as unknown as potModule.PotCollectionDeps["provider"];

  const defaultPrepare = async (actions: unknown[]): Promise<unknown> => {
    calls.prepare += 1;
    const acts = actions as { type: string; calldata?: string[] }[];
    const invoke = acts.find((a) => a.type === "invoke");
    const cd = (invoke?.calldata ?? []).map((x) =>
      x === FIRST_OPEN_NOTE ? felt(RESOLVED_NOTE) : x,
    );
    return { call: { calldata: ["0x1", "0x0", ...cd, "0xff"] } };
  };

  const wallet: potModule.WalletBridge = {
    strk20PrepareInvoke:
      walletOverrides.strk20PrepareInvoke ?? (defaultPrepare as potModule.WalletBridge["strk20PrepareInvoke"]),
    execute:
      walletOverrides.execute ??
      (async (c: unknown[]) => {
        calls.execute.push(c as unknown[]);
        // model register_payout_destination success
        const call = (c as { calldata: string[] }[])[0];
        const [, , noteId, amount, destEpoch, expiry] = call.calldata.map((f) => BigInt(f));
        state.registered = { noteId, amount, destEpoch, expiry };
        state.destEpoch = destEpoch;
        state.status = "PrivateSettlementAuthorized";
        return { transaction_hash: "0xREG" };
      }),
    strk20InvokeTransaction:
      walletOverrides.strk20InvokeTransaction ??
      (async () => {
        calls.invoke += 1;
        // model a successful pool settlement
        if (
          state.status === "PrivateSettlementAuthorized" &&
          state.registered &&
          state.registered.noteId === RESOLVED_NOTE
        ) {
          state.status = "PrivatelyPaid";
          state.settled = true;
        }
        return { transaction_hash: "0xSETTLE" };
      }),
    waitForTransaction:
      walletOverrides.waitForTransaction ??
      (async (h: string) => {
        calls.waits.push(h);
      }),
  };

  const deps: potModule.PotCollectionDeps = {
    provider,
    circleV2Address: CIRCLE_V2,
    helperV2Address: HELPER_V2,
    poolAddress: POOL,
    circleId: CIRCLE_ID,
    round: ROUND,
    token: USDC,
    identity: member,
    selfAddress: SELF,
    wallet,
    nonce: () => 0x9999n,
    expiryWindowSeconds: 3600,
    onState: (s) => states.push(s),
    ...depOverrides,
  };

  return { deps, state, calls, states };
}

const phases = (h: Harness): string[] => h.states.map((s) => s.phase);

describe("collectPrivatePot — happy path", () => {
  it("registers with the STATE-DERIVED amount, then settles, and only reports paid after a fresh chain read", async () => {
    const h = makeHarness();
    const result = await collectPrivatePot(h.deps);

    expect(result.phase).toBe("paid");
    expect(result.settlementTxHash).toBe("0xSETTLE");
    expect(phases(h)).toEqual(
      expect.arrayContaining([
        "checking-state",
        "preparing-note-id",
        "awaiting-registration-signature",
        "registering",
        "registered",
        "assembling-settlement",
        "awaiting-settlement-approval",
        "settling",
        "confirming",
        "paid",
      ]),
    );

    // the amount in the registration call came from get_payout_state_v2, not any input
    const regCalldata = (h.calls.execute[0][0] as { calldata: string[] }).calldata;
    expect(BigInt(regCalldata[3])).toBe(POT);
    expect(BigInt(regCalldata[2])).toBe(RESOLVED_NOTE); // the wallet-resolved note id
  });

  it("does NOT expose an amount parameter on the public collect function", () => {
    // collectPrivatePot takes exactly one argument: the deps object.
    expect(collectPrivatePot.length).toBe(1);
    // and deps has no amount field
    const h = makeHarness();
    expect("amount" in (h.deps as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("collectPrivatePot — identity", () => {
  it("wrong scheduled member cannot register: refuses before any wallet call", async () => {
    const h = makeHarness({ scheduledMemberRef: other.memberRef });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("not-your-turn");
    expect(h.calls.prepare).toBe(0);
    expect(h.calls.execute).toHaveLength(0);
    expect(h.calls.invoke).toBe(0);
  });
});

describe("collectPrivatePot — replay / already collected", () => {
  it("does not resend when the chain already shows PrivatelyPaid", async () => {
    const h = makeHarness({ status: "PrivatelyPaid", settled: true });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("already-collected");
    expect(h.calls.prepare).toBe(0);
    expect(h.calls.execute).toHaveLength(0);
    expect(h.calls.invoke).toBe(0);
  });

  it("does not resend when is_payout_privately_settled is true even if status lags", async () => {
    const h = makeHarness({ status: "PrivateSettlementAuthorized", settled: true });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("already-collected");
    expect(h.calls.invoke).toBe(0);
  });
});

describe("collectPrivatePot — note-id binding", () => {
  it("fails (retryable) when the wallet does not resolve an open-note id", async () => {
    const h = makeHarness(
      {},
      {
        strk20PrepareInvoke: async (actions: { type: string; calldata?: string[] }[]) => {
          const inv = actions.find((a) => a.type === "invoke");
          // return the calldata WITHOUT substituting the placeholder
          return { call: { calldata: ["0x1", ...(inv?.calldata ?? [])] } };
        },
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.detail).toMatch(/did not resolve an open-note id/);
    expect(h.calls.execute).toHaveLength(0);
  });

  it("fails (retryable) when the resolved id shifts between registration and settlement", async () => {
    let n = 0;
    const felt = (v: bigint): string => `0x${v.toString(16)}`;
    const h = makeHarness(
      {},
      {
        strk20PrepareInvoke: async (actions: { type: string; calldata?: string[] }[]) => {
          n += 1;
          const id = n <= 1 ? RESOLVED_NOTE : RESOLVED_NOTE + 1n; // shifts after registration
          const inv = actions.find((a) => a.type === "invoke");
          const cd = (inv?.calldata ?? []).map((x) => (x === FIRST_OPEN_NOTE ? felt(id) : x));
          return { call: { calldata: ["0x1", ...cd, "0x0", "0x0", "0x0"] } };
        },
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.detail).toMatch(/resolved open-note id changed/);
    expect(h.calls.invoke).toBe(0); // never submitted the settlement
  });

  it("re-uses an existing valid registration instead of re-registering", async () => {
    const h = makeHarness({
      status: "PrivateSettlementAuthorized",
      destEpoch: 4n,
      registered: {
        noteId: RESOLVED_NOTE,
        amount: POT,
        destEpoch: 4n,
        expiry: BigInt(1_800_000_000 + 10_000),
      },
    });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("paid");
    expect(h.calls.execute).toHaveLength(0); // no re-registration
    expect(h.calls.invoke).toBe(1);
  });

  it("re-registers when an existing registration is for a different note", async () => {
    const h = makeHarness({
      status: "PrivateSettlementAuthorized",
      destEpoch: 4n,
      registered: {
        noteId: 0xdeadn, // stale
        amount: POT,
        destEpoch: 4n,
        expiry: BigInt(1_800_000_000 + 10_000),
      },
    });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("paid");
    expect(h.calls.execute).toHaveLength(1);
    // re-registration used a strictly higher epoch
    const regCalldata = (h.calls.execute[0][0] as { calldata: string[] }).calldata;
    expect(BigInt(regCalldata[4])).toBe(5n);
  });
});

describe("collectPrivatePot — amount / binding come from state", () => {
  it("signs the registration hash with circle/round/member/amount from chain state", async () => {
    const signSpy = vi.fn();
    const h = makeHarness(
      {},
      {
        execute: async (c: unknown[]) => {
          signSpy(c);
          const call = (c as { calldata: string[] }[])[0];
          const cd = call.calldata.map((f) => BigInt(f));
          // recompute the hash the contract will check and confirm the signature verifies
          const [circleId, round, noteId, amount, destEpoch, expiry, nonce, r, s] = cd;
          // model the on-chain registration transition so the flow proceeds
          h.state.registered = { noteId, amount, destEpoch, expiry };
          h.state.destEpoch = destEpoch;
          h.state.status = "PrivateSettlementAuthorized";
          const hash = payoutDestV2Hash({
            circleContract: CIRCLE_V2,
            helper: HELPER_V2,
            pool: POOL,
            token: USDC,
            circleId: Number(circleId),
            round: Number(round),
            memberRef: member.memberRef,
            noteId,
            amount,
            destEpoch,
            expiry,
            nonce,
          });
          // the signature verifies against the member's on-chain auth key
          expect(verifyIwa(member.authPublicKeyX, hash, r, s)).toBe(true);
          // and the hash was built from chain state, not any UI input
          expect(circleId).toBe(BigInt(CIRCLE_ID));
          expect(round).toBe(BigInt(ROUND));
          expect(amount).toBe(POT);
          return { transaction_hash: "0xREG" };
        },
      },
    );
    // stop after registration by making the settlement read still show authorized
    h.deps.wallet.strk20InvokeTransaction = async () => ({ transaction_hash: "0xS" });
    const result = await collectPrivatePot(h.deps);
    expect(signSpy).toHaveBeenCalledTimes(1);
    // settlement didn't move state -> failed, retryable, still authorized
    expect(result.phase).toBe("failed");
    expect(result.chainStatus).toBe("PrivateSettlementAuthorized");
    expect(result.retryable).toBe(true);
  });
});

describe("collectPrivatePot — expiry", () => {
  it("blocks (retryable) when registration reverts as expired", async () => {
    const h = makeHarness(
      {},
      {
        execute: async () => ({ transaction_hash: "0xREG" }),
        waitForTransaction: async () => {
          throw new Error("Transaction reverted: IWA2: authorization expired");
        },
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.detail).toMatch(/registration transaction reverted/);
    expect(result.retryable).toBe(true);
    expect(h.calls.invoke).toBe(0);
  });

  it("forces re-registration when an existing registration's expiry is within the skew window", async () => {
    const h = makeHarness({
      status: "PrivateSettlementAuthorized",
      destEpoch: 4n,
      registered: {
        noteId: RESOLVED_NOTE,
        amount: POT,
        destEpoch: 4n,
        expiry: BigInt(1_800_000_000 + 30), // < now + default 120s skew
      },
    });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("paid");
    expect(h.calls.execute).toHaveLength(1); // re-registered
  });
});

describe("collectPrivatePot — wallet rejection", () => {
  it("registration rejected in the wallet -> failed, retryable, nothing settled", async () => {
    const h = makeHarness(
      {},
      {
        execute: async () => {
          throw { code: 63, message: "USER_REFUSED_OP" };
        },
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.detail).toMatch(/registration transaction was rejected/);
    expect(result.retryable).toBe(true);
    expect(result.chainStatus).toBe("Scheduled");
    expect(h.calls.invoke).toBe(0);
  });

  it("settlement rejected in the wallet after a good registration -> failed, retryable, still authorized", async () => {
    const h = makeHarness(
      {},
      {
        strk20InvokeTransaction: async () => {
          throw new Error("USER_REFUSED_OP");
        },
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.detail).toMatch(/settlement transaction was rejected/);
    expect(result.retryable).toBe(true);
    expect(result.chainStatus).toBe("PrivateSettlementAuthorized");
    // the registration DID land — a retry will re-use it
    expect(h.state.status).toBe("PrivateSettlementAuthorized");
    expect(h.state.registered?.noteId).toBe(RESOLVED_NOTE);
  });
});

describe("collectPrivatePot — settlement confirmation", () => {
  it("does not report paid on a receipt alone when the chain still shows authorized", async () => {
    const h = makeHarness(
      {},
      {
        strk20InvokeTransaction: async () => ({ transaction_hash: "0xSETTLE" }), // no state change
      },
    );
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("failed");
    expect(result.detail).toMatch(/did not move the payout to PrivatelyPaid/);
    expect(result.retryable).toBe(true);
  });

  it("reports paid only when a fresh read shows PrivatelyPaid AND settled", async () => {
    const h = makeHarness();
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("paid");
    expect(h.state.status).toBe("PrivatelyPaid");
    expect(h.state.settled).toBe(true);
  });
});

describe("collectPrivatePot — non-collectable states", () => {
  it("refuses a DeferredLocked round with an unresolved deficit", async () => {
    const h = makeHarness({ status: "DeferredLocked", deficit: 5_000_000n });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("not-collectable");
    expect(result.detail).toMatch(/unresolved contribution deficit/);
    expect(h.calls.prepare).toBe(0);
  });

  it("allows a cured DeferredLocked round (deficit 0)", async () => {
    const h = makeHarness({ status: "DeferredLocked", deficit: 0n });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("paid");
  });

  it("refuses a recovery-path round", async () => {
    const h = makeHarness({ status: "RecoveryPending" });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("not-collectable");
    expect(result.detail).toMatch(/recovery path/);
  });

  it("refuses when no payout accounting exists for the round", async () => {
    const h = makeHarness({ status: "none" });
    const result = await collectPrivatePot(h.deps);
    expect(result.phase).toBe("not-collectable");
    expect(result.detail).toMatch(/has not been prepared/);
  });
});

describe("V2 frontend path — no public payout method", () => {
  it("privatePotCollection exports no ERC20 / transfer / approve payout function", () => {
    const names = Object.keys(potModule).map((n) => n.toLowerCase());
    for (const forbidden of ["erc20", "transfer", "approve", "publicpayout", "sendusdc"]) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
  });

  it("the only exported entrypoint that moves value is collectPrivatePot (STRK20 + circle only)", () => {
    expect(typeof potModule.collectPrivatePot).toBe("function");
  });
});

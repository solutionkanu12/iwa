import { describe, expect, it, vi } from "vitest";

import {
  EXPECTED_CIRCLE_V2_CLASS,
  WRONG_COMPILED_CLASS_HASH,
  buildDeclareProbeParams,
  classifyMethodProbe,
  describeError,
  raceRequestWithTimeout,
  runDeployCapabilityProbe,
  type CapabilityProbeDeps,
} from "./deployCapabilityProbe";

// A minimal but STRUCTURALLY VALID Sierra artifact shape.
const VALID_SIERRA = {
  sierra_program: ["0x1", "0x0", "0x2"],
  sierra_program_debug_info: { type_names: [] },
  contract_class_version: "0.1.0",
  entry_points_by_type: {
    CONSTRUCTOR: [{ selector: "0x1", function_idx: 0 }],
    EXTERNAL: [{ selector: "0x2", function_idx: 1 }],
    L1_HANDLER: [],
  },
  abi: [{ type: "function", name: "foo", inputs: [], outputs: [], state_mutability: "view" }],
};

describe("buildDeclareProbeParams", () => {
  it("produces a structurally valid CONTRACT_CLASS with compiled_class_hash = 0x1", () => {
    const p = buildDeclareProbeParams(VALID_SIERRA);
    expect(p.compiled_class_hash).toBe(WRONG_COMPILED_CLASS_HASH);
    expect(p.compiled_class_hash).toBe("0x1");
    expect(p.contract_class.sierra_program).toBe(VALID_SIERRA.sierra_program); // present
    expect(p.contract_class.contract_class_version).toBe("0.1.0"); // valid
    // ABI serialised as a string (RPC CONTRACT_CLASS shape) — never null
    expect(typeof p.contract_class.abi).toBe("string");
    expect(p.contract_class.abi).toContain('"foo"');
    // debug info is stripped
    expect(p.contract_class).not.toHaveProperty("sierra_program_debug_info");
    const ep = p.contract_class.entry_points_by_type as Record<string, unknown>;
    expect(Array.isArray(ep.CONSTRUCTOR)).toBe(true);
    expect(Array.isArray(ep.EXTERNAL)).toBe(true);
    expect(Array.isArray(ep.L1_HANDLER)).toBe(true);
  });

  it("passes an already-stringified ABI straight through", () => {
    const p = buildDeclareProbeParams({ ...VALID_SIERRA, abi: '[{"x":1}]' });
    expect(p.contract_class.abi).toBe('[{"x":1}]');
  });

  it("throws (never sends a weak probe) when the artifact lacks a Sierra program", () => {
    expect(() => buildDeclareProbeParams({ ...VALID_SIERRA, sierra_program: [] })).toThrow(
      /sierra_program/,
    );
  });

  it("throws when the artifact has no ABI", () => {
    expect(() => buildDeclareProbeParams({ ...VALID_SIERRA, abi: [] })).toThrow(/ABI/);
  });

  it("throws when entry_points_by_type is incomplete", () => {
    expect(() =>
      buildDeclareProbeParams({
        ...VALID_SIERRA,
        entry_points_by_type: { EXTERNAL: [] } as never,
      }),
    ).toThrow(/entry_points_by_type/);
  });
});

describe("classifyMethodProbe", () => {
  it("BLOCKED on JSON-RPC method-not-found and 'unsupported method'", () => {
    for (const e of [
      { code: -32601, message: "Method not found" },
      new Error("wallet_addDeclareTransaction is not supported by this wallet"),
      new Error("METHOD_NOT_FOUND"),
      new Error("unknown request type: wallet_addDeclareTransaction"),
      new Error("no handler for wallet_addDeclareTransaction"),
      new Error("declaration is not supported"),
    ]) {
      expect(classifyMethodProbe({ ok: false, error: e }).support, String(e)).toBe("BLOCKED");
    }
  });

  it("SUPPORTED on invalid-params / compiled-class-hash mismatch / class-size / already-declared", () => {
    for (const m of [
      "INVALID_REQUEST_PAYLOAD",
      "code -32602: Invalid params",
      "compiled_class_hash does not match the contract class",
      "compiled class hash mismatch",
      "COMPILED_CLASS_HASH_MISMATCH",
      "recompiled CASM hash differs",
      "CONTRACT_CLASS_SIZE_IS_TOO_LARGE",
      "class is already declared",
      "CLASS_ALREADY_DECLARED",
      "failed to deserialize contract_class",
    ]) {
      expect(classifyMethodProbe({ ok: false, error: new Error(m) }).support, m).toBe("SUPPORTED");
    }
  });

  it("SUPPORTED when a user prompt was reached and the user cancelled", () => {
    for (const m of ["USER_REFUSED_OP", "User abort", "User rejected request", "cancelled", "declined"]) {
      expect(classifyMethodProbe({ ok: false, error: new Error(m) }).support, m).toBe("SUPPORTED");
    }
  });

  it("SUPPORTED when the method reached fee estimation (balance / resource / fee)", () => {
    for (const m of [
      "insufficient account balance for the declare",
      "failed to estimate fee for dry run",
      "resource bounds are too low",
    ]) {
      expect(classifyMethodProbe({ ok: false, error: new Error(m) }).support, m).toBe("SUPPORTED");
    }
  });

  it("INCONCLUSIVE on a client-side TypeError (the old null-contract_class failure mode)", () => {
    for (const m of [
      "Cannot read properties of null (reading 'abi')",
      "Cannot read properties of undefined (reading 'sierra_program')",
      "e.contract_class is not a function",
    ]) {
      const c = classifyMethodProbe({ ok: false, error: new Error(m) });
      expect(c.support, m).toBe("INCONCLUSIVE");
      expect(c.reason).toMatch(/client-side|never reached/i);
    }
  });

  it("INCONCLUSIVE on an unrecognised error", () => {
    expect(
      classifyMethodProbe({ ok: false, error: new Error("prover backend timeout") }).support,
    ).toBe("INCONCLUSIVE");
  });

  it("SUPPORTED (with a warning) if the wallet returns a result for the undeclarable payload", () => {
    const c = classifyMethodProbe({ ok: true, result: { transaction_hash: "0x1" } });
    expect(c.support).toBe("SUPPORTED");
    expect(c.reason).toMatch(/unexpected/i);
  });
});

describe("describeError", () => {
  it("renders JSON-RPC error objects, never [object Object]", () => {
    expect(describeError({ code: -32601, message: "Method not found" })).toBe(
      "code -32601: Method not found",
    );
    expect(describeError({ code: -32602, data: { reason: "bad" } })).toContain('{"reason":"bad"}');
  });
});

function baseDeps(over: Partial<CapabilityProbeDeps> = {}): CapabilityProbeDeps {
  return {
    walletName: "Ready",
    address: "0x4099b8e",
    chainId: "0x534e5f4d41494e",
    supportedSpecs: async () => ["0.8.1", "0.9.0"],
    supportedWalletApi: async () => ["0.10.3", "0.7.2"],
    walletFeatureKeys: () => ["starknet:walletApi", "standard:connect"],
    providerCapabilityHints: () => ({ id: "readyx", version: "6.x", methods: undefined }),
    confirmDeclarePrompt: async () => false,
    probeAddDeclare: async () => ({
      ok: false,
      error: { code: -32602, message: "compiled_class_hash mismatch" },
      strict: true,
    }),
    probeAddInvoke: async () => ({ ok: false, error: { code: -32602, message: "Invalid params" } }),
    account: { declare: () => {}, deploy: () => {}, execute: () => {} },
    ...over,
  };
}

describe("runDeployCapabilityProbe", () => {
  it("DECLARE_SUPPORTED when the strict probe hits a hash mismatch and account has declare/deploy/execute", async () => {
    const r = await runDeployCapabilityProbe(baseDeps());
    expect(r.addDeclareTransaction.support).toBe("SUPPORTED");
    expect(r.addDeclareTransaction.strictPayload).toBe(true);
    expect(r.account).toEqual({ declare: true, deploy: true, execute: true });
    expect(r.verdict).toBe("DECLARE_SUPPORTED");
  });

  it("DECLARE_BLOCKED on method-not-found", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({
          ok: false,
          error: { code: -32601, message: "Method not found" },
          strict: true,
        }),
      }),
    );
    expect(r.addDeclareTransaction.support).toBe("BLOCKED");
    expect(r.verdict).toBe("DECLARE_BLOCKED");
  });

  it("INCONCLUSIVE when the strict probe could not be built (artifact absent)", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({ unavailable: "no Sierra artifact" }),
        estimateCircleV2DeclareFee: vi.fn(),
      }),
    );
    expect(r.addDeclareTransaction.support).toBe("INCONCLUSIVE");
    expect(r.addDeclareTransaction.reason).toMatch(/strict probe not run/);
    expect(r.addDeclareTransaction.strictPayload).toBe(false);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.feeEstimate && "skipped" in r.feeEstimate).toBe(true);
  });

  it("INCONCLUSIVE on a client-side TypeError from the wallet request", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({
          ok: false,
          error: new Error("Cannot read properties of null (reading 'abi')"),
          strict: true,
        }),
      }),
    );
    expect(r.addDeclareTransaction.support).toBe("INCONCLUSIVE");
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("records the provider capability hints and captures a supportedSpecs failure", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        providerCapabilityHints: () => ({ id: "readyx", methods: ["wallet_addInvokeTransaction"] }),
        supportedSpecs: async () => {
          throw new Error("wallet_supportedSpecs not implemented");
        },
      }),
    );
    expect(r.providerCapabilityHints.id).toBe("readyx");
    expect(r.supportedSpecs).toEqual({ error: expect.stringMatching(/not implemented/) });
  });

  it("runs the fee estimate only when declare is SUPPORTED and confirms the class hash", async () => {
    const sierra = VALID_SIERRA;
    const estimateCircleV2DeclareFee = vi
      .fn()
      .mockResolvedValue({ estimate: { overall_fee: "0x1234", unit: "FRI" }, sierra });
    const r = await runDeployCapabilityProbe(baseDeps({ estimateCircleV2DeclareFee }));
    expect(estimateCircleV2DeclareFee).toHaveBeenCalledTimes(1);
    expect(r.feeEstimate && "ok" in r.feeEstimate && r.feeEstimate.ok).toBe(true);
    if (r.feeEstimate && "ok" in r.feeEstimate && r.feeEstimate.ok) {
      expect(r.feeEstimate.estimate.overall_fee).toBe("0x1234");
      expect(r.feeEstimate.classHashMatchesExpected).toBe(false); // stub != real
      expect(EXPECTED_CIRCLE_V2_CLASS).toMatch(/^0x0*7744b6a8/);
    }
  });

  it("skips the fee estimate when declare is BLOCKED", async () => {
    const estimateCircleV2DeclareFee = vi.fn();
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({ ok: false, error: { code: -32601 }, strict: true }),
        estimateCircleV2DeclareFee,
      }),
    );
    expect(estimateCircleV2DeclareFee).not.toHaveBeenCalled();
    expect(r.feeEstimate && "skipped" in r.feeEstimate).toBe(true);
  });

  // --- the Ready X prompt / hanging-promise path ---

  it("explicit user rejection -> DECLARE_SUPPORTED", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({
          ok: false,
          error: { code: 113, message: "USER_REFUSED_OP" },
          strict: true,
        }),
      }),
    );
    expect(r.addDeclareTransaction.support).toBe("SUPPORTED");
    expect(r.verdict).toBe("DECLARE_SUPPORTED");
  });

  it("timeout + user confirms the Ready X prompt -> DECLARE_SUPPORTED", async () => {
    const confirmDeclarePrompt = vi.fn().mockResolvedValue(true);
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({ pending: true, strict: true, timeoutMs: 12000 }),
        confirmDeclarePrompt,
        estimateCircleV2DeclareFee: vi.fn().mockResolvedValue({
          estimate: { overall_fee: "0x9" },
          sierra: VALID_SIERRA,
        }),
      }),
    );
    expect(confirmDeclarePrompt).toHaveBeenCalledTimes(1);
    expect(r.addDeclareTransaction.support).toBe("SUPPORTED");
    expect(r.addDeclareTransaction.pendingAfterTimeout).toBe(true);
    expect(r.addDeclareTransaction.userConfirmedPrompt).toBe(true);
    expect(r.addDeclareTransaction.strictPayload).toBe(true);
    expect(r.verdict).toBe("DECLARE_SUPPORTED");
    // the fee estimate still runs after a confirmed prompt
    expect(r.feeEstimate && "ok" in r.feeEstimate && r.feeEstimate.ok).toBe(true);
  });

  it("timeout + user says NO prompt appeared -> INCONCLUSIVE", async () => {
    const r = await runDeployCapabilityProbe(
      baseDeps({
        probeAddDeclare: async () => ({ pending: true, strict: true, timeoutMs: 12000 }),
        confirmDeclarePrompt: async () => false,
      }),
    );
    expect(r.addDeclareTransaction.support).toBe("INCONCLUSIVE");
    expect(r.addDeclareTransaction.pendingAfterTimeout).toBe(true);
    expect(r.addDeclareTransaction.userConfirmedPrompt).toBeUndefined();
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("timeout with no confirmation channel -> INCONCLUSIVE (never hangs)", async () => {
    const deps = baseDeps({
      probeAddDeclare: async () => ({ pending: true, strict: true, timeoutMs: 12000 }),
    });
    delete (deps as Partial<CapabilityProbeDeps>).confirmDeclarePrompt;
    const r = await runDeployCapabilityProbe(deps);
    expect(r.addDeclareTransaction.support).toBe("INCONCLUSIVE");
    expect(r.verdict).toBe("INCONCLUSIVE");
  });
});

describe("raceRequestWithTimeout", () => {
  it("returns resolved when the request settles first", async () => {
    const r = await raceRequestWithTimeout(Promise.resolve("v"), 1000);
    expect(r).toEqual({ kind: "resolved", value: "v" });
  });

  it("returns rejected when the request rejects first", async () => {
    const r = await raceRequestWithTimeout(Promise.reject(new Error("nope")), 1000);
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(describeError(r.error)).toMatch(/nope/);
  });

  it("returns timeout for a hanging promise that never settles (the Ready X cancel bug)", async () => {
    const hanging = new Promise<string>(() => {}); // never resolves or rejects
    const r = await raceRequestWithTimeout(hanging, 5);
    expect(r).toEqual({ kind: "timeout" });
  });

  it("a settlement arriving AFTER the timeout does not throw (no unhandled rejection)", async () => {
    let reject!: (e: unknown) => void;
    const late = new Promise<string>((_, rej) => {
      reject = rej;
    });
    const r = await raceRequestWithTimeout(late, 5);
    expect(r.kind).toBe("timeout");
    reject(new Error("late cancel")); // arrives after we stopped waiting
    // give the microtask queue a tick; the test fails via unhandledRejection if unguarded
    await new Promise((res) => setTimeout(res, 10));
  });
});

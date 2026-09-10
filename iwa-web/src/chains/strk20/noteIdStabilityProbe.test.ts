// A1 — Candidate P live-wallet note-id stability probe.
//
// Pure-logic tests for the probe's parts. The probe ITSELF (the part that
// drives a connected wallet through wallet_strk20PrepareInvoke) can only be
// exercised by a human with a privacy-enabled Starknet wallet on a public
// network — see docs/strk20/WALLET_NOTE_ID_SPIKE.md. These tests cover
// everything that does not need a wallet: extracting the resolved open-note id
// from a prepared apply_actions call, building the probe actions, and turning
// two/three observed ids into a PASS/REJECT verdict.

import { describe, expect, it } from "vitest";

import {
  buildProbeActions,
  classifyProbe,
  findResolvedOpenNoteId,
  findResolvedOpenNoteIdDeep,
  inspectPrepareResponse,
  PROBE_POOL_SENTINEL_AFTER,
  PROBE_POOL_SENTINEL_BEFORE,
  PROBE_SENTINEL_AFTER,
  PROBE_SENTINEL_BEFORE,
  runNoteIdStabilityProbe,
  type ProbeWallet,
} from "./noteIdStabilityProbe";

const sB = `0x${PROBE_SENTINEL_BEFORE.toString(16)}`;
const sA = `0x${PROBE_SENTINEL_AFTER.toString(16)}`;

// The exact patterns the Starknet Wallet API schema enforces (copied verbatim
// from the installed @starknet-io/types-js@0.10.3):
//   FELT                       api/components.d.ts
//   STRK20_CALLDATA_PLACEHOLDER wallet-api/components.d.ts
const FELT_RE = /^0x(0|[a-fA-F1-9]{1}[a-fA-F0-9]{0,62})$/;
const PLACEHOLDER_RE = /^\$\{(?:openNoteIds\[[0-9]+\]|poolAddress)\}$/;
// Stark field prime; a felt must be strictly less than this.
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const isValidCalldataItem = (s: string): boolean =>
  PLACEHOLDER_RE.test(s) || (FELT_RE.test(s) && BigInt(s) < STARK_PRIME);

describe("findResolvedOpenNoteId", () => {
  it("returns the felt the wallet substituted between the probe sentinels", () => {
    const resolved = 0x0511223344556677889900aabbccddeeff00112233445566778899aabbccddeen;
    const calldata = [
      "0xa",
      "0xb",
      `0x${PROBE_SENTINEL_BEFORE.toString(16)}`,
      `0x${resolved.toString(16)}`,
      `0x${PROBE_SENTINEL_AFTER.toString(16)}`,
      "0xc",
    ];
    expect(findResolvedOpenNoteId(calldata)).toBe(resolved);
  });

  it("returns null when the sentinels are absent (wallet returned nothing usable)", () => {
    expect(findResolvedOpenNoteId(["0x1", "0x2", "0x3"])).toBeNull();
  });

  it("returns null when the placeholder was NOT resolved (still a literal string)", () => {
    const calldata = [
      `0x${PROBE_SENTINEL_BEFORE.toString(16)}`,
      "${openNoteIds[0]}",
      `0x${PROBE_SENTINEL_AFTER.toString(16)}`,
    ];
    expect(findResolvedOpenNoteId(calldata)).toBeNull();
  });

  it("returns null when the value between the sentinels is zero", () => {
    const calldata = [
      `0x${PROBE_SENTINEL_BEFORE.toString(16)}`,
      "0x0",
      `0x${PROBE_SENTINEL_AFTER.toString(16)}`,
    ];
    expect(findResolvedOpenNoteId(calldata)).toBeNull();
  });
});

describe("findResolvedOpenNoteIdDeep — search the WHOLE prepare response", () => {
  const RESOLVED = 0x0abc00000000000000000000000000000000000000000000000000000000abc1n;

  it("finds the sentinel-wrapped id in call.calldata", () => {
    const built = { call: { calldata: ["0x1", sB, `0x${RESOLVED.toString(16)}`, sA] } };
    expect(findResolvedOpenNoteIdDeep(built)).toEqual({
      id: RESOLVED,
      foundAt: "call.calldata[1..3]",
    });
  });

  it("finds the id in proof.output when call.calldata does not carry it", () => {
    const built = {
      call: { calldata: ["0x1", "0x2"] },
      proof: { data: "", output: ["0xdead", sB, `0x${RESOLVED.toString(16)}`, sA], proof_facts: [] },
    };
    expect(findResolvedOpenNoteIdDeep(built).id).toBe(RESOLVED);
    expect(findResolvedOpenNoteIdDeep(built).foundAt).toContain("proof.output");
  });

  it("finds the id in an arbitrarily nested array field", () => {
    const built = { result: { assembled: { calls: [{ calldata: [sB, `0x${RESOLVED.toString(16)}`, sA] }] } } };
    expect(findResolvedOpenNoteIdDeep(built).id).toBe(RESOLVED);
  });

  it("returns null id when the placeholder was not resolved anywhere", () => {
    const built = { call: { calldata: [sB, "${openNoteIds[0]}", sA] } };
    expect(findResolvedOpenNoteIdDeep(built)).toEqual({ id: null, foundAt: null });
  });

  it("returns null id for an empty / shapeless response", () => {
    expect(findResolvedOpenNoteIdDeep({})).toEqual({ id: null, foundAt: null });
    expect(findResolvedOpenNoteIdDeep(null)).toEqual({ id: null, foundAt: null });
  });
});

describe("inspectPrepareResponse — SAFE structural fingerprint", () => {
  const RESOLVED = 0x0abc00000000000000000000000000000000000000000000000000000000abc2n;

  it("records the top-level and call/proof structure without leaking proof.data", () => {
    const built = {
      call: { contract_address: "0x4", entry_point: "apply_actions", calldata: [sB, `0x${RESOLVED.toString(16)}`, sA] },
      proof: { data: "SECRET-PROOF-BYTES-SHOULD-NOT-APPEAR", output: ["0xaa"], proof_facts: [] },
    };
    const insp = inspectPrepareResponse(built);
    expect(insp.ok).toBe(true);
    expect(insp.topKeys.sort()).toEqual(["call", "proof"]);
    expect(insp.call?.calldataLength).toBe(3);
    expect(insp.proof?.dataLength).toBe("SECRET-PROOF-BYTES-SHOULD-NOT-APPEAR".length);
    expect(insp.proof?.outputLength).toBe(1);
    expect(insp.sentinelPairPaths.length).toBe(1);
    expect(insp.resolvedIdCandidatesHex).toEqual([`0x${RESOLVED.toString(16)}`]);
    expect(insp.placeholderLiteralPaths).toEqual([]);
    expect(JSON.stringify(insp)).not.toContain("SECRET-PROOF-BYTES");
  });

  it("flags an unresolved placeholder and reports where", () => {
    const built = { call: { calldata: [sB, "${openNoteIds[0]}", sA] } };
    const insp = inspectPrepareResponse(built);
    expect(insp.placeholderLiteralPaths.length).toBe(1);
    expect(insp.resolvedIdCandidatesHex).toEqual([]);
    expect(insp.call?.hasPlaceholderLiteral).toBe(true);
  });

  it("captures an error and marks the response not ok", () => {
    const insp = inspectPrepareResponse(undefined, new Error("wallet said no: rate limited"));
    expect(insp.ok).toBe(false);
    expect(insp.error).toContain("rate limited");
    expect(insp.call).toBeNull();
  });

  it("captures a JSON-RPC error object shape (code + message), no stack", () => {
    const insp = inspectPrepareResponse(undefined, { code: 63, message: "PRIVACY_LEAK" });
    expect(insp.ok).toBe(false);
    expect(insp.error).toContain("PRIVACY_LEAK");
    expect(insp.error).not.toContain("at ");
  });
});

describe("probe payload is schema-valid for wallet_strk20PrepareInvoke", () => {
  it("every sentinel felt is a valid FELT (<= 63 hex digits, < the Stark prime)", () => {
    for (const s of [
      PROBE_SENTINEL_BEFORE,
      PROBE_SENTINEL_AFTER,
      PROBE_POOL_SENTINEL_BEFORE,
      PROBE_POOL_SENTINEL_AFTER,
    ]) {
      const hex = `0x${s.toString(16)}`;
      expect(hex.length - 2).toBeLessThanOrEqual(63);
      expect(FELT_RE.test(hex)).toBe(true);
      expect(s).toBeLessThan(STARK_PRIME);
    }
  });

  it("every buildProbeActions calldata item is a valid FELT or a valid placeholder", () => {
    const actions = buildProbeActions({
      token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
      selfAddress: "0x1234abcd",
      probeContract: "0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb",
    });
    const invoke = actions[1] as { type: "invoke"; calldata: string[] };
    for (const item of invoke.calldata) {
      expect(isValidCalldataItem(item), `invalid calldata item: ${item}`).toBe(true);
    }
  });

  it("transfer/invoke fields (token, recipient, contract) are valid FELT addresses", () => {
    const actions = buildProbeActions({
      token: "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
      selfAddress: "0x00abc",
      probeContract: "0x1",
    });
    const t = actions[0] as { token: string; recipient: string };
    const inv = actions[1] as { contract: string };
    for (const a of [t.token, t.recipient, inv.contract]) {
      expect(FELT_RE.test(a), `not a FELT: ${a}`).toBe(true);
    }
  });
});

describe("buildProbeActions", () => {
  it("opens one note to self, then invokes with the sentinel-wrapped placeholder", () => {
    const actions = buildProbeActions({
      token: "0x53c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
      selfAddress: "0x49d36570d4e46f48e99674bd3fbcf03b9a9c2f5f8b4b3a2a1009f8e7d6c5b4a",
      probeContract: "0x1",
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "transfer", amount: "OPEN" });
    expect(actions[1].type).toBe("invoke");
    const invoke = actions[1] as { type: "invoke"; calldata: string[] };
    // open-note placeholder wrapped in its sentinels, then poolAddress control.
    expect(invoke.calldata.slice(0, 3)).toEqual([sB, "${openNoteIds[0]}", sA]);
    expect(invoke.calldata[4]).toBe("${poolAddress}");
  });
});

describe("classifyProbe — the A1 verdict", () => {
  const A = 0x1111n;
  const B = 0x2222n;

  it("PASS: id is stable across two prepares AND shifts after an intervening note", () => {
    expect(
      classifyProbe({ walletSupportsStrk20: true, first: A, second: A, afterInterveningNote: B }),
    ).toEqual({ verdict: "PASS" });
  });

  it("REJECT_UNSTABLE: the two back-to-back prepares disagree with no note created between", () => {
    expect(
      classifyProbe({ walletSupportsStrk20: true, first: A, second: B, afterInterveningNote: null }),
    ).toMatchObject({ verdict: "REJECT_UNSTABLE" });
  });

  it("REJECT_NO_RESOLVED_ID: the wallet's prepare did not expose a resolved id", () => {
    expect(
      classifyProbe({
        walletSupportsStrk20: true,
        first: null,
        second: null,
        afterInterveningNote: null,
      }),
    ).toMatchObject({ verdict: "REJECT_NO_RESOLVED_ID" });
  });

  it("INCONCLUSIVE_ID_DID_NOT_SHIFT: stable, but an intervening note did not move it (model wrong)", () => {
    expect(
      classifyProbe({ walletSupportsStrk20: true, first: A, second: A, afterInterveningNote: A }),
    ).toMatchObject({ verdict: "INCONCLUSIVE_ID_DID_NOT_SHIFT" });
  });

  it("PARTIAL_STABLE_PENDING_SHIFT: stable across two prepares, intervening-note step not yet run", () => {
    expect(
      classifyProbe({ walletSupportsStrk20: true, first: A, second: A, afterInterveningNote: null }),
    ).toMatchObject({ verdict: "PARTIAL_STABLE_PENDING_SHIFT" });
  });

  it("WALLET_UNSUPPORTED: the connected wallet does not expose the shipped STRK20 methods", () => {
    expect(
      classifyProbe({
        walletSupportsStrk20: false,
        first: null,
        second: null,
        afterInterveningNote: null,
      }),
    ).toMatchObject({ verdict: "WALLET_UNSUPPORTED" });
  });

  it("INCONSISTENT_ACROSS_RUNS: a prior run resolved a stable id but this run's prepare returned none", () => {
    expect(
      classifyProbe(
        { walletSupportsStrk20: true, first: null, second: null, afterInterveningNote: null },
        { priorStableId: A },
      ),
    ).toMatchObject({ verdict: "INCONSISTENT_ACROSS_RUNS" });
  });

  it("INCONSISTENT_ACROSS_RUNS: this run resolves a DIFFERENT stable id than the prior run", () => {
    expect(
      classifyProbe(
        { walletSupportsStrk20: true, first: B, second: B, afterInterveningNote: null },
        { priorStableId: A },
      ),
    ).toMatchObject({ verdict: "INCONSISTENT_ACROSS_RUNS" });
  });

  it("a prior id that MATCHES this run's stable id is not flagged", () => {
    expect(
      classifyProbe(
        { walletSupportsStrk20: true, first: A, second: A, afterInterveningNote: null },
        { priorStableId: A },
      ),
    ).toMatchObject({ verdict: "PARTIAL_STABLE_PENDING_SHIFT" });
  });
});

describe("runNoteIdStabilityProbe — returns the observed ids for the UI", () => {
  const RESOLVED = 0x0abc123400000000000000000000000000000000000000000000000000000abcn;

  function preparedCallWith(id: bigint) {
    return {
      call: {
        calldata: [
          `0x${PROBE_SENTINEL_BEFORE.toString(16)}`,
          `0x${id.toString(16)}`,
          `0x${PROBE_SENTINEL_AFTER.toString(16)}`,
        ],
      },
    };
  }

  const okWallet: ProbeWallet = {
    supportedWalletApi: async () => ["0.8.0", "0.10.3"],
    strk20PrepareInvoke: async () => preparedCallWith(RESOLVED),
    strk20InvokeTransaction: async () => ({ transaction_hash: "0x1" }),
  };

  it("exposes first and second ids and PARTIAL_STABLE_PENDING_SHIFT with no intervening step", async () => {
    const result = await runNoteIdStabilityProbe({
      wallet: okWallet,
      token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
      selfAddress: "0x49d36570d4e46f48e99674bd3fbcf03b9a9c2f5f8b4b3a2a1009f8e7d6c5b4a",
      probeContract: "0x1",
      requiredWalletApiVersion: "0.10.3",
    });
    expect(result.verdict).toBe("PARTIAL_STABLE_PENDING_SHIFT");
    expect(result.observed).toMatchObject({
      walletSupportsStrk20: true,
      first: RESOLVED,
      second: RESOLVED,
      afterInterveningNote: null,
    });
  });

  it("PASS and reports the shifted id when createInterveningNote is supplied", async () => {
    const SHIFTED = RESOLVED + 1n;
    let stage = 0;
    const shiftingWallet: ProbeWallet = {
      ...okWallet,
      strk20PrepareInvoke: async () => {
        stage += 1;
        return preparedCallWith(stage <= 2 ? RESOLVED : SHIFTED);
      },
    };
    const result = await runNoteIdStabilityProbe({
      wallet: shiftingWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
      createInterveningNote: async () => {},
    });
    expect(result.verdict).toBe("PASS");
    expect(result.observed.afterInterveningNote).toBe(SHIFTED);
  });

  it("WALLET_UNSUPPORTED when supportedWalletApi lacks 0.10.3", async () => {
    const oldWallet: ProbeWallet = { ...okWallet, supportedWalletApi: async () => ["0.9.0"] };
    const result = await runNoteIdStabilityProbe({
      wallet: oldWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
    });
    expect(result.verdict).toBe("WALLET_UNSUPPORTED");
    expect(result.observed.walletSupportsStrk20).toBe(false);
  });

  it("records a per-prepare inspection for every call", async () => {
    const result = await runNoteIdStabilityProbe({
      wallet: okWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
    });
    expect(result.observed.inspections.length).toBe(2);
    expect(result.observed.inspections[0].ok).toBe(true);
    expect(result.observed.inspections[0].resolvedIdCandidatesHex).toEqual([
      `0x${RESOLVED.toString(16)}`,
    ]);
  });

  it("captures the wallet error in the inspection instead of silently returning null", async () => {
    const throwingWallet: ProbeWallet = {
      ...okWallet,
      strk20PrepareInvoke: async () => {
        throw new Error("Ready backend unavailable");
      },
    };
    const result = await runNoteIdStabilityProbe({
      wallet: throwingWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
    });
    expect(result.observed.first).toBeNull();
    expect(result.observed.inspections[0].ok).toBe(false);
    expect(result.observed.inspections[0].error).toContain("Ready backend unavailable");
  });

  it("does NOT hard-reject when a prior stable id is supplied and this run flakes", async () => {
    const flakyWallet: ProbeWallet = {
      ...okWallet,
      strk20PrepareInvoke: async () => {
        throw new Error("transient");
      },
    };
    const result = await runNoteIdStabilityProbe({
      wallet: flakyWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
      priorStableId: 0x1234n,
    });
    expect(result.verdict).toBe("INCONSISTENT_ACROSS_RUNS");
  });

  it("does not re-run #1/#2 when a prior stable id is supplied — starts from step 8", async () => {
    let prepares = 0;
    const countingWallet: ProbeWallet = {
      ...okWallet,
      strk20PrepareInvoke: async () => {
        prepares += 1;
        return preparedCallWith(RESOLVED + 5n);
      },
    };
    await runNoteIdStabilityProbe({
      wallet: countingWallet,
      token: "0x1",
      selfAddress: "0x2",
      probeContract: "0x3",
      requiredWalletApiVersion: "0.10.3",
      priorStableId: RESOLVED,
      createInterveningNote: async () => {},
    });
    // Only Prepare #3 runs; #1 and #2 are taken from priorStableId.
    expect(prepares).toBe(1);
  });
});

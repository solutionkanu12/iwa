// G2 (Iwa V2 capability plan) — RED capability + trust-boundary tests for the
// V2 private-destination / shadow-account payout primitive on the dapp side.
//
// SUPERSEDED: the shadow-account path these tests red-teamed was abandoned after
// spike G2 — there is no canonical Starknet browser-wallet shadow-account /
// anonymizer infrastructure to build it on (blocker V2-02). V2 private pot
// collection ships instead as Candidate P (precommitted private destination
// note). The active dapp-side security + flow coverage for Candidate P is:
//   * src/chains/strk20/v2/privatePotCollection.test.ts  (the payout flow +
//     fail-closed / not-your-turn / already-collected guards)
//   * src/chains/strk20/v2/precommittedNoteId.test.ts    (note-id stability)
//   * src/chains/strk20/v2/payoutActionsV2.test.ts       (STRK20 settlement calls)
// The Cairo mirror of this supersession is
// contracts/starknet/tests/test_private_destination_capability_v2.cairo
// (every test `#[ignore]`d), with the Candidate P production matrix in
// contracts/starknet/tests/test_payout_settlement_v2.cairo.
//
// The six spike-dependent tests below are kept verbatim for security history
// and marked `it.skip` so they no longer make the frontend suite red. They
// would only be revived if a real shadow-account wallet primitive appeared and
// the G1 infrastructure gates were satisfied.
//
// The one still-live test here just documents the installed Wallet API type pin
// (@starknet-io/types-js 0.10.3) — a fact Candidate P still relies on.

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const nodeRequire = createRequire(import.meta.url);

type ShadowSpike = {
  ADAPTER_BOUNDARY_ALLOWED_OUT: string[];
  SPIKE_DEPENDENCY_MANIFEST: string[];
  buildShadowInvokeAction: (input: {
    dappName: string;
    nonce: bigint;
    calls: unknown[];
    collectPolicy: "all" | "diff" | "exact";
  }) => { type: string };
  deriveShadowCommitment: (input: {
    dappName: string;
    nonce: bigint;
  }) => Promise<{ derivedBy: string }>;
};

async function loadSpike(): Promise<ShadowSpike> {
  try {
    // The spike is a G3 artifact and intentionally absent. The RED signal is the
    // runtime failure below; keep the typecheck green in the meantime.
    // @ts-expect-error -- ./privateDestinationSpike does not exist until G3
    return (await import("./privateDestinationSpike")) as unknown as ShadowSpike;
  } catch {
    return expect.fail(
      "G3 BLOCKED: ./privateDestinationSpike does not exist. It is only " +
        "authorised after the G1 gates (real browser-wallet shadow-account " +
        "support + a verified anonymizer deployment).",
    );
  }
}

// ---------------------------------------------------------------------------
// A. Installed Wallet API capability (plan G3, checkbox 2)
//    "confirm installed Wallet API types 0.10.3 lack the required methods"
//    These run WITHOUT the spike.
// ---------------------------------------------------------------------------

describe("installed Wallet API shadow-account capability", () => {
  it("documents the installed @starknet-io/types-js version (baseline pin)", () => {
    const pkg = nodeRequire("@starknet-io/types-js/package.json") as {
      version: string;
    };
    expect(pkg.version).toBe("0.10.3");
  });

  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P coverage: privatePotCollection.test.ts. Kept for history, skipped.
  it.skip("FAILS (blocker V2-02): a shadow-account symbol exists in @starknet-io/types-js", async () => {
    const mod = await import("@starknet-io/types-js");
    const names = Object.keys(mod);
    expect(
      names.some((n) => /shadow/i.test(n)),
      "0.10.3 exposes only wallet_strk20InvokeTransaction / PrepareInvoke / " +
        "Balances; no wallet_strk20ShadowAccountCommitment",
    ).toBe(true);
  });

  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P coverage: payoutActionsV2.test.ts. Kept for history, skipped.
  it.skip("FAILS (blocker V2-02): STRK20_ACTION includes a shadow / compute-and-invoke variant", async () => {
    // Types are erased at runtime; assert via the spike's action builder, which
    // cannot exist without wallet support.
    const spike = await loadSpike();
    const action = spike.buildShadowInvokeAction({
      dappName: "IWA",
      nonce: 0n,
      calls: [],
      collectPolicy: "diff",
    });
    expect(action.type).toBe("shadow_account_invoke");
  });
});

// ---------------------------------------------------------------------------
// B. Trust boundary (design §6 acceptance proof, §8 "Must remain private")
// ---------------------------------------------------------------------------

describe("V2 shadow-account adapter trust boundary", () => {
  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P keeps its trust boundary in privatePotCollection.ts / the Cairo
  // matrix test_payout_settlement_v2.cairo. Kept for history, skipped.
  it.skip("FAILS: no identity key / viewing key / note witness crosses the adapter boundary", async () => {
    const spike = await loadSpike();
    expect(spike.ADAPTER_BOUNDARY_ALLOWED_OUT).toEqual(
      expect.arrayContaining(["dapp_name", "nonce", "identity_commitment"]),
    );
    expect(spike.ADAPTER_BOUNDARY_ALLOWED_OUT).not.toEqual(
      expect.arrayContaining([
        "identity_key",
        "viewing_key",
        "note_witness",
        "channel_secret",
        "nullifier",
      ]),
    );
  });

  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P coverage: precommittedNoteId.test.ts. Kept for history, skipped.
  it.skip("FAILS: the commitment is derived by the wallet, never reconstructed in the dapp", async () => {
    const spike = await loadSpike();
    const result = await spike.deriveShadowCommitment({
      dappName: "IWA",
      nonce: 0n,
    });
    expect(result.derivedBy).toBe("wallet");
    expect(result).not.toHaveProperty("identityKey");
  });

  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P coverage: payoutActionsV2.test.ts. Kept for history, skipped.
  it.skip("FAILS: the serialized action leaks no identity / viewing key / note witness", async () => {
    const spike = await loadSpike();
    const action = spike.buildShadowInvokeAction({
      dappName: "IWA",
      nonce: 0n,
      calls: [],
      collectPolicy: "diff",
    });
    expect(JSON.stringify(action)).not.toMatch(
      /identityKey|viewingKey|noteWitness|channelSecret/i,
    );
  });
});

// ---------------------------------------------------------------------------
// C. No key-custody fallback (SECURITY.md, plan global constraints)
// ---------------------------------------------------------------------------

describe("V2 must not fall back to a key-holding route", () => {
  // SUPERSEDED (shadow-account path abandoned after spike G2 — see file header).
  // Candidate P's no-key-custody guarantee is enforced in the Cairo matrix
  // test_payout_settlement_v2.cairo. Kept for history, skipped.
  it.skip("FAILS: the spike never depends on the key-holding Privacy SDK", async () => {
    const spike = await loadSpike();
    expect(spike.SPIKE_DEPENDENCY_MANIFEST).not.toEqual(
      expect.arrayContaining(["@starkware-libs/starknet-privacy-sdk"]),
    );
  });
});

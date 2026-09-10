// Parity + acceptance cover for the V2 destination-registration hash/sign.
//
// The fixed vector below is asserted on the Cairo side by
// contracts/starknet/tests/test_hash_parity_v2.cairo against the real
// `iwa_types_v2::{payout_dest_v2_hash, recovery_dest_v2_hash}`. Both suites run
// offline; if this file drifts from the chain, one of them fails.

import { describe, expect, it } from "vitest";

import { deriveMemberIdentity, verifyIwa } from "../iwaSigning";
import {
  DOMAIN_V2,
  IWA_PROTOCOL_VERSION_V2,
  payoutDestV2Hash,
  recoveryDestV2Hash,
  signPayoutDestinationV2,
  type DestinationV2HashArgs,
} from "./iwaSigningV2";

// EXACT vector shared with test_hash_parity_v2.cairo.
const VECTOR: DestinationV2HashArgs = {
  circleContract: "0x111",
  helper: "0x222",
  pool: "0x333",
  token: "0x444",
  circleId: 7,
  round: 3,
  memberRef: "0x555",
  noteId: "0x666",
  amount: 10_000_000n,
  destEpoch: 1,
  expiry: 1_900_000_000,
  nonce: "0x777",
};

const EXPECTED_PAYOUT = 0x43f02f1e9910b82ac9a9b508cf6b8b01c7e8a217eb28a5c006d71e651b5d5cbn;
const EXPECTED_RECOVERY = 0x112cf9ef76f805d1221726222634f67db9adba86889aa9babf136fed8ff00fdn;

describe("payoutDestV2Hash / recoveryDestV2Hash", () => {
  it("matches the Cairo fixed vector for the payout tag", () => {
    expect(payoutDestV2Hash(VECTOR)).toBe(EXPECTED_PAYOUT);
  });

  it("matches the Cairo fixed vector for the recovery tag", () => {
    expect(recoveryDestV2Hash(VECTOR)).toBe(EXPECTED_RECOVERY);
  });

  it("is domain-separated: payout and recovery differ for identical inputs", () => {
    expect(payoutDestV2Hash(VECTOR)).not.toBe(recoveryDestV2Hash(VECTOR));
  });

  it("binds the protocol version constant", () => {
    expect(IWA_PROTOCOL_VERSION_V2).toBe(2n);
  });

  it("changes when any bound field changes", () => {
    const base = payoutDestV2Hash(VECTOR);
    const fields: (keyof DestinationV2HashArgs)[] = [
      "circleContract",
      "helper",
      "pool",
      "token",
      "circleId",
      "round",
      "memberRef",
      "noteId",
      "amount",
      "destEpoch",
      "expiry",
      "nonce",
    ];
    for (const f of fields) {
      const mutated = { ...VECTOR, [f]: BigInt(VECTOR[f] as string | number | bigint) + 1n };
      expect(payoutDestV2Hash(mutated), `field ${f} is not bound`).not.toBe(base);
    }
  });

  it("uses the exact Cairo short-string domain tags", () => {
    expect(DOMAIN_V2.PAYOUT_DEST).toBe("IWA_PAYOUT_DEST_V2");
    expect(DOMAIN_V2.RECOVERY_DEST).toBe("IWA_RECOVERY_DEST_V2");
  });
});

describe("signPayoutDestinationV2", () => {
  const identity = deriveMemberIdentity("member", 0x1234n, 0xa11ce5eedn);

  it("produces a signature that satisfies the contract acceptance predicate", () => {
    const args: DestinationV2HashArgs = { ...VECTOR, memberRef: identity.memberRef };
    const signed = signPayoutDestinationV2(identity, args);
    expect(signed.hash).toBe(payoutDestV2Hash(args));
    // verifyIwa mirrors the full contract predicate, including the canonical
    // low-s guard — a true here is the same statement the chain makes.
    expect(verifyIwa(identity.authPublicKeyX, signed.hash, signed.r, signed.s)).toBe(true);
  });

  it("a signature for member A does NOT verify against member B's key", () => {
    const a = deriveMemberIdentity("A", 0x1n, 0xaaan);
    const b = deriveMemberIdentity("B", 0x2n, 0xbbbn);
    const args: DestinationV2HashArgs = { ...VECTOR, memberRef: a.memberRef };
    const signed = signPayoutDestinationV2(a, args);
    expect(verifyIwa(b.authPublicKeyX, signed.hash, signed.r, signed.s)).toBe(false);
  });
});

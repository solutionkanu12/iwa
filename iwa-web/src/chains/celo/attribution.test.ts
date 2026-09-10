// chains/celo/attribution.test.ts — every Iwa Celo tx must carry the
// registered Celo Builders tag exactly once. Tagging is Celo-only: it
// appends an ERC-8021 suffix via @celo/attribution-tags and never
// belongs in IWA Core or any other chain adapter.

import { describe, expect, it } from "vitest";
import { fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";

import { IWA_CELO_ATTRIBUTION_TAG } from "./config";
import { tagCeloCalldata } from "./attribution";

const TAG = "celo_448874a99d90";

const TRANSFER = ("0xa9059cbb" + "11".repeat(32) + "22".repeat(32)) as `0x${string}`;

function codesOf(data: string): string[] {
  const decoded = fromDataSuffix(data as `0x${string}`);
  if (decoded === null) throw new Error(`expected ERC-8021 suffix, got ${data}`);
  return decoded.codes;
}

describe("IWA Celo attribution tag", () => {
  it("is the registered Celo Builders tag", () => {
    expect(IWA_CELO_ATTRIBUTION_TAG).toBe(TAG);
  });
});

describe("tagCeloCalldata: empty calldata", () => {
  it("tags undefined, null, empty string, and 0x so the tag is present exactly once", () => {
    for (const empty of [undefined, null, "", "0x", "0X"]) {
      const tagged = tagCeloCalldata(empty);
      expect(codesOf(tagged).filter((c) => c === TAG)).toEqual([TAG]);
      expect(tagged).toBe(toDataSuffix(TAG));
    }
  });
});

describe("tagCeloCalldata: existing calldata", () => {
  it("preserves the original body and appends the tag", () => {
    const tagged = tagCeloCalldata(TRANSFER);
    expect(tagged.startsWith(TRANSFER)).toBe(true);
    expect(tagged.length).toBeGreaterThan(TRANSFER.length);
    expect(codesOf(tagged)).toEqual([TAG]);
    expect(tagged).toBe(`${TRANSFER}${toDataSuffix(TAG).slice(2)}`);
  });
});

describe("tagCeloCalldata: multiple existing suffix codes", () => {
  it("keeps existing ERC-8021 codes and adds the Iwa tag once", () => {
    const body = "0xcafe";
    const existing = toDataSuffix(["oldcode_one", "oldcode_two"]);
    const calldata = `${body}${existing.slice(2)}`;
    const tagged = tagCeloCalldata(calldata);
    expect(tagged.startsWith(body)).toBe(true);
    expect(codesOf(tagged)).toEqual(["oldcode_one", "oldcode_two", TAG]);
    expect(codesOf(tagged).filter((c) => c === TAG)).toHaveLength(1);
  });
});

describe("tagCeloCalldata: exact tag present once", () => {
  it("does not duplicate the Iwa tag when the calldata is already tagged", () => {
    const once = tagCeloCalldata(TRANSFER);
    const twice = tagCeloCalldata(once);
    expect(twice).toBe(once);
    expect(codesOf(twice).filter((c) => c === TAG)).toHaveLength(1);
  });

  it("keeps a pre-existing Iwa tag once when other codes are also present", () => {
    const body = "0xdeadbeef";
    const existing = toDataSuffix(["oldcode_one", TAG, "oldcode_two"]);
    const tagged = tagCeloCalldata(`${body}${existing.slice(2)}`);
    expect(codesOf(tagged).filter((c) => c === TAG)).toHaveLength(1);
    expect(codesOf(tagged)).toEqual(["oldcode_one", TAG, "oldcode_two"]);
    expect(tagged.startsWith(body)).toBe(true);
  });
});

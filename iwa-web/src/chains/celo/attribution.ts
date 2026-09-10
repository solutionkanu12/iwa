// chains/celo/attribution.ts — ERC-8021 tagging for Iwa Celo transactions.
//
// Every Celo send through this adapter appends the registered Iwa tag
// using @celo/attribution-tags. Existing calldata is preserved. Existing
// suffix codes are preserved. The Iwa tag appears exactly once.
//
// This module is Celo-specific. IWA Core must not import it.

import {
  ERC_8021_MARKER,
  fromDataSuffix,
  toDataSuffix,
} from "@celo/attribution-tags";

import { IWA_CELO_ATTRIBUTION_TAG } from "./config";

export type HexData = `0x${string}`;

/**
 * Returns calldata with the Iwa Celo attribution suffix applied.
 *
 * Empty/missing data becomes the suffix alone. Existing function calldata
 * is kept as the prefix. Existing ERC-8021 codes are kept and the Iwa tag
 * is added if missing. Re-tagging is idempotent.
 */
export function tagCeloCalldata(data?: string | null): HexData {
  const normalized = normalizeCalldata(data);
  const { body, codes } = splitAttribution(normalized);
  const merged = mergeCodes(codes, IWA_CELO_ATTRIBUTION_TAG);
  const tagged = concatHex(body, toDataSuffix(merged));
  assertIwaCeloAttribution(tagged);
  return tagged;
}

/** Fail closed: the registered Iwa tag must be present exactly once. */
export function assertIwaCeloAttribution(data: string): void {
  const decoded = fromDataSuffix(data as HexData);
  if (decoded === null) {
    throw new Error("Celo transaction refused: attribution suffix missing");
  }
  const count = decoded.codes.filter((c) => c === IWA_CELO_ATTRIBUTION_TAG).length;
  if (count !== 1) {
    throw new Error(
      `Celo transaction refused: attribution tag ${IWA_CELO_ATTRIBUTION_TAG} must appear exactly once`,
    );
  }
}

function normalizeCalldata(data?: string | null): HexData {
  if (data == null || data === "") return "0x";
  if (data === "0x" || data === "0X") return "0x";
  if (!data.startsWith("0x") && !data.startsWith("0X")) {
    throw new Error("Celo transaction refused: calldata is not 0x-prefixed hex");
  }
  const raw = data.slice(2);
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error("Celo transaction refused: calldata is not valid hex");
  }
  return `0x${raw}`;
}

function splitAttribution(data: HexData): { body: HexData; codes: string[] } {
  const decoded = fromDataSuffix(data);
  if (decoded === null) {
    if (endsWithMarker(data)) {
      throw new Error(
        "Celo transaction refused: calldata has an ERC-8021 marker that could not be decoded",
      );
    }
    return { body: data, codes: [] };
  }

  const suffix = toDataSuffix(decoded.codes);
  const suffixHex = suffix.slice(2).toLowerCase();
  const dataHex = data.slice(2);
  if (!dataHex.toLowerCase().endsWith(suffixHex)) {
    throw new Error(
      "Celo transaction refused: decoded attribution suffix did not match calldata",
    );
  }
  const bodyHex = dataHex.slice(0, dataHex.length - suffixHex.length);
  return {
    body: bodyHex.length === 0 ? "0x" : (`0x${bodyHex}` as HexData),
    codes: decoded.codes,
  };
}

function endsWithMarker(data: HexData): boolean {
  return data.slice(2).toLowerCase().endsWith(ERC_8021_MARKER.slice(2).toLowerCase());
}

function mergeCodes(existing: string[], ours: string): string[] {
  if (existing.includes(ours)) return existing;
  return [...existing, ours];
}

function concatHex(body: HexData, suffix: HexData): HexData {
  if (body === "0x") return suffix;
  return `0x${body.slice(2)}${suffix.slice(2)}`;
}

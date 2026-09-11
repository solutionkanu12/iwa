// chains/celo/circleCalldata.ts — IwaCircleCelo selectors.
// Attribution is appended by CeloTransactionAdapter, never stored on chain.

import { id } from "ethers";
import type { HexData } from "./attribution";
import { normalizeAddress } from "./erc20";

function selector(signature: string): HexData {
  return id(signature).slice(0, 10) as HexData;
}

export function encodeContribute(): HexData {
  return selector("contribute()");
}

export function encodeCollect(): HexData {
  return selector("collect()");
}

export function encodeFinalizeDefault(member: string): HexData {
  const addr = normalizeAddress(member).slice(2).padStart(64, "0");
  return `0x${selector("finalizeDefault(address)").slice(2)}${addr}`;
}

// On-chain evidence for Celo circle organizer authority.
//
// Mirrors chainVerify.ts's stated philosophy for Starknet: an address is
// public, and a request body is just a claim, so the claim is checked
// against the chain rather than trusted or cached. `IwaCircleCelo.organizer`
// is set once, in the constructor, to whoever deployed it, and it grants no
// fund, payout, pause, upgrade, rescue, or override power in the contract —
// it exists purely so this module has something authoritative to read.
//
// This module holds no keys, signs nothing, and only ever reads.

import { id as keccakId } from "ethers";

export const CELO_MAINNET_CHAIN_ID = 42220;

/** keccak256("organizer()")[0:4]. Computed once at module load, not hand-copied. */
const ORGANIZER_SELECTOR = keccakId("organizer()").slice(0, 10);

export type CeloOrganizerReadResult =
  | { ok: true; organizer: string }
  /** The contract exists and answered, and the answer disagrees with the claim. Final. */
  | { ok: false; reason: "no_code" | "organizer_call_failed" | "malformed_organizer_response" }
  /** The chain could not be reached, or is not the expected one. Retryable, not a verdict. */
  | { ok: false; reason: "rpc_unavailable" | "wrong_chain" };

/**
 * The minimal provider surface this module needs. `ethers.JsonRpcProvider`
 * (and any ethers `Provider`) satisfies this structurally, so production
 * code passes one directly; tests inject a small fake instead of mocking
 * ethers itself.
 */
export interface MinimalCeloProvider {
  getNetwork(): Promise<{ chainId: bigint }>;
  getCode(address: string): Promise<string>;
  call(transaction: { to: string; data: string }): Promise<string>;
}

export interface CeloOrganizerReader {
  /** Reads `organizer()` from the deployed circle at `circleContract`. Never throws. */
  readOrganizer(circleContract: string): Promise<CeloOrganizerReadResult>;
}

function decodeAddressResult(result: string): string | null {
  if (typeof result !== "string" || !result.startsWith("0x")) return null;
  const hex = result.slice(2);
  // A `returns (address)` ABI-encodes to exactly one 32-byte word.
  if (hex.length !== 64) return null;
  const addressHex = hex.slice(24); // last 20 bytes
  if (!/^[0-9a-fA-F]{40}$/.test(addressHex)) return null;
  // The leading 12 bytes of a correctly-encoded address word are always
  // zero-padding; reject anything else rather than silently truncating it.
  if (!/^0{24}$/.test(hex.slice(0, 24))) return null;
  return `0x${addressHex}`;
}

export class RpcCeloOrganizerReader implements CeloOrganizerReader {
  constructor(private readonly provider: MinimalCeloProvider) {}

  async readOrganizer(circleContract: string): Promise<CeloOrganizerReadResult> {
    try {
      const network = await this.provider.getNetwork();
      if (Number(network.chainId) !== CELO_MAINNET_CHAIN_ID) {
        return { ok: false, reason: "wrong_chain" };
      }
    } catch {
      return { ok: false, reason: "rpc_unavailable" };
    }

    let code: string;
    try {
      code = await this.provider.getCode(circleContract);
    } catch {
      return { ok: false, reason: "rpc_unavailable" };
    }
    if (code === "0x" || code === "0x0" || code.length === 0) {
      return { ok: false, reason: "no_code" };
    }

    let result: string;
    try {
      result = await this.provider.call({ to: circleContract, data: ORGANIZER_SELECTOR });
    } catch {
      return { ok: false, reason: "organizer_call_failed" };
    }

    const organizer = decodeAddressResult(result);
    if (organizer === null) return { ok: false, reason: "malformed_organizer_response" };
    return { ok: true, organizer };
  }
}

// What a Celo/EVM signature actually authorizes.
//
// Distinct scheme from authBinding.ts's SNIP-12/Starknet domain, deliberately:
// different name, different hash algorithm (EIP-712 keccak256 vs SNIP-12's
// Pedersen/Poseidon-based hash), and a different verification path (ECDSA
// signature recovery, not an on-chain is_valid_signature call — a standard
// EOA wallet needs no contract to ask). A signature produced for one scheme
// cannot be replayed as the other: the underlying cryptography is
// incompatible, not merely the field names.
//
// chainId lives in the EIP-712 domain, not as a duplicated message field.
// That is where EIP-712 conventionally binds it (as EIP-2612 permits and
// Permit2 do), and it is enforced structurally here: the domain this module
// builds always names CELO_MAINNET_CHAIN_ID itself. A client cannot supply a
// different chainId at all — there is no field for it — so a signature
// produced against any other chain id recovers to an unrelated address
// against this domain and is rejected as a bad signer, not accepted and then
// checked.
//
// THE SERVER DERIVES circleId, circleContract, AND memberRef FROM THE
// REQUEST IT IS ACTUALLY HANDLING, exactly as authBinding.ts already
// documents for the Starknet scheme. Nothing here reads a second,
// client-supplied copy of those fields to compare against — there is only
// the one used for recovery, taken from the top-level request body already
// validated by the route.

import { verifyTypedData } from "ethers";

/** Celo mainnet. The only chain this scheme authorizes anything for. */
export const CELO_MAINNET_CHAIN_ID = 42220;

/**
 * The operations a Celo/EVM signature can authorize. Explicit and closed,
 * mirroring authBinding.ts's AUTH_ACTIONS: an action is never inferred from
 * a path, and each authenticated route declares exactly one.
 */
export const CELO_AUTH_ACTIONS = {
  accountBindingInvite: "account-binding:invite",
  /**
   * Reads one member's binding status (none/invited/bound) without ever
   * disclosing which account it is bound to. Organizer-only, same on-chain
   * verification as the invite action, distinct action string so a
   * signature minted for one can never be spent as the other.
   */
  accountBindingStatus: "account-binding:status",
} as const;

export type CeloAuthAction = (typeof CELO_AUTH_ACTIONS)[keyof typeof CELO_AUTH_ACTIONS];

export interface CeloAuthorizationMessage {
  action: CeloAuthAction;
  circleId: string;
  /** The deployed IwaCircleCelo address this authorization is for. Checked against organizer() on chain, never trusted from the message alone. */
  circleContract: string;
  memberRef: string;
  /** The address this authorization claims to be signed by. Verified against the recovered signer, never trusted on its own. */
  organizer: string;
  /** 32 random bytes, hex-encoded. Client-generated; the server only ever consumes it once. */
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A felt-free EIP-712 domain: different `name` from authBinding.ts's "Iwa" for extra separation. */
export function celoAuthorizationTypedData(message: CeloAuthorizationMessage) {
  return {
    domain: {
      name: "Iwa-Celo",
      version: "1",
      chainId: CELO_MAINNET_CHAIN_ID,
    },
    types: {
      AccountBindingInviteAuthorization: [
        { name: "action", type: "string" },
        { name: "circleId", type: "string" },
        { name: "circleContract", type: "address" },
        { name: "memberRef", type: "string" },
        { name: "organizer", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    message: {
      action: message.action,
      circleId: message.circleId,
      circleContract: message.circleContract,
      memberRef: message.memberRef,
      organizer: message.organizer,
      nonce: message.nonce,
      expiresAt: message.expiresAt,
    },
  };
}

/** Recovers the signer address, or null if the signature does not recover at all. */
export function recoverCeloAuthSigner(
  message: CeloAuthorizationMessage,
  signature: string,
): string | null {
  const typed = celoAuthorizationTypedData(message);
  try {
    return verifyTypedData(typed.domain, typed.types, typed.message, signature);
  } catch {
    return null;
  }
}

/** Lowercase-normalized comparison form. Mirrors the frontend's own normalizeAddress. */
export function normalizeEvmAddress(address: string): string {
  return `0x${address.slice(2).toLowerCase()}`;
}

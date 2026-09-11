// chains/celo/organizerAuthorization.ts — the EIP-712 authorization an
// organizer's wallet signs to mint or check an account-binding invite.
//
// This must stay byte-identical in shape to backend/src/celoAuthBinding.ts's
// `celoAuthorizationTypedData`: domain name/version/chainId, the type name
// and field order, and which fields feed the hash. The two are separate
// files in separate packages (frontend/backend have no shared module today),
// so the fixed-vector test in this file's test suite is what catches any
// drift — the same discipline this codebase's other chain-specific
// authorization schemes already use for their own signed messages.
//
// This module never sees a private key. It builds the message the wallet is
// asked to sign and calls the wallet's own EIP-712 signing method; the
// signature itself is the only thing that ever leaves the wallet.

import { eip1193Provider, signTypedDataV4 } from "./wallet";
import type { EthereumProviderLike } from "../ethereum/wallet";
import { CELO_MAINNET } from "./config";

/** How long a signed authorization is asked to remain valid. Must not exceed the backend's CELO_AUTH_MAX_TTL_SECONDS (5 minutes). */
export const AUTHORIZATION_TTL_SECONDS = 4 * 60;

export const CELO_AUTH_ACTIONS = {
  accountBindingInvite: "account-binding:invite",
  accountBindingStatus: "account-binding:status",
} as const;

export type CeloAuthAction = (typeof CELO_AUTH_ACTIONS)[keyof typeof CELO_AUTH_ACTIONS];

export interface CeloAuthorizationMessage {
  action: CeloAuthAction;
  circleId: string;
  circleContract: string;
  memberRef: string;
  organizer: string;
  nonce: string;
  expiresAt: number;
}

export interface SignedCeloAuthorization {
  organizer: string;
  nonce: string;
  expiresAt: number;
  signature: string;
}

/** Must match backend/src/celoAuthBinding.ts's celoAuthorizationTypedData exactly. */
export function celoAuthorizationTypedData(message: CeloAuthorizationMessage) {
  return {
    domain: {
      name: "Iwa-Celo",
      version: "1",
      chainId: CELO_MAINNET.chainIdNumber,
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

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Builds and signs an organizer authorization for exactly one action,
 * circle, contract and member. The nonce is generated here, client-side,
 * and consumed by the backend at most once.
 */
export async function signOrganizerAuthorization(
  provider: EthereumProviderLike,
  params: { action: CeloAuthAction; circleId: string; circleContract: string; memberRef: string; organizer: string },
  now: () => number = () => Date.now(),
): Promise<SignedCeloAuthorization> {
  const message: CeloAuthorizationMessage = {
    action: params.action,
    circleId: params.circleId,
    circleContract: params.circleContract,
    memberRef: params.memberRef,
    organizer: params.organizer,
    nonce: randomNonce(),
    expiresAt: Math.floor(now() / 1000) + AUTHORIZATION_TTL_SECONDS,
  };
  const typedData = celoAuthorizationTypedData(message);
  const signature = await signTypedDataV4(provider, params.organizer, typedData);
  return {
    organizer: message.organizer,
    nonce: message.nonce,
    expiresAt: message.expiresAt,
    signature,
  };
}

export { eip1193Provider };

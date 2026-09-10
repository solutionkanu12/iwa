// chains/strk20/v2/deploymentV2.ts — the V2 (Candidate P private pot collection)
// deployment, kept SEPARATE from the V1 `starknetProduction.ts` so V1 stays
// untouched and the V2 path is version-routed and inert until it is deployed.
//
// IwaCircleV2 / IwaStrk20HelperV2 are NOT deployed. Every address below is an
// empty string; `isV2Deployed()` is false; every V2 entry point in the UI is
// unreachable until a human fills these in from a real mainnet declare/deploy
// and re-runs the class-hash preflight.
//
// The pool, tokens, surplus sink and RPC are shared with V1 and re-exported
// from `starknetProduction.ts` — V2 integrates with the SAME pinned pool.

import { STARKNET_MAINNET } from "../../starknetProduction";

export interface StarknetDeploymentV2 {
  /** IwaCircleV2. V1 accounting behaviour + Candidate P settlement. Holds no tokens. */
  readonly iwaCircleV2: string;
  readonly iwaCircleV2Class: string;
  /** IwaStrk20HelperV2. The pinned STRK20 callback for IwaCircleV2. */
  readonly iwaHelperV2: string;
  readonly iwaHelperV2Class: string;
  /** Shared with V1. */
  readonly privacyPool: string;
  readonly usdcToken: string;
  readonly strkToken: string;
  readonly surplusSink: string;
  readonly chainId: string;
}

/**
 * Filled from a real mainnet deployment. Until then the V2 path is unreachable.
 * A stale or guessed address here is a correctness bug — leave it empty.
 */
export const STARKNET_MAINNET_V2: StarknetDeploymentV2 = {
  iwaCircleV2: "",
  iwaCircleV2Class: "",
  iwaHelperV2: "",
  iwaHelperV2Class: "",

  privacyPool: STARKNET_MAINNET.privacyPool,
  usdcToken: STARKNET_MAINNET.usdcToken,
  strkToken: STARKNET_MAINNET.strkToken,
  surplusSink: STARKNET_MAINNET.surplusSink,
  chainId: STARKNET_MAINNET.chainId,
};

/** True only when both V2 contract addresses are set to non-empty values. */
export function isV2Deployed(dep: StarknetDeploymentV2 = STARKNET_MAINNET_V2): boolean {
  return (
    dep.iwaCircleV2.trim() !== "" &&
    dep.iwaHelperV2.trim() !== "" &&
    dep.iwaCircleV2Class.trim() !== "" &&
    dep.iwaHelperV2Class.trim() !== ""
  );
}

export class V2NotDeployedError extends Error {
  constructor() {
    super(
      "IWA V2 (private pot collection) is not deployed on Starknet mainnet yet. " +
        "IwaCircleV2 / IwaStrk20HelperV2 addresses are unset in deploymentV2.ts.",
    );
    this.name = "V2NotDeployedError";
  }
}

export interface V2Addresses {
  readonly circleV2: string;
  readonly helperV2: string;
  readonly pool: string;
  readonly chainId: string;
}

/**
 * The resolved V2 addresses, or a hard error. The orchestration modules take
 * addresses as explicit parameters (so they are testable without this file);
 * the UI calls this to get the production values.
 */
export function requireV2Deployment(dep: StarknetDeploymentV2 = STARKNET_MAINNET_V2): V2Addresses {
  if (!isV2Deployed(dep)) throw new V2NotDeployedError();
  return {
    circleV2: dep.iwaCircleV2,
    helperV2: dep.iwaHelperV2,
    pool: dep.privacyPool,
    chainId: dep.chainId,
  };
}

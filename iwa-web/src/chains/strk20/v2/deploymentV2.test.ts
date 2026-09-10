import { describe, expect, it } from "vitest";

import { STARKNET_MAINNET } from "../../starknetProduction";
import {
  STARKNET_MAINNET_V2,
  V2NotDeployedError,
  isV2Deployed,
  requireV2Deployment,
} from "./deploymentV2";

describe("deploymentV2", () => {
  it("ships with the V2 contracts UNSET — the path is inert until a real deploy", () => {
    expect(STARKNET_MAINNET_V2.iwaCircleV2).toBe("");
    expect(STARKNET_MAINNET_V2.iwaHelperV2).toBe("");
    expect(isV2Deployed()).toBe(false);
  });

  it("shares the pinned pool and tokens with V1", () => {
    expect(STARKNET_MAINNET_V2.privacyPool).toBe(STARKNET_MAINNET.privacyPool);
    expect(STARKNET_MAINNET_V2.usdcToken).toBe(STARKNET_MAINNET.usdcToken);
    expect(STARKNET_MAINNET_V2.chainId).toBe(STARKNET_MAINNET.chainId);
  });

  it("requireV2Deployment throws while unset", () => {
    expect(() => requireV2Deployment()).toThrow(V2NotDeployedError);
  });

  it("isV2Deployed only true when BOTH addresses and BOTH class hashes are set", () => {
    const base = {
      ...STARKNET_MAINNET_V2,
      iwaCircleV2: "0x1",
      iwaHelperV2: "0x2",
      iwaCircleV2Class: "0x3",
      iwaHelperV2Class: "0x4",
    };
    expect(isV2Deployed(base)).toBe(true);
    expect(isV2Deployed({ ...base, iwaHelperV2: "" })).toBe(false);
    expect(isV2Deployed({ ...base, iwaCircleV2Class: "  " })).toBe(false);
  });

  it("requireV2Deployment returns the resolved addresses once set", () => {
    const dep = {
      ...STARKNET_MAINNET_V2,
      iwaCircleV2: "0xc0",
      iwaHelperV2: "0xe0",
      iwaCircleV2Class: "0xcc",
      iwaHelperV2Class: "0xee",
    };
    expect(requireV2Deployment(dep)).toEqual({
      circleV2: "0xc0",
      helperV2: "0xe0",
      pool: STARKNET_MAINNET.privacyPool,
      chainId: STARKNET_MAINNET.chainId,
    });
  });
});

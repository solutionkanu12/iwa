import { describe, expect, it } from "vitest";
import { CELO_MAINNET, CNGN_MAINNET } from "./config";
import { assertCeloCngnBinding } from "./contribution";

describe("canonical cNGN on Celo mainnet", () => {
  it("pins the verified Africa Stablecoin Consortium token, not Mento NGNm", () => {
    expect(CNGN_MAINNET.address).toBe("0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f");
    expect(CNGN_MAINNET.chainId).toBe(42220);
    expect(CNGN_MAINNET.chainId).toBe(CELO_MAINNET.chainIdNumber);
    expect(CNGN_MAINNET.decimals).toBe(6);
    expect(CNGN_MAINNET.symbol).toBe("cNGN");
    expect(CNGN_MAINNET.address.toLowerCase()).not.toBe(
      "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71".toLowerCase(),
    );
  });

  it("rejects a binding on the wrong chain or token", () => {
    expect(() =>
      assertCeloCngnBinding({
        circleId: "c1",
        chainId: 11142220,
        token: CNGN_MAINNET.address,
        circleContract: "0x0000000000000000000000000000000000000001",
        contributionAmount: "1",
      }),
    ).toThrow(/mainnet/);
    expect(() =>
      assertCeloCngnBinding({
        circleId: "c1",
        chainId: 42220,
        token: "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71",
        circleContract: "0x0000000000000000000000000000000000000001",
        contributionAmount: "1",
      }),
    ).toThrow(/cNGN/);
  });
});

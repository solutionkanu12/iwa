import { describe, expect, it } from "vitest";
import {
  decodeUint256,
  encodeApprove,
  encodeTransfer,
  parseBaseUnits,
} from "./erc20";

const TO = "0x0000000000000000000000000000000000000001";

describe("erc20 encoding", () => {
  it("encodes transfer and approve with the amount in the tail word", () => {
    const amount = 5_000_000n;
    const transfer = encodeTransfer(TO, amount);
    expect(transfer.startsWith("0xa9059cbb")).toBe(true);
    expect(transfer.endsWith(amount.toString(16).padStart(64, "0"))).toBe(true);
    expect(transfer.includes(TO.slice(2))).toBe(true);

    const approve = encodeApprove(TO, amount);
    expect(approve.startsWith("0x095ea7b3")).toBe(true);
    expect(approve.endsWith(amount.toString(16).padStart(64, "0"))).toBe(true);
  });

  it("parses base-unit amounts and hex results", () => {
    expect(parseBaseUnits("5000000")).toBe(5_000_000n);
    expect(decodeUint256("0x" + (5_000_000n).toString(16).padStart(64, "0"))).toBe(
      5_000_000n,
    );
    expect(() => parseBaseUnits("0")).toThrow(/positive/);
    expect(() => parseBaseUnits("1.5")).toThrow(/base-unit/);
  });
});

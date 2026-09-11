import { expect } from "chai";
import {
  CNGN_MAINNET,
  MAX_MEMBERS,
  validateDeployConfig,
  type CircleDeployConfig,
} from "../../deploy/circleConfig";

const MEMBER_1 = "0x0000000000000000000000000000000000000001";
const MEMBER_2 = "0x0000000000000000000000000000000000000002";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function validConfig(overrides: Partial<CircleDeployConfig> = {}): CircleDeployConfig {
  return {
    token: CNGN_MAINNET,
    contributionAmount: "5000000",
    cadenceSeconds: 604_800,
    gracePeriodSeconds: 86_400,
    members: [MEMBER_1, MEMBER_2],
    ...overrides,
  };
}

describe("validateDeployConfig", function () {
  it("accepts a well-formed config with no errors", function () {
    expect(validateDeployConfig(validConfig())).to.deep.equal([]);
  });

  it("accepts a zero grace period: the contract itself allows no late window", function () {
    expect(validateDeployConfig(validConfig({ gracePeriodSeconds: 0 }))).to.deep.equal([]);
  });

  it("rejects a token that is not canonical cNGN", function () {
    const errors = validateDeployConfig(validConfig({ token: MEMBER_1 }));
    expect(errors.some((e) => e.includes("canonical cNGN"))).to.equal(true);
  });

  it("rejects a malformed token address", function () {
    const errors = validateDeployConfig(validConfig({ token: "not-an-address" }));
    expect(errors.some((e) => e.includes("token is not a valid EVM address"))).to.equal(true);
  });

  it("rejects a zero contribution amount", function () {
    const errors = validateDeployConfig(validConfig({ contributionAmount: "0" }));
    expect(errors.some((e) => e.includes("contributionAmount must be greater than zero"))).to.equal(
      true,
    );
  });

  it("rejects a non-numeric contribution amount", function () {
    const errors = validateDeployConfig(validConfig({ contributionAmount: "abc" }));
    expect(errors.some((e) => e.includes("not a valid integer string"))).to.equal(true);
  });

  it("rejects a zero cadence", function () {
    const errors = validateDeployConfig(validConfig({ cadenceSeconds: 0 }));
    expect(errors.some((e) => e.includes("cadenceSeconds must be a positive integer"))).to.equal(
      true,
    );
  });

  it("rejects a negative grace period", function () {
    const errors = validateDeployConfig(validConfig({ gracePeriodSeconds: -1 }));
    expect(
      errors.some((e) => e.includes("gracePeriodSeconds must be a non-negative integer")),
    ).to.equal(true);
  });

  it("rejects fewer than 2 members", function () {
    const errors = validateDeployConfig(validConfig({ members: [MEMBER_1] }));
    expect(errors.some((e) => e.includes("member count must be between"))).to.equal(true);
  });

  it("rejects more than 32 members", function () {
    const members = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) =>
      `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const errors = validateDeployConfig(validConfig({ members }));
    expect(errors.some((e) => e.includes("member count must be between"))).to.equal(true);
  });

  it("accepts exactly 32 members", function () {
    const members = Array.from({ length: MAX_MEMBERS }, (_, i) =>
      `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    expect(validateDeployConfig(validConfig({ members }))).to.deep.equal([]);
  });

  it("rejects a zero-address member", function () {
    const errors = validateDeployConfig(validConfig({ members: [MEMBER_1, ZERO_ADDRESS] }));
    expect(errors.some((e) => e.includes("zero address"))).to.equal(true);
  });

  it("rejects a malformed member address", function () {
    const errors = validateDeployConfig(validConfig({ members: [MEMBER_1, "not-an-address"] }));
    expect(errors.some((e) => e.includes("member is not a valid EVM address"))).to.equal(true);
  });

  it("rejects duplicate members, case-insensitively", function () {
    const errors = validateDeployConfig(
      validConfig({ members: [MEMBER_1, MEMBER_1.toUpperCase().replace("0X", "0x")] }),
    );
    expect(errors.some((e) => e.includes("duplicate member address"))).to.equal(true);
  });

  it("reports every problem at once, not just the first", function () {
    const errors = validateDeployConfig(
      validConfig({ contributionAmount: "0", cadenceSeconds: 0, members: [MEMBER_1] }),
    );
    expect(errors.length).to.be.greaterThanOrEqual(3);
  });
});

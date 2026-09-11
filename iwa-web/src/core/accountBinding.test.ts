import { describe, expect, it } from "vitest";
import {
  assertBoundAccount,
  InMemoryMemberAccountDirectory,
} from "./accountBinding";

describe("assertBoundAccount", () => {
  it("passes when the registered binding matches exactly", () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    expect(() => assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xaa")).not.toThrow();
  });

  it("fails closed when no account is registered for the member", () => {
    const dir = new InMemoryMemberAccountDirectory();
    expect(() => assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xaa")).toThrow(
      /no account is registered/,
    );
  });

  it("fails closed when the account does not match the registered one", () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    expect(() => assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xbb")).toThrow(
      /does not match the registered/,
    );
  });

  it("fails closed when the chain does not match the registered one", () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    expect(() => assertBoundAccount(dir, "c1", "m1", "starknet:SN_MAIN", "0xaa")).toThrow(
      /wrong chain/,
    );
  });

  it("does not leak a binding registered for a different member", () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    expect(() => assertBoundAccount(dir, "c1", "m2", "celo:42220", "0xaa")).toThrow(
      /no account is registered/,
    );
  });

  it("does not leak a binding registered for a different circle", () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    expect(() => assertBoundAccount(dir, "c2", "m1", "celo:42220", "0xaa")).toThrow(
      /no account is registered/,
    );
  });
});

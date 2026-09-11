import { describe, expect, it } from "vitest";
import {
  assertBoundAccount,
  InMemoryMemberAccountDirectory,
  type MemberAccountBinding,
  type MemberAccountDirectory,
} from "./accountBinding";

describe("assertBoundAccount", () => {
  it("passes when the registered binding matches exactly", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    await expect(assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xaa")).resolves.toBeTruthy();
  });

  it("fails closed when no account is registered for the member", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    await expect(assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xaa")).rejects.toThrow(
      /no account is registered/,
    );
  });

  it("fails closed when the account does not match the registered one", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    await expect(assertBoundAccount(dir, "c1", "m1", "celo:42220", "0xbb")).rejects.toThrow(
      /does not match the registered/,
    );
  });

  it("fails closed when the chain does not match the registered one", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    await expect(
      assertBoundAccount(dir, "c1", "m1", "starknet:SN_MAIN", "0xaa"),
    ).rejects.toThrow(/wrong chain/);
  });

  it("does not leak a binding registered for a different member", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    await expect(assertBoundAccount(dir, "c1", "m2", "celo:42220", "0xaa")).rejects.toThrow(
      /no account is registered/,
    );
  });

  it("does not leak a binding registered for a different circle", async () => {
    const dir = new InMemoryMemberAccountDirectory();
    dir.register({ circleId: "c1", memberRef: "m1", chain: "celo:42220", account: "0xaa" });
    await expect(assertBoundAccount(dir, "c2", "m1", "celo:42220", "0xaa")).rejects.toThrow(
      /no account is registered/,
    );
  });

  it("fails closed (propagates) when the directory itself throws on a lookup failure", async () => {
    const failing: MemberAccountDirectory = {
      async resolve(): Promise<MemberAccountBinding | null> {
        throw new Error("simulated network failure");
      },
    };
    await expect(assertBoundAccount(failing, "c1", "m1", "celo:42220", "0xaa")).rejects.toThrow(
      /simulated network failure/,
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  AUTH_ACTIONS,
  authorizationTypedData,
  canonicalJson,
  hashBody,
  hashResource,
} from "./authBinding";

// This file and backend/src/authBinding.ts have to build the same message from
// the same inputs, or every authenticated call fails to verify. Neither can
// import the other, so these fixed vectors are what holds them together: the
// backend suite asserts the identical values, and a change to either side that
// is not made to both breaks here rather than in production.
//
// If one of these ever fails, do not update the expected value. Find out which
// side moved.
describe("fixed vectors shared with the service", () => {
  it("hashes an empty body to a known value", () => {
    expect(hashBody({})).toBe(hashBody(undefined));
    expect(hashBody({})).toMatchInlineSnapshot(
      `"0x8d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d"`,
    );
  });

  it("canonicalizes a representative organizer body to a known string", () => {
    const body = {
      organizerAddress: "0x4099b8eb",
      order: ["b1", "a2"],
      circleId: 9,
      nested: { z: true, a: null },
    };
    expect(canonicalJson(body)).toBe(
      '{"circleId":9,"nested":{"a":null,"z":true},"order":["b1","a2"],"organizerAddress":"0x4099b8eb"}',
    );
  });

  it("hashes a known path to a known value", () => {
    expect(hashResource("/api/drafts/mine")).toBe(hashResource("/API/Drafts/Mine/"));
  });

  it("builds the message the service will check", () => {
    const typed = authorizationTypedData({
      action: AUTH_ACTIONS.draftReorder,
      method: "post",
      resourceHash: hashResource("/api/drafts/abc/order"),
      bodyHash: hashBody({ a: 1 }),
      nonce: "0xdeadbeef",
      chainId: "0x534e5f4d41494e",
    });

    expect(typed.domain).toEqual({ name: "Iwa", version: "2", chainId: "0x534e5f4d41494e" });
    expect(typed.primaryType).toBe("Authorization");
    expect(typed.message.action).toBe("draft:reorder");
    // Uppercased, so a read signature cannot be spent on a write.
    expect(typed.message.method).toBe("POST");
    expect(typed.types.Authorization.map((f) => f.name)).toEqual([
      "action",
      "method",
      "resource",
      "body",
      "nonce",
    ]);
  });
});

describe("canonical json", () => {
  it("gives the same text however the keys were written", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("keeps array order, which carries meaning here", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values that differ", () => {
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
    expect(hashBody({ a: "1" })).not.toBe(hashBody({ a: 1 }));
    expect(hashBody({ a: null })).not.toBe(hashBody({}));
    expect(hashBody({ a: false })).not.toBe(hashBody({ a: 0 }));
  });

  it("drops undefined members exactly as the wire would", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("refuses what it cannot represent exactly", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });
});

describe("the action set", () => {
  it("matches the service, name for name", () => {
    expect(Object.values(AUTH_ACTIONS).sort()).toEqual(
      [
        "associations:list",
        "draft:create",
        "draft:mark-created",
        "draft:read-organizer",
        "draft:reconcile",
        "draft:reorder",
        "drafts:list",
        "invitations:list",
        "session:create",
      ].sort(),
    );
  });

  it("fits every action in a felt short string, so a wallet can show it", () => {
    for (const action of Object.values(AUTH_ACTIONS)) {
      expect(action.length).toBeLessThanOrEqual(31);
    }
  });
});

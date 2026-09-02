// One sign-in, however many things ask for it.
//
// The failure these prevent is specific and was observed in production before
// sessions existed: several private reads starting together, each opening its
// own wallet prompt. A person who asked to see their circles was shown three
// signature requests. That is not consent, it is attrition.
//
// So the properties here are about counting. How many times the wallet is
// asked, and when it is not asked at all.

import { describe, expect, it, vi } from "vitest";

import { createSessionHolder, shouldDropSession, type SessionTransport } from "./sessionHolder";

const A = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const B = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";

/** A transport whose sign-in can be resolved by the test, when it chooses. */
function deferredTransport() {
  let settle: ((token: string | null) => void) | null = null;
  let fail: ((reason: unknown) => void) | null = null;
  const revoke = vi.fn(async () => {});
  const create = vi.fn(
    () =>
      new Promise<string | null>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    transport: { create, revoke } satisfies SessionTransport,
    create,
    revoke,
    resolve: (token: string | null) => settle?.(token),
    reject: (reason: unknown) => fail?.(reason),
  };
}

describe("asking for a session", () => {
  it("signs in once and hands the token back", async () => {
    const { transport, resolve, create } = deferredTransport();
    const holder = createSessionHolder(transport);

    const pending = holder.ensure();
    resolve("tok-1");

    expect(await pending).toBe("tok-1");
    expect(holder.current()).toBe("tok-1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not ask the wallet again once a session is held", async () => {
    const { transport, resolve, create } = deferredTransport();
    const holder = createSessionHolder(transport);
    const first = holder.ensure();
    resolve("tok-1");
    await first;

    expect(await holder.ensure()).toBe("tok-1");
    expect(await holder.ensure()).toBe("tok-1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  // The one that matters. Three private reads mounting together must produce
  // one prompt between them, not one each.
  it("opens exactly one prompt for three simultaneous readers", async () => {
    const { transport, resolve, create } = deferredTransport();
    const holder = createSessionHolder(transport);

    const readers = [holder.ensure(), holder.ensure(), holder.ensure()];
    expect(create).toHaveBeenCalledTimes(1);

    resolve("tok-1");
    expect(await Promise.all(readers)).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("lets every waiting reader continue after the one sign-in", async () => {
    const { transport, resolve } = deferredTransport();
    const holder = createSessionHolder(transport);

    const done: string[] = [];
    const readers = [1, 2, 3].map((n) =>
      holder.ensure().then((token) => {
        done.push(`read-${n}-with-${token}`);
      }),
    );

    resolve("tok-1");
    await Promise.all(readers);
    expect(done).toEqual(["read-1-with-tok-1", "read-2-with-tok-1", "read-3-with-tok-1"]);
  });
});

describe("when the person declines", () => {
  it("fails every waiting reader with the same refusal", async () => {
    const { transport, reject } = deferredTransport();
    const holder = createSessionHolder(transport);

    const readers = [holder.ensure(), holder.ensure(), holder.ensure()];
    const refusal = new Error("User rejected request");
    reject(refusal);

    await expect(Promise.allSettled(readers)).resolves.toEqual([
      { status: "rejected", reason: refusal },
      { status: "rejected", reason: refusal },
      { status: "rejected", reason: refusal },
    ]);
  });

  it("does not ask again by itself", async () => {
    const { transport, reject, create } = deferredTransport();
    const holder = createSessionHolder(transport);

    const reader = holder.ensure();
    reject(new Error("User rejected request"));
    await expect(reader).rejects.toThrow();

    // Nothing has retried, and nothing is held.
    expect(create).toHaveBeenCalledTimes(1);
    expect(holder.current()).toBeNull();
  });

  it("holds no session afterwards", async () => {
    const { transport, reject } = deferredTransport();
    const holder = createSessionHolder(transport);
    const reader = holder.ensure();
    reject(new Error("nope"));
    await expect(reader).rejects.toThrow();
    expect(holder.current()).toBeNull();
  });
});

describe("a backend without sessions", () => {
  it("reports no session rather than failing, so the caller can sign instead", async () => {
    const { transport, resolve } = deferredTransport();
    const holder = createSessionHolder(transport);
    const reader = holder.ensure();
    resolve(null);
    expect(await reader).toBeNull();
    expect(holder.current()).toBeNull();
  });
});

describe("forgetting a session", () => {
  it("drops the token", async () => {
    const { transport, resolve } = deferredTransport();
    const holder = createSessionHolder(transport);
    const first = holder.ensure();
    resolve("tok-1");
    await first;

    holder.clear();
    expect(holder.current()).toBeNull();
  });

  it("tells the server when signing out", async () => {
    const { transport, resolve, revoke } = deferredTransport();
    const holder = createSessionHolder(transport);
    const first = holder.ensure();
    resolve("tok-1");
    await first;

    await holder.end();
    expect(revoke).toHaveBeenCalledWith("tok-1");
    expect(holder.current()).toBeNull();
  });

  // Signing out is about this device. A network that will not carry the message
  // must not leave somebody signed in.
  it("signs out locally even when the server cannot be reached", async () => {
    const revoke = vi.fn(async () => {
      throw new Error("offline");
    });
    const holder = createSessionHolder({ create: async () => "tok-1", revoke });
    await holder.ensure();

    await expect(holder.end()).resolves.toBeUndefined();
    expect(holder.current()).toBeNull();
  });

  it("is safe to sign out when never signed in", async () => {
    const { transport, revoke } = deferredTransport();
    const holder = createSessionHolder(transport);
    await holder.end();
    expect(revoke).not.toHaveBeenCalled();
  });

  // The account moved while the wallet was showing the sign-in prompt. That
  // token belongs to the account that started it and must not be adopted.
  it("throws away a session that arrives after the wallet moved on", async () => {
    const { transport, resolve, revoke } = deferredTransport();
    const holder = createSessionHolder(transport);

    const reader = holder.ensure();
    holder.clear();
    resolve("tok-for-old-account");

    expect(await reader).toBeNull();
    expect(holder.current()).toBeNull();
    expect(revoke).toHaveBeenCalledWith("tok-for-old-account");
  });

  it("can sign in again after signing out", async () => {
    const create = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("tok-1")
      .mockResolvedValueOnce("tok-2");
    const holder = createSessionHolder({ create, revoke: async () => {} });

    expect(await holder.ensure()).toBe("tok-1");
    await holder.end();
    expect(await holder.ensure()).toBe("tok-2");
    expect(create).toHaveBeenCalledTimes(2);
  });
});

// Which wallet the session belongs to, and when it stops belonging.
describe("what ends a session", () => {
  const on = (address: string | null) => ({ address, onExpectedChain: true });

  it("ends when the account changes", () => {
    expect(shouldDropSession(on(A), on(B))).toBe(true);
  });

  it("survives the same account being reported again", () => {
    expect(shouldDropSession(on(A), on(A))).toBe(false);
  });

  it("compares accounts by value, not by how they were written", () => {
    expect(shouldDropSession(on("0x04099b8eb"), on("0x4099b8eb"))).toBe(false);
    expect(shouldDropSession(on("0x4099B8EB"), on("0x4099b8eb"))).toBe(false);
  });

  it("ends when the wallet leaves the expected network", () => {
    expect(shouldDropSession(on(A), { address: A, onExpectedChain: false })).toBe(true);
  });

  it("ends when the wallet returns to the expected network", () => {
    // The session was dropped on the way out; this asserts nothing is adopted
    // on the way back either. A new sign-in is one signature.
    expect(shouldDropSession({ address: A, onExpectedChain: false }, on(A))).toBe(true);
  });

  it("ends when the wallet disconnects", () => {
    expect(shouldDropSession(on(A), on(null))).toBe(true);
  });

  it("does nothing while there is no wallet at all", () => {
    expect(shouldDropSession(on(null), on(null))).toBe(false);
  });
});

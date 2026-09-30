import { describe, expect, it } from "vitest";
import { RpcProvider, ec } from "starknet";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { isSyntheticVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "./recoveryPackage";
import { createStarknetAuthority } from "./starknetAuthority";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const DEVNET_URL = process.env.IWA_B2A_DEVNET_URL;
const describeDevnet = DEVNET_URL === undefined ? describe.skip : describe;
const walletId = "00000000-0000-4000-8000-000000000222";
const password = "Iwa isolated devnet Starknet wallet password";
/** Exact decimal amount from the pinned devnet's own V3 deployment test. */
const DEVNET_DEPLOYMENT_FUNDING_FRI = "1000000000000000000000";
const passkey: WalletPasskeyMetadata = {
  credentialId: "iwa-b2a-devnet-wallet-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};

function scalarHex(privateKey: Uint8Array): string {
  return `0x${Array.from(privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function compactSignature(signature: { r: string; s: string }) {
  return ec.starkCurve.Signature.fromCompact(
    `${signature.r.slice(2).padStart(64, "0")}${signature.s.slice(2).padStart(64, "0")}`,
  );
}

async function devnetRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(DEVNET_URL!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("isolated devnet RPC failed");
  const payload = (await response.json()) as { result?: T; error?: unknown };
  if (payload.error !== undefined || payload.result === undefined) throw new Error("isolated devnet RPC rejected the request");
  return payload.result;
}

async function mintTestFunding(address: string, rpcUrl = DEVNET_URL!): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // JSON numbers above Number.MAX_SAFE_INTEGER must stay decimal literals.
    // The pinned devnet accepts this exact BigUint request shape.
    body: `{"jsonrpc":"2.0","id":1,"method":"devnet_mint","params":{"address":${JSON.stringify(address)},"amount":${DEVNET_DEPLOYMENT_FUNDING_FRI},"unit":"FRI"}}`,
  });
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (!response.ok || payload.error !== undefined || payload.result === undefined) {
    throw new Error("isolated devnet test funding failed");
  }
}

function accountAbi(value: unknown): Array<Record<string, unknown>> {
  const abi = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(abi)) throw new Error("devnet account ABI was unavailable");
  if (!abi.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))) {
    throw new Error("devnet account ABI was malformed");
  }
  return abi as Array<Record<string, unknown>>;
}

function assertDeployablePublicKeyAccountAbi(value: unknown): void {
  const abi = accountAbi(value);
  const functions = new Set(
    abi.flatMap((entry) => {
      if (entry.type === "function" && typeof entry.name === "string") return [entry.name];
      if (entry.type !== "interface" || !Array.isArray(entry.items)) return [];
      return entry.items.flatMap((item) => (
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as { type?: unknown }).type === "function" &&
        typeof (item as { name?: unknown }).name === "string"
          ? [(item as { name: string }).name]
          : []
      ));
    }),
  );
  expect(functions.has("get_public_key")).toBe(true);
  expect(functions.has("is_valid_signature")).toBe(true);
  expect(functions.has("__validate_deploy__")).toBe(true);

  const constructors = abi.filter((entry) => entry.type === "constructor");
  if (constructors.length !== 1) throw new Error("devnet account must expose one constructor");
  const inputs = constructors[0]?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) throw new Error("devnet account constructor must take one public key");
  const publicKey = inputs[0];
  if (
    typeof publicKey !== "object" ||
    publicKey === null ||
    Array.isArray(publicKey) ||
    (publicKey as { name?: unknown }).name !== "public_key" ||
    typeof (publicKey as { type?: unknown }).type !== "string" ||
    !(publicKey as { type: string }).type.includes("felt252")
  ) {
    throw new Error("devnet account constructor is not a one-felt public-key constructor");
  }
}

describe("B2-A devnet account ABI gate", () => {
  it("accepts Cairo 1 account functions nested in ABI interface items", () => {
    expect(() => assertDeployablePublicKeyAccountAbi([
      {
        type: "interface",
        name: "openzeppelin::account::interface::ISRC6",
        items: [
          { type: "function", name: "is_valid_signature" },
        ],
      },
      {
        type: "interface",
        name: "openzeppelin::account::interface::IPublicKey",
        items: [
          { type: "function", name: "get_public_key" },
        ],
      },
      {
        type: "interface",
        name: "openzeppelin::account::interface::IDeployable",
        items: [
          { type: "function", name: "__validate_deploy__" },
        ],
      },
      {
        type: "constructor",
        inputs: [{ name: "public_key", type: "core::felt252" }],
      },
    ])).not.toThrow();
  });
});

describe("B2-A devnet funding request", () => {
  it("sends the exact pinned-devnet FRI amount as a JSON-RPC integer", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl: string | undefined;
    let requestBody: string | undefined;
    let request: unknown;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      request = JSON.parse(requestBody);
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
    }) as typeof fetch;
    try {
      await mintTestFunding("0x123", "http://127.0.0.1:5050/rpc");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestUrl).toBe("http://127.0.0.1:5050/rpc");
    expect(requestBody).toContain('"amount":1000000000000000000000');
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "devnet_mint",
      params: {
        address: "0x123",
        unit: "FRI",
      },
    });
  });
});

function newVault(store = new InMemoryVaultStore()) {
  return new WalletVault({
    store,
    passkey: { assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256) },
    passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 11)),
    timeout: { set: () => 1, clear: () => undefined },
  });
}

describeDevnet("B2-A isolated Starknet account deployment", () => {
  it("deploys a newly generated vault authority using a devnet-verified account class and restores the same account", async () => {
    let phase = "initialize";
    try {
      phase = "discover-predeployed-account";
      const provider = new RpcProvider({ nodeUrl: DEVNET_URL! });
      const predeployed = await devnetRpc<Array<{ address: string }>>("devnet_getPredeployedAccounts");
      const reference = predeployed[0];
      if (reference === undefined) throw new Error("isolated devnet did not provide a reference account");
      const classHash = await provider.getClassHashAt(reference.address);
      phase = "verify-account-class";
      const contractClass = await provider.getClassByHash(classHash);
      assertDeployablePublicKeyAccountAbi((contractClass as { abi?: unknown }).abi);

      phase = "create-encrypted-authority";
      const networkId = await provider.getChainId();
      const store = new InMemoryVaultStore();
      const vault = newVault(store);
      await vault.create({ walletId, password, passkey, authorities: [] });
      const session = await vault.unlock({ walletId, password });
      const descriptor = await vault.provisionStarknetAuthority(session, {
        walletId,
        password,
        accountClass: {
          networkId,
          accountClassId: "devnet-predeployed-account-verified",
          accountClassHash: classHash,
          descriptorVersion: 1,
        },
      });
      phase = "fund-counterfactual-account";
      await mintTestFunding(descriptor.accountAddress);
      phase = "deploy-account";
      const deployment = await vault.deployStarknetAccount(session, { walletId, password, provider });

      phase = "verify-deployment";
      expect(deployment.accountAddress).toBe(descriptor.accountAddress);
      expect(deployment.transactionHash).not.toBeNull();
      expect(deployment.resumed).toBe(false);
      expect(await provider.getClassHashAt(descriptor.accountAddress)).toBe(descriptor.accountClassHash);
      expect(BigInt((await provider.callContract({ contractAddress: descriptor.accountAddress, entrypoint: "get_public_key", calldata: [] }))[0]!)).toBe(BigInt(descriptor.publicKey));

      phase = "verify-signer-ownership";
      const proofHash = "0x4567";
      const signature = vault.signStarknetAuthorityProof(session, {
        walletId,
        networkId: descriptor.networkId,
        accountAddress: descriptor.accountAddress,
        proofHash,
      });
      await expect(provider.callContract({
        contractAddress: descriptor.accountAddress,
        entrypoint: "is_valid_signature",
        calldata: [proofHash, "2", signature.r, signature.s],
      })).resolves.toHaveLength(1);
      phase = "reject-wrong-signer-and-payload";
      await expect(provider.callContract({
        contractAddress: descriptor.accountAddress,
        entrypoint: "is_valid_signature",
        calldata: ["0x4568", "2", signature.r, signature.s],
      })).rejects.toThrow();
      const substitute = createStarknetAuthority({
        networkId,
        accountClassId: "devnet-predeployed-account-verified",
        accountClassHash: classHash,
        descriptorVersion: 1,
      });
      try {
        const substituteSignature = ec.starkCurve.sign(proofHash, scalarHex(substitute.privateKey));
        await expect(provider.callContract({
          contractAddress: descriptor.accountAddress,
          entrypoint: "is_valid_signature",
          calldata: [proofHash, "2", `0x${substituteSignature.r.toString(16)}`, `0x${substituteSignature.s.toString(16)}`],
        })).rejects.toThrow();
      } finally {
        substitute.privateKey.fill(0);
      }
      phase = "resume-provisioning";
      await expect(vault.deployStarknetAccount(session, { walletId, password, provider })).resolves.toMatchObject({ resumed: true, transactionHash: null });

      phase = "export-recovery";
      const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 91);
      const recovery = await vault.exportRecovery(session, walletId, recoveryKey, "b2a-devnet-recovery-one");
      await vault.destroy(walletId);
      phase = "import-recovery";
      const restored = newVault(store);
      const replacement = await restored.importRecovery({
        recovery,
        recoveryKey,
        password: "Iwa restored isolated devnet wallet password",
        passkey,
        replacementPackageId: "b2a-devnet-recovery-two",
      });
      const restoredSession = await restored.unlock({ walletId, password: "Iwa restored isolated devnet wallet password" });
      const restoredDescriptor = restored.starknetAccountDescriptor(restoredSession, walletId);
      if (restoredDescriptor === null) throw new Error("restored Starknet authority was unavailable");
      const restoredSignature = restored.signStarknetAuthorityProof(restoredSession, {
        walletId,
        networkId: restoredDescriptor.networkId,
        accountAddress: restoredDescriptor.accountAddress,
        proofHash,
      });
      phase = "verify-recovered-authority";
      const payload = await openRecoveryPackage(replacement, recoveryKey, walletId);
      try {
        const authority = payload.authorities[0];
        if (authority === undefined || isSyntheticVaultAuthority(authority)) throw new Error("restored recovery authority was unavailable");
        expect(restoredDescriptor).toEqual({ ...descriptor, deploymentState: "deployed" });
        expect(ec.starkCurve.verify(compactSignature(restoredSignature), proofHash, ec.starkCurve.getPublicKey(scalarHex(authority.privateKey)))).toBe(true);
        await expect(provider.callContract({
          contractAddress: descriptor.accountAddress,
          entrypoint: "is_valid_signature",
          calldata: [proofHash, "2", restoredSignature.r, restoredSignature.s],
        })).resolves.toHaveLength(1);
      } finally {
        payload.rootSecret.fill(0);
        wipeVaultAuthorities(payload.authorities);
        recoveryKey.fill(0);
      }
    } catch {
      throw new Error(`B2A_PHASE_FAILED:${phase}`);
    }
  }, 180_000);

  it("rejects wrong network and wrong account context before any deployment request", async () => {
    let phase = "initialize";
    try {
      phase = "discover-predeployed-account";
      const provider = new RpcProvider({ nodeUrl: DEVNET_URL! });
      const reference = (await devnetRpc<Array<{ address: string }>>("devnet_getPredeployedAccounts"))[0];
      if (reference === undefined) throw new Error("isolated devnet did not provide a reference account");
      const networkId = await provider.getChainId();
      const classHash = await provider.getClassHashAt(reference.address);
      phase = "create-encrypted-authority";
      const vault = newVault();
      await vault.create({ walletId, password, passkey, authorities: [] });
      const session = await vault.unlock({ walletId, password });
      const descriptor = await vault.provisionStarknetAuthority(session, {
        walletId,
        password,
        accountClass: { networkId, accountClassId: "devnet-predeployed-account-verified", accountClassHash: classHash, descriptorVersion: 1 },
      });
      phase = "reject-wrong-network-and-context";
      await expect(vault.deployStarknetAccount(session, { walletId, password, provider: { getChainId: async () => "0x1" } as unknown as RpcProvider })).rejects.toThrow();
      expect(vault.signStarknetAuthorityProof(session, { walletId, networkId, accountAddress: descriptor.accountAddress, proofHash: "0x4567" }).r).toMatch(/^0x/);
      expect(() => vault.signStarknetAuthorityProof(session, { walletId, networkId, accountAddress: "0x1", proofHash: "0x4567" })).toThrow();
    } catch {
      throw new Error(`B2A_PHASE_FAILED:network-${phase}`);
    }
  }, 180_000);
});

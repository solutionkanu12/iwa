// chains/ethereum/wallet.ts — the Ethereum wallet seam for Iwa Prize Savings.
//
// Uses the browser's EIP-1193 provider (window.ethereum) directly and keeps
// everything this feature needs in one place, separate from the Starknet
// wallet used by the rest of Iwa: the two chains live side by side, each with
// its own connection, and nothing here touches the Starknet session.
//
// No private key ever passes through this module. Only the wallet signs, and
// only what the visitor explicitly asked for.

import type { Eip1193Provider } from "ethers";

export type EthereumWalletState =
  | { kind: "missing" } // no EIP-1193 provider in this browser
  | { kind: "disconnected" }
  | { kind: "wrongNetwork"; chainId: bigint }
  | { kind: "connected"; address: string; chainId: bigint };

export interface EthereumProviderLike {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export function getEthereumProvider(): EthereumProviderLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: EthereumProviderLike };
  return w.ethereum ?? null;
}

/** The provider in the shape ethers' BrowserProvider expects. */
export function eip1193Provider(): Eip1193Provider | null {
  const p = getEthereumProvider();
  if (p === null) return null;
  return p as unknown as Eip1193Provider;
}

/** Asks the wallet for its connected account, opening the wallet's own picker. */
export async function requestAccount(provider: EthereumProviderLike): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (accounts.length === 0) throw new Error("No account selected");
  return accounts[0];
}

export async function readChainId(provider: EthereumProviderLike): Promise<bigint> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return BigInt(hex);
}

/**
 * Asks the wallet to switch to Sepolia. A wallet that does not know the chain
 * is offered the chain metadata so it can add it. Rejects if the visitor
 * declines.
 */
export async function switchToSepolia(provider: EthereumProviderLike): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err; // 4902: chain not present in this wallet
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0xaa36a7",
          chainName: "Sepolia",
          rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        },
      ],
    });
  }
}

/** Asks the wallet to sign EIP-712 typed data (used by Zama user decryption). */
export async function signTypedDataV4(
  provider: EthereumProviderLike,
  account: string,
  typedData: unknown,
): Promise<string> {
  return (await provider.request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(typedData)],
  })) as string;
}

/** The full connect-and-verify flow: account, then the network check. */
export async function connectEthereumWallet(): Promise<"connected" | "wrongNetwork"> {
  const provider = getEthereumProvider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  await requestAccount(provider);
  const chainId = await readChainId(provider);
  if (chainId !== 11155111n) return "wrongNetwork";
  return "connected";
}
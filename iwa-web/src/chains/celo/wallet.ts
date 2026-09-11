// chains/celo/wallet.ts — the Celo wallet seam for Iwa's Celo circle flow.
//
// A third, independent slot of the same Iwa-level wallet manager, alongside
// the slots the product's other chains already use. Connecting or
// disconnecting one never touches the others, matching the manager's
// existing principle.
//
// Reuses chains/ethereum/wallet.ts's chain-generic pieces (the EIP-1193
// provider getter, account/chain reads, EIP-712 signing) rather than
// duplicating them: only what is genuinely Celo-specific — the expected
// chain id and the add/switch-chain parameters — lives here.

import {
  eip1193Provider,
  getEthereumProvider,
  readChainId,
  requestAccount,
  signTypedDataV4,
  type EthereumProviderLike,
} from "../ethereum/wallet";
import { CELO_MAINNET } from "./config";

export const EXPECTED_CELO_CHAIN_ID = BigInt(CELO_MAINNET.chainIdNumber);

export { getEthereumProvider as getCeloProvider, eip1193Provider, signTypedDataV4 };

/**
 * Asks the wallet to switch to Celo mainnet. A wallet that does not know the
 * chain is offered the chain metadata so it can add it. Rejects if the
 * visitor declines.
 */
export async function switchToCeloMainnet(provider: EthereumProviderLike): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CELO_MAINNET.chainId }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err; // 4902: chain not present in this wallet
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CELO_MAINNET.chainId,
          chainName: CELO_MAINNET.name,
          rpcUrls: [CELO_MAINNET.rpcUrl],
          nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
          blockExplorerUrls: [CELO_MAINNET.explorerUrl],
        },
      ],
    });
  }
}

/** The full connect-and-verify flow: account, then the network check. */
export async function connectCeloWallet(): Promise<"connected" | "wrongNetwork"> {
  const provider = getEthereumProvider();
  if (provider === null) throw new Error("No wallet found in this browser");
  await requestAccount(provider);
  const chainId = await readChainId(provider);
  if (chainId !== EXPECTED_CELO_CHAIN_ID) return "wrongNetwork";
  return "connected";
}

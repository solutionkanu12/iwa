// chains/strk20/walletConnect.ts — connect a privacy-enabled Starknet wallet.
//
// This is the Starknet Wallet API route: the dapp describes STRK20 actions and
// the user's wallet holds the viewing key, discovers notes, generates the ZK
// proof, and submits. No key material of any kind crosses this boundary.
//
// Capability is detected with a version query, never by probing a data method:
// `strk20Balances` reads private balances and wallets gate it behind a user
// consent prompt, so calling it to feature-detect would prompt the user for
// data the app has no reason to see.
//
// Version baseline (from the installed strk20-wallet-api skill): STRK20 landed
// in starknet.js 10.4.0; the wallet must support Wallet API >= 0.10.3.

import { RpcProvider, WalletAccountV6, walletV6 } from "starknet";
import { createStore, type Store } from "@starknet-io/get-starknet-discovery";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";

import { STARKNET_MAINNET, sameAddress } from "../starknetProduction";

/**
 * starknet.js bundles its own copy of the wallet-standard types (the npm alias
 * "get-starknet-wallet-standard-v6"), while the discovery store returns wallets
 * typed by the copy this app installs. They are the same injected wallet object
 * at runtime but nominally distinct types to TypeScript. Taking the parameter
 * type from starknet.js itself keeps one source of truth, and the casts below
 * are the only places the two copies meet.
 */
type StarknetWalletForConnect = Parameters<typeof WalletAccountV6.connect>[1];

/** Minimum Wallet API version carrying the STRK20 methods. */
export const REQUIRED_WALLET_API_VERSION = "0.10.3";

/** IWA is mainnet-only. There is no testnet deployment to fall back to. */
export const REQUIRED_CHAIN_ID = STARKNET_MAINNET.chainId;

export type WalletUnsupportedReason =
  | "NO_WALLETS"
  | "NO_STRK20_SUPPORT"
  | "WRONG_NETWORK"
  | "CONNECTION_REFUSED";

export class WalletUnsupportedError extends Error {
  readonly reason: WalletUnsupportedReason;
  constructor(reason: WalletUnsupportedReason, message: string) {
    super(message);
    this.name = "WalletUnsupportedError";
    this.reason = reason;
  }
}

/** Operator-facing copy for each failure. Shown verbatim; never swallowed. */
export const UNSUPPORTED_MESSAGES: Record<WalletUnsupportedReason, string> = {
  NO_WALLETS: "No Starknet wallet was detected. Install a privacy-enabled wallet such as Ready.",
  NO_STRK20_SUPPORT:
    `This wallet does not support the STRK20 private-transfer API (Wallet API ${REQUIRED_WALLET_API_VERSION} or later). ` +
    "IWA cannot settle privately through it. Use a privacy-enabled wallet such as Ready.",
  WRONG_NETWORK: "IWA is deployed on Starknet mainnet only. Switch your wallet to mainnet.",
  CONNECTION_REFUSED: "The wallet connection was refused.",
};

/** Compares dotted version strings numerically, e.g. "0.10.3" >= "0.9.9". */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = right.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when any advertised Wallet API version carries the STRK20 methods. */
export function supportsStrk20(versions: readonly string[]): boolean {
  return versions.some((v) => compareVersions(v, REQUIRED_WALLET_API_VERSION) >= 0);
}

/** Discovery store of injected Starknet wallets. Create once, subscribe for updates. */
export function createWalletStore(): Store {
  return createStore();
}

export interface DetectedWallet {
  readonly wallet: WalletWithStarknetFeatures;
  readonly name: string;
  readonly icon: string;
  /** Whether this wallet advertises the STRK20 Wallet API. */
  readonly supportsStrk20: boolean;
  readonly apiVersions: readonly string[];
}

/**
 * Asks each detected wallet which Wallet API versions it speaks. This is a
 * capability query, not a data call: it triggers no consent prompt and reads
 * nothing private.
 */
export async function detectWallets(store: Store): Promise<DetectedWallet[]> {
  const wallets = store.getWallets();
  return Promise.all(
    wallets.map(async (wallet) => {
      let apiVersions: string[] = [];
      try {
        apiVersions = await walletV6.supportedWalletApi(wallet as StarknetWalletForConnect);
      } catch {
        // A wallet that cannot answer the version query is treated as
        // unsupported rather than assumed capable.
        apiVersions = [];
      }
      return {
        wallet,
        name: wallet.name,
        icon: wallet.icon,
        supportsStrk20: supportsStrk20(apiVersions),
        apiVersions,
      };
    }),
  );
}

export interface ConnectedWallet {
  readonly account: WalletAccountV6;
  readonly address: string;
  readonly chainId: string;
  readonly walletName: string;
}

/**
 * Connects one wallet and refuses anything IWA cannot settle through:
 * a wallet without the STRK20 API, or a wallet on a network other than
 * Starknet mainnet.
 */
export async function connectWallet(
  detected: DetectedWallet,
  nodeUrl: string,
): Promise<ConnectedWallet> {
  if (!detected.supportsStrk20) {
    throw new WalletUnsupportedError("NO_STRK20_SUPPORT", UNSUPPORTED_MESSAGES.NO_STRK20_SUPPORT);
  }

  const provider = new RpcProvider({ nodeUrl });

  let account: WalletAccountV6;
  try {
    // cairoVersion "1" — required for the v3 transactions every STRK20
    // submission uses.
    account = await WalletAccountV6.connect(
      provider,
      detected.wallet as StarknetWalletForConnect,
      "1",
    );
  } catch (e) {
    throw new WalletUnsupportedError(
      "CONNECTION_REFUSED",
      `${UNSUPPORTED_MESSAGES.CONNECTION_REFUSED} (${(e as Error).message})`,
    );
  }

  // The wallet API answers for the network the WALLET is on, which is what
  // must be checked. The RPC provider only knows the node it was pointed at.
  const chainId = await walletV6.requestChainId(
    detected.wallet as StarknetWalletForConnect,
  );
  if (!sameAddress(chainId, REQUIRED_CHAIN_ID)) {
    throw new WalletUnsupportedError("WRONG_NETWORK", UNSUPPORTED_MESSAGES.WRONG_NETWORK);
  }

  return {
    account,
    address: account.address,
    chainId,
    walletName: detected.name,
  };
}

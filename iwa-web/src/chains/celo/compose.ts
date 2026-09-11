// chains/celo/compose.ts — real composition root for the Celo contribution
// flow.
//
// Not wired into any screen yet (no saver UI calls this). It exists so the
// service is never assembled with a stub directory in production: this is
// the one place that builds a CeloContributionService for real use, and it
// always uses the durable, backend-backed member-account directory
// (lib/accountDirectory.ts), never InMemoryMemberAccountDirectory.

import { createHttpMemberAccountDirectory } from "../../lib/accountDirectory";
import type { ContributionHistory } from "../../core/contributionHistory";
import { CeloContributionService, type CeloCircleBinding } from "./contribution";
import { CELO_MAINNET } from "./config";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";

/**
 * Builds a CeloContributionService scoped to the wallet that is actually
 * connected. A fresh instance is built per connected wallet rather than
 * shared across wallets, because the durable directory itself is scoped to
 * one (chain, account) pair — see lib/accountDirectory.ts — which keeps the
 * read endpoint from ever being asked to confirm an account other than the
 * one truly connected.
 */
export function composeCeloContributionService(
  binding: CeloCircleBinding,
  provider: CeloProviderLike,
  history: ContributionHistory,
  connectedWallet: string,
): CeloContributionService {
  const account = `celo:${normalizeAddress(connectedWallet)}`;
  const chain = `celo:${CELO_MAINNET.chainIdNumber}`;
  const directory = createHttpMemberAccountDirectory(chain, account);
  return new CeloContributionService(binding, provider, history, directory);
}

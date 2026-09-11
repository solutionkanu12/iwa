// chains/celo/recovery.ts — recover(round) execution for a locked round.
//
// IwaCircleCelo.recover(round) always pays msg.sender their own contribution
// back, and reverts for anyone who is not a member who actually paid that
// round (see the contract). There is no destination argument at all, and
// the round this sends is never free-form: it must come from an
// authoritative on-chain read (a round the caller reads as DeferredLocked
// and confirms they paid), never a caller-typed number.

import { CeloTransactionAdapter } from "./adapter";
import { encodeRecover } from "./circleCalldata";
import { CELO_MAINNET } from "./config";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";
import { wrapCeloProvider } from "./transactions";

export interface CeloRecoverBinding {
  /** IwaCircleCelo address. The only call target; never caller-supplied. */
  circleContract: string;
}

export type CeloTxStatus = "CONFIRMED" | "FAILED" | "PENDING";

export class CeloRecoverService {
  private readonly provider: CeloProviderLike;
  private readonly txs: CeloTransactionAdapter;

  constructor(private readonly binding: CeloRecoverBinding, provider: CeloProviderLike) {
    normalizeAddress(binding.circleContract);
    this.provider = wrapCeloProvider(provider);
    this.txs = new CeloTransactionAdapter(this.provider);
  }

  private async requireMainnet(): Promise<void> {
    const hex = (await this.provider.request({ method: "eth_chainId" })) as string;
    if (BigInt(hex) !== BigInt(CELO_MAINNET.chainIdNumber)) {
      throw new Error("Recovery refused: wallet is not on Celo mainnet");
    }
  }

  private async waitReceipt(hash: string): Promise<CeloTxStatus> {
    const receipt = (await this.provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt == null) return "PENDING";
    if (receipt.status === "0x1") return "CONFIRMED";
    return "FAILED";
  }

  /**
   * Sends recover(round) from `caller`. The contract pays msg.sender only,
   * and reverts (surfaced here as FAILED, never CONFIRMED) for a
   * non-payer, a defaulting member, or a round already recovered. A
   * confirmed status here means only "the transaction succeeded" — the UI
   * still refreshes on-chain state afterward rather than trusting this
   * call to describe it.
   */
  async recover(caller: string, round: number): Promise<{ txHash: string; status: CeloTxStatus }> {
    await this.requireMainnet();
    const from = normalizeAddress(caller);
    const circleContract = normalizeAddress(this.binding.circleContract);
    const txHash = await this.txs.send({
      from,
      to: circleContract,
      data: encodeRecover(round),
      chainId: CELO_MAINNET.chainId,
    });
    const status = await this.waitReceipt(txHash);
    return { txHash, status };
  }
}

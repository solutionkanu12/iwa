// chains/celo/collect.ts — permissionless collect() execution for Iwa.
//
// IwaCircleCelo.collect() may be called by anyone, but the contract always
// pays scheduledMember(round), never msg.sender (see the contract's own
// comment on this). This service exists so the UI can trigger it without
// ever accepting a caller-supplied destination, contract, or calldata:
// there is no `to` parameter here at all, matching the contract's own
// function signature.

import { CeloTransactionAdapter } from "./adapter";
import { encodeCollect } from "./circleCalldata";
import { CELO_MAINNET } from "./config";
import { normalizeAddress } from "./erc20";
import type { CeloProviderLike } from "./transactions";
import { wrapCeloProvider } from "./transactions";

export interface CeloCollectBinding {
  /** IwaCircleCelo address. The only call target; never caller-supplied. */
  circleContract: string;
}

export type CeloTxStatus = "CONFIRMED" | "FAILED" | "PENDING";

export class CeloCollectService {
  private readonly provider: CeloProviderLike;
  private readonly txs: CeloTransactionAdapter;

  constructor(private readonly binding: CeloCollectBinding, provider: CeloProviderLike) {
    normalizeAddress(binding.circleContract);
    this.provider = wrapCeloProvider(provider);
    this.txs = new CeloTransactionAdapter(this.provider);
  }

  private async requireMainnet(): Promise<void> {
    const hex = (await this.provider.request({ method: "eth_chainId" })) as string;
    if (BigInt(hex) !== BigInt(CELO_MAINNET.chainIdNumber)) {
      throw new Error("Collect refused: wallet is not on Celo mainnet");
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
   * Sends collect() from `caller`. Permissionless by design: the contract
   * itself decides the recipient (scheduledMember(round)), never this
   * method's caller argument. A confirmed status here means only "the
   * transaction succeeded" — the UI still refreshes on-chain round/payout
   * state afterward rather than trusting this call to describe it.
   */
  async collect(caller: string): Promise<{ txHash: string; status: CeloTxStatus }> {
    await this.requireMainnet();
    const from = normalizeAddress(caller);
    const circleContract = normalizeAddress(this.binding.circleContract);
    const txHash = await this.txs.send({
      from,
      to: circleContract,
      data: encodeCollect(),
      chainId: CELO_MAINNET.chainId,
    });
    const status = await this.waitReceipt(txHash);
    return { txHash, status };
  }
}

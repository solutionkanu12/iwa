// chains/celo/contribution.ts — cNGN contribution execution for Iwa.
//
// Funds go to the bound IwaCircleCelo contract via contribute(), never to
// an organizer EOA. Amount and recipient are not caller-chosen.

import { fromDataSuffix } from "@celo/attribution-tags";

import {
  assertBoundAccount,
  type MemberAccountDirectory,
} from "../../core/accountBinding";
import { ContributionHistory } from "../../core/contributionHistory";
import type { Circle, ContributionObligation } from "../../core/domain/types";
import { IwaSavingsAgent } from "../../core/savingsAgent";
import {
  assertExplicitConfirmation,
  circleSettlementRef,
  type ExplicitConfirmation,
  type PreparedContributionAction,
} from "../../core/payment";
import { CeloTransactionAdapter } from "./adapter";
import { encodeContribute } from "./circleCalldata";
import { CELO_MAINNET, CNGN_MAINNET, IWA_CELO_ATTRIBUTION_TAG } from "./config";
import {
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  normalizeAddress,
  parseBaseUnits,
  sameAddress,
  decodeUint256,
} from "./erc20";
import type { CeloProviderLike } from "./transactions";
import { wrapCeloProvider } from "./transactions";

export interface CeloCircleBinding {
  circleId: string;
  chainId: number;
  token: string;
  /** IwaCircleCelo address. The only settlement destination. */
  circleContract: string;
  contributionAmount: string;
}

export interface PreparedCeloContribution {
  action: PreparedContributionAction;
  payer: string;
  token: string;
  circleContract: string;
  amount: string;
  requiresOnChainApproval: boolean;
}

export class CeloContributionService {
  private readonly agent = new IwaSavingsAgent();
  private readonly txs: CeloTransactionAdapter;
  private readonly provider: CeloProviderLike;

  constructor(
    private readonly binding: CeloCircleBinding,
    provider: CeloProviderLike,
    private readonly history: ContributionHistory,
    /** Chain-neutral member→account directory. Fail-closed: an unregistered
     *  or mismatched member/account pair is refused before any RPC read. */
    private readonly accounts: MemberAccountDirectory,
  ) {
    assertCeloCngnBinding(binding);
    this.provider = wrapCeloProvider(provider);
    this.txs = new CeloTransactionAdapter(this.provider);
  }

  /** Opaque, adapter-formatted identity components bound into every action. */
  private celoIdentity(payerAddr: string): {
    accountRef: string;
    chainRef: string;
    assetRef: string;
  } {
    return {
      accountRef: `celo:${payerAddr}`,
      chainRef: `celo:${CELO_MAINNET.chainIdNumber}`,
      assetRef: `celo:${CNGN_MAINNET.address.toLowerCase()}`,
    };
  }

  get taggedProvider(): CeloProviderLike {
    return this.provider;
  }

  async readBalance(payer: string): Promise<bigint> {
    await this.requireMainnet();
    return this.readUint(CNGN_MAINNET.address, encodeBalanceOf(payer));
  }

  async readAllowance(payer: string, spender: string): Promise<bigint> {
    await this.requireMainnet();
    return this.readUint(CNGN_MAINNET.address, encodeAllowance(payer, spender));
  }

  async prepare(
    circle: Circle,
    obligation: ContributionObligation,
    payer: string,
  ): Promise<PreparedCeloContribution> {
    this.assertCircleBinding(circle);
    const payerAddr = normalizeAddress(payer);
    const identity = this.celoIdentity(payerAddr);
    // Fail closed before any RPC read: the connected wallet must be the one
    // registered for this member on this circle.
    await assertBoundAccount(
      this.accounts,
      circle.id,
      obligation.memberRef,
      identity.chainRef,
      identity.accountRef,
    );
    const action = this.agent.prepareContribution(circle, obligation, identity);
    if (action.request.amount !== this.binding.contributionAmount) {
      throw new Error("Contribution refused: amount is not the bound circle amount");
    }
    if (action.request.recipientRef !== circleSettlementRef(circle.id)) {
      throw new Error("Contribution refused: settlement recipient is not the circle contract");
    }
    const circleContract = normalizeAddress(this.binding.circleContract);
    const balance = await this.readBalance(payerAddr);
    const amount = parseBaseUnits(action.request.amount);
    if (balance < amount) {
      throw new Error("Contribution refused: insufficient cNGN balance");
    }
    const allowance = await this.readAllowance(payerAddr, circleContract);
    return {
      action,
      payer: payerAddr,
      token: normalizeAddress(this.binding.token),
      circleContract,
      amount: action.request.amount,
      requiresOnChainApproval: allowance < amount,
    };
  }

  async submit(
    circle: Circle,
    obligation: ContributionObligation,
    prepared: PreparedCeloContribution,
    confirmation: ExplicitConfirmation,
    now: number,
  ): Promise<ContributionObligation> {
    assertExplicitConfirmation(prepared.action, confirmation);
    this.agent.requireConfirmation(prepared.action, confirmation);
    this.assertCircleBinding(circle);
    await this.assertPreparedFrozen(prepared, obligation);
    await this.requireMainnet();

    if (this.history.get(circle.id, obligation.round, obligation.memberRef)) {
      throw new Error("Contribution refused: already recorded for this round");
    }

    const amount = parseBaseUnits(this.binding.contributionAmount);
    const payer = prepared.payer;
    const circleContract = normalizeAddress(this.binding.circleContract);

    if (prepared.requiresOnChainApproval) {
      const approveHash = await this.txs.send({
        from: payer,
        to: CNGN_MAINNET.address,
        data: encodeApprove(circleContract, amount),
        chainId: CELO_MAINNET.chainId,
      });
      this.assertTaggedOnce(CNGN_MAINNET.address, encodeApprove(circleContract, amount));
      const approveStatus = await this.waitReceipt(approveHash);
      if (approveStatus !== "CONFIRMED") {
        throw new Error("Contribution refused: approval transaction failed");
      }
    }

    const contributeData = encodeContribute();
    const txHash = await this.txs.send({
      from: payer,
      to: circleContract,
      data: contributeData,
      chainId: CELO_MAINNET.chainId,
    });
    this.assertTaggedOnce(circleContract, contributeData);
    const status = await this.waitReceipt(txHash);
    if (status !== "CONFIRMED") {
      throw new Error("Contribution refused: contribution transaction failed");
    }

    return this.history.recordConfirmed({
      circleId: circle.id,
      round: obligation.round,
      memberRef: obligation.memberRef,
      dueAt: obligation.dueAt,
      graceEndsAt: obligation.graceEndsAt,
      settledAt: now,
      txHash,
    });
  }

  private assertCircleBinding(circle: Circle): void {
    if (circle.id !== this.binding.circleId) {
      throw new Error("Contribution refused: circle is not bound to this adapter");
    }
    if (circle.contributionAmount !== this.binding.contributionAmount) {
      throw new Error("Contribution refused: amount is not the bound circle amount");
    }
  }

  private async assertPreparedFrozen(
    prepared: PreparedCeloContribution,
    obligation: ContributionObligation,
  ): Promise<void> {
    if (prepared.action.request.circleId !== this.binding.circleId) {
      throw new Error("Contribution refused: prepared circle does not match");
    }
    if (prepared.action.request.round !== obligation.round) {
      throw new Error("Contribution refused: prepared round does not match");
    }
    if (prepared.action.request.memberRef !== obligation.memberRef) {
      throw new Error("Contribution refused: prepared member does not match");
    }
    if (prepared.action.request.amount !== this.binding.contributionAmount) {
      throw new Error("Contribution refused: amount override is not allowed");
    }
    if (!sameAddress(prepared.token, CNGN_MAINNET.address)) {
      throw new Error("Contribution refused: token is not cNGN on Celo mainnet");
    }
    if (!sameAddress(prepared.circleContract, this.binding.circleContract)) {
      throw new Error("Contribution refused: recipient override is not allowed");
    }
    if (prepared.action.request.recipientRef !== circleSettlementRef(this.binding.circleId)) {
      throw new Error("Contribution refused: settlement recipient is not the circle contract");
    }
    if (prepared.payer !== normalizeAddress(prepared.payer)) {
      throw new Error("Contribution refused: payer is invalid");
    }
    // Re-derive the identity from the payer/binding actually present on the
    // object about to execute, and require it to still equal what was
    // frozen into the action at prepare() time. actionId equality alone
    // only proves the confirmation matches the pristine prepared action; it
    // does not stop a caller mutating the JS object's fields afterward.
    const identity = this.celoIdentity(prepared.payer);
    if (prepared.action.request.accountRef !== identity.accountRef) {
      throw new Error("Contribution refused: wallet override is not allowed");
    }
    if (prepared.action.request.chainRef !== identity.chainRef) {
      throw new Error("Contribution refused: chain override is not allowed");
    }
    if (prepared.action.request.assetRef !== identity.assetRef) {
      throw new Error("Contribution refused: asset override is not allowed");
    }
    // Re-verify the member/account binding itself, in case the directory
    // changed (e.g. was revoked) between prepare() and submit().
    await assertBoundAccount(
      this.accounts,
      this.binding.circleId,
      obligation.memberRef,
      identity.chainRef,
      identity.accountRef,
    );
  }

  private async requireMainnet(): Promise<void> {
    const hex = (await this.provider.request({ method: "eth_chainId" })) as string;
    const chainId = BigInt(hex);
    if (chainId !== BigInt(CELO_MAINNET.chainIdNumber)) {
      throw new Error("Contribution refused: wallet is not on Celo mainnet");
    }
  }

  private async readUint(to: string, data: string): Promise<bigint> {
    const result = (await this.provider.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as string;
    return decodeUint256(result);
  }

  private async waitReceipt(hash: string): Promise<"CONFIRMED" | "FAILED" | "PENDING"> {
    const receipt = (await this.provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt == null) return "PENDING";
    if (receipt.status === "0x1") return "CONFIRMED";
    return "FAILED";
  }

  private assertTaggedOnce(to: string, preTagData: string): void {
    const tagged = this.txs.prepare({ to, data: preTagData }).data;
    const decoded = fromDataSuffix(tagged);
    const count = decoded?.codes.filter((c) => c === IWA_CELO_ATTRIBUTION_TAG).length ?? 0;
    if (count !== 1) {
      throw new Error("Contribution refused: attribution tag must appear exactly once");
    }
  }
}

export function assertCeloCngnBinding(binding: CeloCircleBinding): void {
  if (binding.chainId !== CNGN_MAINNET.chainId) {
    throw new Error("Contribution refused: binding is not Celo mainnet");
  }
  if (!sameAddress(binding.token, CNGN_MAINNET.address)) {
    throw new Error("Contribution refused: binding token is not canonical cNGN");
  }
  parseBaseUnits(binding.contributionAmount);
  normalizeAddress(binding.circleContract);
}

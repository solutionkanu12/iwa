// chains/celo/adapter.ts — Celo transaction adapter.
//
// IWA Core talks to chain adapters. This is the Celo send seam: every
// transaction goes through prepare/send, which always append
// celo_448874a99d90. There is no untagged send on this class.

import {
  prepareCeloTransaction,
  sendCeloTransaction,
  wrapCeloProvider,
  type CeloProviderLike,
  type CeloTransactionRequest,
} from "./transactions";

export class CeloTransactionAdapter {
  private readonly provider: CeloProviderLike;

  constructor(provider: CeloProviderLike) {
    this.provider = wrapCeloProvider(provider);
  }

  prepare(tx: CeloTransactionRequest) {
    return prepareCeloTransaction(tx);
  }

  send(tx: CeloTransactionRequest): Promise<string> {
    return sendCeloTransaction(this.provider, tx);
  }
}

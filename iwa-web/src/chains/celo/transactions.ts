// chains/celo/transactions.ts — the only Celo send path Iwa uses.
//
// Every transaction is tagged before it reaches the wallet. The wrapped
// provider also tags eth_sendTransaction / eth_signTransaction /
// wallet_sendCalls, and refuses eth_sendRawTransaction so signed untagged
// bytes cannot bypass the adapter. Callers must not send Celo transactions
// except through this module.

import {
  assertIwaCeloAttribution,
  tagCeloCalldata,
  type HexData,
} from "./attribution";

export interface CeloProviderLike {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export interface CeloTransactionRequest {
  to?: string;
  from?: string;
  value?: string | bigint | number;
  data?: string | null;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  chainId?: string;
}

const TAGGED = Symbol.for("iwa.celo.attributionWrapped");

/** Copy a tx, replace data with tagged calldata, and refuse if the tag is missing. */
export function prepareCeloTransaction<T extends CeloTransactionRequest>(
  tx: T,
): T & { data: HexData } {
  const data = tagCeloCalldata(tx.data);
  assertIwaCeloAttribution(data);
  return { ...tx, data };
}

/**
 * Send a Celo transaction. The payload is tagged, then submitted through a
 * wrapped provider so a later untagged rewrite is still caught.
 */
export async function sendCeloTransaction(
  provider: CeloProviderLike,
  tx: CeloTransactionRequest,
): Promise<string> {
  const wrapped = wrapCeloProvider(provider);
  const prepared = prepareCeloTransaction(tx);
  const hash = await wrapped.request({
    method: "eth_sendTransaction",
    params: [prepared],
  });
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("Celo transaction refused: wallet did not return a transaction hash");
  }
  return hash;
}

/**
 * The provider Iwa Celo code must use. `request` tags send/sign paths and
 * refuses raw signed sends that cannot carry a suffix.
 */
export function wrapCeloProvider(provider: CeloProviderLike): CeloProviderLike {
  if (isTagged(provider)) return provider;

  const request = async (args: { method: string; params?: unknown[] | object }) => {
    return provider.request(tagRpcRequest(args));
  };

  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === TAGGED) return true;
      if (prop === "request") return request;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function isTagged(provider: CeloProviderLike): boolean {
  return (provider as { [TAGGED]?: boolean })[TAGGED] === true;
}

function tagRpcRequest(args: { method: string; params?: unknown[] | object }): {
  method: string;
  params?: unknown[] | object;
} {
  const method = args.method;
  if (method === "eth_sendRawTransaction") {
    throw new Error(
      "Celo transaction refused: eth_sendRawTransaction bypasses attribution tagging; use the Celo adapter send path",
    );
  }
  if (method === "eth_sendTransaction" || method === "eth_signTransaction") {
    return { method, params: tagTxParams(args.params, method) };
  }
  if (method === "wallet_sendCalls") {
    return { method, params: tagWalletSendCalls(args.params) };
  }
  return args;
}

function asParamList(params: unknown, method: string): unknown[] {
  if (!Array.isArray(params) || params.length === 0) {
    throw new Error(`Celo transaction refused: ${method} requires a transaction object`);
  }
  return params;
}

function tagTxParams(params: unknown, method: string): unknown[] {
  const list = asParamList(params, method);
  const tx = list[0];
  if (tx == null || typeof tx !== "object") {
    throw new Error(`Celo transaction refused: ${method} requires a transaction object`);
  }
  return [prepareCeloTransaction(tx as CeloTransactionRequest), ...list.slice(1)];
}

function tagWalletSendCalls(params: unknown): unknown[] {
  const list = asParamList(params, "wallet_sendCalls");
  const batch = list[0];
  if (batch == null || typeof batch !== "object") {
    throw new Error("Celo transaction refused: wallet_sendCalls requires a batch object");
  }
  const record = batch as { calls?: unknown };
  if (!Array.isArray(record.calls)) {
    throw new Error("Celo transaction refused: wallet_sendCalls requires a calls array");
  }
  const calls = record.calls.map((call) => {
    if (call == null || typeof call !== "object") {
      throw new Error("Celo transaction refused: wallet_sendCalls call is not an object");
    }
    return prepareCeloTransaction(call as CeloTransactionRequest);
  });
  return [{ ...record, calls }, ...list.slice(1)];
}

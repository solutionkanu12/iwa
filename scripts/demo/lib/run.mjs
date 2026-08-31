// Shared harness for every IWA STRK20 demo script.
//
// Three invariants hold for all of them:
//
//  1. DRY RUN IS THE DEFAULT. Nothing is submitted unless `--confirm-send` is
//     passed, matching the deployment tool's convention. A dry run still does
//     the full build — compile actions, sign, simulate — so what it validates
//     is the same object a send would broadcast.
//  2. A GREEN PREFLIGHT IS A PRECONDITION. The crypto-parity and on-chain
//     wiring gates run first, in-process, and any failure aborts before an
//     account is even constructed.
//  3. FAIL CLOSED. Unknown chain, drifted class hash, blocked depositor,
//     unexpected pool version, missing secret — all abort. Nothing here treats
//     an unreachable check as a pass.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { Account, RpcProvider } from "starknet";

import { runPreflight } from "./preflight.mjs";
import { loadDemoConfig, normFelt, feltEq, SN_MAIN_CHAIN_ID } from "./chain.mjs";
import { loadSdk, loadPoolContract, livePoolFee, assertHelperNotBlocked } from "./sdk-loader.mjs";
import { secretFelt, secretPrivateKey, secretUrl, fingerprint } from "./secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUN_STATE_PATH = resolve(HERE, "../run-state.json");

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    confirmSend: flags.has("--confirm-send"),
    cfgPath: positional[0] ?? resolve(HERE, "../demo.config.json"),
    flags,
    positional,
  };
}

export function banner(title, confirmSend) {
  console.log(`\n=== ${title} ===`);
  console.log(
    confirmSend
      ? "MODE: SEND — transactions WILL be broadcast to mainnet"
      : "MODE: DRY RUN — nothing is broadcast (pass --confirm-send to send)"
  );
}

/** Persisted run state (circle id, tx hashes). Never contains secrets. */
export function readRunState() {
  if (!existsSync(RUN_STATE_PATH)) return { circleId: null, transactions: [] };
  return JSON.parse(readFileSync(RUN_STATE_PATH, "utf8"));
}

export function writeRunState(state) {
  mkdirSync(dirname(RUN_STATE_PATH), { recursive: true });
  writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export function recordTransaction(entry) {
  const state = readRunState();
  state.transactions = state.transactions.filter((t) => t.hash !== entry.hash);
  state.transactions.push({ ...entry, recordedAt: new Date().toISOString() });
  writeRunState(state);
  return state;
}

/**
 * Builds everything a script needs, in fail-closed order. Returns the provider,
 * the pinned SDK, the pool contract, the live fee, and (only when secrets are
 * present) the operator account.
 *
 * `needAccount` is false for pure read/plan scripts so they never touch key
 * material at all.
 */
export async function bootstrap({ cfgPath, confirmSend, needAccount = true, needProver = false }) {
  const failures = await runPreflight({ cfgPath });
  if (failures !== 0) {
    throw new Error(`preflight failed with ${failures} gate(s) — refusing to continue`);
  }

  const cfg = loadDemoConfig(cfgPath);
  const provider = new RpcProvider({ nodeUrl: cfg.rpc_url });

  const chainId = await provider.getChainId();
  if (!feltEq(chainId, SN_MAIN_CHAIN_ID)) {
    throw new Error(`refusing to run: chain id ${chainId} is not SN_MAIN`);
  }

  const { sdk, PrivacyPoolABI, ContractDiscoveryProvider } = await loadSdk();
  const pool = await loadPoolContract(provider, cfg.privacy_pool, PrivacyPoolABI);
  const feeAmount = await livePoolFee(pool);
  await assertHelperNotBlocked(pool, cfg.iwa_helper);

  console.log(`\n--- C. Live pool state ---`);
  console.log(`  pool fee per apply_actions: ${feeAmount} STRK wei (${Number(feeAmount) / 1e18} STRK)`);
  console.log(`  helper open-note depositor: not blocked`);

  let account = null;
  if (needAccount) {
    const address = normFelt(secretFelt("IWA_ACCOUNT_ADDRESS"));
    const pk = secretPrivateKey("IWA_ACCOUNT_PRIVATE_KEY");
    account = new Account({
      provider,
      address,
      signer: "0x" + pk.toString(16).padStart(64, "0"),
      // Required for accounts sending v3 transactions, which every call here is.
      cairoVersion: "1",
    });
    console.log(`  operator account: ${address}`);
  }

  let proverUrl = null;
  if (needProver) {
    proverUrl = secretUrl("IWA_PROVER_URL");
    console.log(`  proving service: ${fingerprint(proverUrl)}`);
  }

  return { cfg, provider, account, sdk, PrivacyPoolABI, ContractDiscoveryProvider, pool, feeAmount, proverUrl, confirmSend };
}

/**
 * Builds the SDK private-transfers client. Discovery reads the pool contract
 * directly over RPC (no external indexer). Proving needs the operator-supplied
 * service; in dry-run mode no prover is contacted at all because `simulate()`
 * uses the SDK's own mock prover against a read-only pool view.
 */
export async function makeTransfers({
  sdk,
  ContractDiscoveryProvider,
  pool,
  account,
  cfg,
  proverUrl,
  chainId,
}) {
  const viewingKey = secretPrivateKey("IWA_VIEWING_KEY");
  return sdk.createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: () => viewingKey },
    provingProvider: proverUrl
      ? { url: proverUrl, chainId, nodeUrl: cfg.rpc_url }
      : { url: "https://prover.invalid", chainId, nodeUrl: cfg.rpc_url },
    discoveryProvider: new ContractDiscoveryProvider(pool),
    poolContractAddress: normFelt(cfg.privacy_pool),
  });
}

/**
 * The single send gate. Every broadcast in this tooling goes through here, so
 * there is exactly one place where a transaction can leave the process.
 */
export async function submit({ account, provider, calls, label, confirmSend, kind }) {
  if (!confirmSend) {
    console.log(`  DRY RUN: would submit ${label}`);
    for (const c of Array.isArray(calls) ? calls : [calls]) {
      console.log(`    -> ${c.contractAddress} :: ${c.entrypoint ?? "(pool apply_actions)"}`);
    }
    return { dryRun: true, hash: null };
  }
  const res = await account.execute(calls, { tip: 0n });
  console.log(`  SENT ${label}: ${res.transaction_hash}`);
  const receipt = await provider.waitForTransaction(res.transaction_hash);
  const ok = receipt.isSuccess ? receipt.isSuccess() : true;
  if (!ok) throw new Error(`${label} reverted: ${JSON.stringify(receipt).slice(0, 400)}`);
  recordTransaction({ hash: res.transaction_hash, label, kind, block: receipt.block_number ?? null });
  console.log(`  CONFIRMED ${label}`);
  return { dryRun: false, hash: res.transaction_hash, receipt };
}

/** Prove against head - 10, never the head. See submitPoolTx. */
export const PROVING_BLOCK_BACKOFF = 10;

/**
 * Proof keys for account.execute. They must be OMITTED ENTIRELY when the
 * provider returned no proof facts: passing `proofFacts: []` makes
 * starknet.js serialize an invalid v3 transaction, which reverts on chain
 * with INVALID_PROOF_FACTS rather than failing locally.
 */
export function proofDetails(proof) {
  return proof?.proofFacts?.length ? { proofFacts: proof.proofFacts, proof: proof.data } : {};
}

/**
 * Runs one STRK20 pool transaction through the single send gate.
 *
 * DRY RUN uses the SDK's own `simulate()`, which swaps in a mock prover and
 * calls a read-only pool view to assemble proof facts. That exercises the real
 * action compiler, the real note selection, the real invoke calldata and the
 * real submission shape — it just never contacts the proving service and never
 * broadcasts. The fee estimate it produces is the genuine one.
 *
 * SEND builds a real proof through the operator's proving service and submits
 * `callAndProof` with the `proof` / `proofFacts` transaction details Starknet
 * requires for a pool transaction.
 *
 * `build` is a callback so the identical builder chain is used on both paths.
 */
export async function submitPoolTx({
  transfers,
  build,
  provider,
  account,
  label,
  confirmSend,
  proverUrl,
}) {
  const warn = (result) => {
    for (const w of result.warnings ?? []) {
      console.log(`  WARNING [${w.code}] ${w.message}`);
    }
  };

  // Always prove against `head - 10`, never the head. Three reasons, all of
  // which bite in production: notes mature 10 blocks after creation, so a
  // fresher base can prove against a state where an input note is not yet
  // spendable; a proof based on the head can be invalidated by an L2 reorg
  // before the transaction lands; and the SDK forwards this to discovery, so
  // note selection and proving see one consistent block.
  const provingBlock = async () =>
    (await provider.getBlockNumber()) - PROVING_BLOCK_BACKOFF;

  if (!confirmSend) {
    const provingBlockId = await provingBlock();
    const result = await build(transfers).simulate({ node: provider, provingBlockId });
    warn(result);
    const { call, proof } = result.callAndProof;
    console.log(`  DRY RUN: ${label} compiled and simulated`);
    console.log(`    -> ${call.contractAddress} :: ${call.entrypoint}`);
    console.log(`    calldata felts: ${call.calldata.length}`);
    console.log(`    proving block: ${provingBlockId}`);
    try {
      const fee = await account.estimateInvokeFee(call, {
        tip: 0n,
        ...proofDetails(proof),
      });
      console.log(`    estimated fee: ${fee.overall_fee} STRK wei`);
    } catch (e) {
      console.log(`    fee estimate unavailable (simulated proof): ${e.message.split("\n")[0]}`);
    }
    return { dryRun: true, hash: null };
  }

  if (!proverUrl) throw new Error("a proving service is required to send a pool transaction");

  // The prover reads finalized state and the sequencer only accepts a proof
  // whose base block is at least 10 blocks old. Pool transactions are run from
  // separate script invocations, so the window is enforced here, against the
  // last pool transaction this run recorded — not left to the operator.
  await waitForProvingWindow(provider, lastPoolTxBlock());

  // Re-fetch after the wait: the proof base must not be older than any
  // transparent transaction (an approval, a top-up) the proof needs to see.
  const provingBlockId = await provingBlock();
  console.log(`  proving block: ${provingBlockId}`);

  let result;
  try {
    result = await build(transfers).execute({ provingBlockId });
  } catch (e) {
    // The proving provider caches the pool nonce. Any failure past this point
    // leaves it stale, and retrying without clearing it loops on proofs the
    // chain keeps rejecting.
    transfers.invalidateProofNonceCache();
    throw e;
  }
  warn(result);

  const { call, proof } = result.callAndProof;
  let res;
  try {
    res = await account.execute(call, { tip: 0n, ...proofDetails(proof) });
  } catch (e) {
    transfers.invalidateProofNonceCache();
    throw e;
  }
  console.log(`  SENT ${label}: ${res.transaction_hash}`);
  const receipt = await provider.waitForTransaction(res.transaction_hash);
  const ok = receipt.isSuccess ? receipt.isSuccess() : true;
  if (!ok) {
    transfers.invalidateProofNonceCache();
    throw new Error(`${label} reverted`);
  }
  recordTransaction({
    hash: res.transaction_hash,
    label,
    kind: "pool",
    block: receipt.block_number ?? null,
  });
  console.log(`  CONFIRMED ${label}`);
  return { dryRun: false, hash: res.transaction_hash, receipt, registry: result.registry };
}

/**
 * The pool proves against finalized state and the sequencer only accepts a
 * proof whose base block is at least 10 blocks old. Between two private
 * transactions — and after any transparent transaction the next proof must
 * read, such as an ERC-20 top-up — the run has to wait.
 */
export async function waitForProvingWindow(provider, sinceBlock, { blocks = 10 } = {}) {
  if (sinceBlock === null || sinceBlock === undefined) return;
  let latest = await provider.getBlockNumber();
  while (sinceBlock >= latest - blocks) {
    console.log(`  waiting for the proving window: block ${latest}, need > ${sinceBlock + blocks}`);
    await new Promise((r) => setTimeout(r, 15_000));
    latest = await provider.getBlockNumber();
  }
}

/** Block of the most recent recorded pool transaction, or null if there is none. */
export function lastPoolTxBlock() {
  const pool = readRunState().transactions.filter((t) => t.kind === "pool" && t.block != null);
  if (pool.length === 0) return null;
  return pool.reduce((max, t) => (t.block > max ? t.block : max), 0);
}

export function die(e) {
  console.error(`\nABORTED: ${e.message}`);
  if (process.env.IWA_DEBUG) console.error(e.stack);
  process.exit(1);
}

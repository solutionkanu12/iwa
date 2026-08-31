#!/usr/bin/env node
// Step 2 — private contribution settlement (one pool transaction per member).
//
// One STRK20 transaction carries two things:
//   a Withdraw of the exact obligation amount to the IWA helper, and
//   an InvokeExternal calling the helper's privacy_invoke.
//
// The pool applies the withdrawal first (phase 6) and only then invokes
// (phase 7), so the tokens are already sitting in the helper when it runs
// `assert_exact_inbound_balance`. Contribution binds no output note, so the
// helper returns an empty span and this transaction must NOT create an open
// note — creating one and returning nothing reverts with UNDEPOSITED_OPEN_NOTES.
//
//   node --env-file=.env.local 05_contribute.mjs --member A
//   node --env-file=.env.local 05_contribute.mjs --member A --confirm-send

import {
  parseArgs,
  banner,
  bootstrap,
  makeTransfers,
  submitPoolTx,
  readRunState,
  die,
} from "./lib/run.mjs";
import { loadCircleParams, formatUnits, USDC_DECIMALS } from "./lib/params.mjs";
import { loadMembers, findMember } from "./lib/members.mjs";
import {
  getCircle,
  getContributionObligation,
  isContributionNonceConsumed,
  getHelperSurplus,
  privacyInvokeCalldata,
  signContributionSettlement,
  IwaOperation,
} from "./lib/circle.mjs";
import { normFelt } from "./lib/chain.mjs";
import { feltHex } from "./lib/iwa.mjs";

/** Fixed per-purpose nonce. Re-running a settled contribution fails closed on the contract nonce. */
const CONTRIBUTION_NONCE = 1n;

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const { cfgPath, confirmSend } = parseArgs(argv.filter((a) => a !== argValue(argv, "--member", null)));
  const memberLabel = argValue(argv, "--member", "A");
  const nonce = BigInt(argValue(argv, "--nonce", String(CONTRIBUTION_NONCE)));

  banner(`05 CONTRIBUTE — private contribution settlement (member ${memberLabel})`, confirmSend);

  const ctx = await bootstrap({ cfgPath, confirmSend, needAccount: true, needProver: confirmSend });
  const { cfg, provider, account, sdk, ContractDiscoveryProvider, pool, proverUrl } = ctx;

  const params = loadCircleParams(cfg);
  const members = loadMembers(params.memberLimit);
  const member = findMember(members, memberLabel);

  const state = readRunState();
  if (state.circleId === null) throw new Error("no circle recorded — run 00_prepare.mjs first");
  const circleId = state.circleId;

  console.log("\n--- D. Circle and obligation (read-only, fail closed) ---");
  const circle = await getCircle(provider, cfg.iwa_circle, circleId);
  console.log(`  circle ${circle.id}: ${circle.status}, round ${circle.currentRound}, ${circle.joinedCount}/${circle.memberLimit} joined`);
  if (circle.status !== "Active") {
    throw new Error(`circle is ${circle.status}, not Active — every member must join before contributions`);
  }
  if (circle.asset !== "Usdc") throw new Error(`circle asset is ${circle.asset}; this demo settles USDC`);

  const round = circle.currentRound;
  const obligation = await getContributionObligation(
    provider,
    cfg.iwa_circle,
    circleId,
    round,
    member.memberRef
  );
  console.log(`  member ${member.label} obligation: ${formatUnits(obligation.requiredAmount, USDC_DECIMALS)} USDC, status ${obligation.status}`);

  // The helper reads the obligation itself and asserts Pending, so anything
  // else here would revert on chain. Stop before spending a proof on it.
  if (obligation.status !== "Pending") {
    throw new Error(`obligation status is ${obligation.status}, not Pending — nothing to settle`);
  }
  if (obligation.requiredAmount !== params.contributionAmount) {
    throw new Error(
      `on-chain required amount ${obligation.requiredAmount} differs from the configured ` +
        `contribution ${params.contributionAmount}`
    );
  }

  if (await isContributionNonceConsumed(provider, cfg.iwa_circle, circleId, member.memberRef, nonce)) {
    throw new Error(`contribution nonce ${feltHex(nonce)} is already consumed for member ${member.label}`);
  }

  // A stale donation to the helper would make assert_exact_inbound_balance
  // reject this settlement. Surface it before proving rather than after.
  const surplus = await getHelperSurplus(provider, cfg.iwa_helper, cfg.usdc_token);
  if (surplus !== 0n) {
    throw new Error(
      `the helper holds ${formatUnits(surplus, USDC_DECIMALS)} USDC of unaccounted surplus — call ` +
        `normalize_surplus(USDC) on the helper before settling`
    );
  }
  console.log("  helper USDC surplus: 0 (exact inbound accounting is clean)");

  console.log("\n--- E. Member settlement signature ---");
  const amount = obligation.requiredAmount;
  const { r, s, messageHash } = signContributionSettlement(member, {
    circleId: BigInt(circleId),
    round: BigInt(round),
    helper: BigInt(normFelt(cfg.iwa_helper)),
    pool: BigInt(normFelt(cfg.privacy_pool)),
    token: BigInt(normFelt(cfg.usdc_token)),
    amount,
    nonce,
  });
  console.log(`  message hash: ${feltHex(messageHash)}`);
  console.log(`  signature verified against the contract predicate before use`);

  const calldata = privacyInvokeCalldata({
    operation: IwaOperation.SettleContribution,
    circleId,
    round,
    memberRef: member.memberRef,
    token: cfg.usdc_token,
    openNoteId: 0n,
    nonce,
    r,
    s,
  });

  console.log("\n--- F. Pool transaction: withdraw to helper + privacy_invoke ---");
  const chainId = await provider.getChainId();
  const transfers = await makeTransfers({
    sdk,
    ContractDiscoveryProvider,
    pool,
    account,
    cfg,
    proverUrl,
    chainId,
  });

  const self = normFelt(account.address);
  const helper = normFelt(cfg.iwa_helper);

  await submitPoolTx({
    transfers,
    provider,
    account,
    confirmSend,
    proverUrl,
    label: `contribution settlement member ${member.label}`,
    build: (t) =>
      t
        .build({
          autoSetup: true,
          autoSelectNotes: "all",
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(normFelt(cfg.usdc_token), (tok) =>
          tok.withdraw({ recipient: helper, amount }).surplusTo(self, false)
        )
        .invoke(() => ({ contractAddress: helper, calldata })),
  });

  if (!confirmSend) console.log("\nDRY RUN COMPLETE — nothing was sent.");
}

main().catch(die);

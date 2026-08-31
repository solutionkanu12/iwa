#!/usr/bin/env node
// Step 3 — private payout settlement (the final pool transaction).
//
// Three stages, in order:
//   1. finalize_round_payout_accounting — deterministic, permissionless. Every
//      obligation in the round must already be final.
//   2. authorize_payout_settlement — the scheduled member signs the exact
//      payout amount under the IWA_PAYOUT_V1 domain. No tokens move.
//   3. one pool transaction that creates an open note for the recipient and
//      invokes the helper, which returns exactly one OpenNoteDeposit. The pool
//      then pulls that amount from the helper into the note.
//
// The open note id only exists once the SDK has compiled the actions, and the
// settlement signature binds it. The signature is therefore produced inside the
// invoke callback, against the note id that will actually be used.
//
//   node --env-file=.env.local 06_payout.mjs
//   node --env-file=.env.local 06_payout.mjs --confirm-send

import {
  parseArgs,
  banner,
  bootstrap,
  makeTransfers,
  submit,
  submitPoolTx,
  waitForProvingWindow,
  readRunState,
  die,
} from "./lib/run.mjs";
import { loadCircleParams, formatUnits, USDC_DECIMALS } from "./lib/params.mjs";
import { loadMembers } from "./lib/members.mjs";
import {
  getCircle,
  getPayoutState,
  getContributionObligation,
  getRoundLiability,
  getHelperTokenLiability,
  isPayoutNonceConsumed,
  isPayoutSettlementNonceConsumed,
  finalizeRoundPayoutAccountingCall,
  authorizePayoutSettlementCall,
  privacyInvokeCalldata,
  signPayoutAuthorization,
  signPayoutSettlement,
  IwaOperation,
} from "./lib/circle.mjs";
import { normFelt, feltEq } from "./lib/chain.mjs";
import { feltHex } from "./lib/iwa.mjs";

const PAYOUT_AUTH_NONCE = 3n;
const PAYOUT_SETTLE_NONCE = 4n;

async function main() {
  const { cfgPath, confirmSend } = parseArgs();
  banner("06 PAYOUT — private payout settlement", confirmSend);

  const ctx = await bootstrap({ cfgPath, confirmSend, needAccount: true, needProver: confirmSend });
  const { cfg, provider, account, sdk, ContractDiscoveryProvider, pool, proverUrl } = ctx;

  const params = loadCircleParams(cfg);
  const members = loadMembers(params.memberLimit);

  const state = readRunState();
  if (state.circleId === null) throw new Error("no circle recorded — run 00_prepare.mjs first");
  const circleId = state.circleId;

  console.log("\n--- D. Round readiness (read-only, fail closed) ---");
  const circle = await getCircle(provider, cfg.iwa_circle, circleId);
  const round = circle.currentRound;
  console.log(`  circle ${circle.id}: ${circle.status}, round ${round}`);
  if (circle.status !== "Active") throw new Error(`circle is ${circle.status}, not Active`);

  for (const m of members) {
    const o = await getContributionObligation(provider, cfg.iwa_circle, circleId, round, m.memberRef);
    console.log(`  member ${m.label}: ${o.status}`);
    if (o.status === "Pending") {
      throw new Error(
        `member ${m.label} has a Pending obligation — every obligation in the round must be final ` +
          `before payout accounting can be finalized`
      );
    }
  }

  const helperLiability = await getHelperTokenLiability(provider, cfg.iwa_helper, cfg.usdc_token);
  console.log(`  helper accounted USDC custody: ${formatUnits(helperLiability, USDC_DECIMALS)}`);

  // Stage 1 — payout accounting
  console.log("\n--- E. Stage 1: finalize payout accounting ---");
  let payout = null;
  try {
    payout = await getPayoutState(provider, cfg.iwa_circle, circleId, round);
    console.log(`  payout state already exists: ${payout.status}`);
  } catch {
    console.log("  no payout state yet");
  }

  let stageBlock = null;
  if (payout === null) {
    const sent = await submit({
      account,
      provider,
      calls: finalizeRoundPayoutAccountingCall(cfg.iwa_circle, { circleId, round }),
      label: "finalize_round_payout_accounting",
      confirmSend,
      kind: "transparent",
    });
    if (!sent.dryRun) {
      stageBlock = sent.receipt.block_number ?? null;
      payout = await getPayoutState(provider, cfg.iwa_circle, circleId, round);
    }
  }

  if (payout === null) {
    console.log("\n  DRY RUN: payout state does not exist yet, so the remaining stages cannot be");
    console.log("  validated against real accounting. Re-run this dry run after stage 1 has been sent.");
    return;
  }

  const recipient = members.find((m) => feltEq(m.memberRef, payout.scheduledMemberRef));
  if (!recipient) {
    throw new Error(
      `the scheduled recipient ${payout.scheduledMemberRef} is not one of the loaded demo members`
    );
  }
  console.log(`  scheduled recipient: member ${recipient.label}`);
  console.log(`  payout amount: ${formatUnits(payout.amount, USDC_DECIMALS)} USDC`);

  if (payout.amount > helperLiability) {
    throw new Error(
      `payout of ${payout.amount} exceeds the helper accounted custody ${helperLiability} — the ` +
        `round is not fully funded`
    );
  }

  // Stage 2 — settlement authorization
  console.log("\n--- F. Stage 2: authorize payout settlement ---");
  if (payout.status === "SettlementAuthorized") {
    console.log("  already authorized");
  } else if (payout.status === "Scheduled" || payout.status === "DeferredLocked") {
    if (await isPayoutNonceConsumed(provider, cfg.iwa_circle, circleId, recipient.memberRef, PAYOUT_AUTH_NONCE)) {
      throw new Error(`payout authorization nonce ${feltHex(PAYOUT_AUTH_NONCE)} is already consumed`);
    }
    const auth = signPayoutAuthorization(recipient, {
      circleId: BigInt(circleId),
      round: BigInt(round),
      amount: payout.amount,
      nonce: PAYOUT_AUTH_NONCE,
    });
    console.log(`  authorization message hash: ${feltHex(auth.messageHash)}`);
    const sent = await submit({
      account,
      provider,
      calls: authorizePayoutSettlementCall(cfg.iwa_circle, {
        circleId,
        round,
        nonce: PAYOUT_AUTH_NONCE,
        r: auth.r,
        s: auth.s,
      }),
      label: "authorize_payout_settlement",
      confirmSend,
      kind: "transparent",
    });
    if (!sent.dryRun) {
      stageBlock = sent.receipt.block_number ?? stageBlock;
      payout = await getPayoutState(provider, cfg.iwa_circle, circleId, round);
      console.log(`  payout state is now ${payout.status}`);
    }
  } else {
    throw new Error(`payout status is ${payout.status} — not authorizable and not settleable here`);
  }

  if (confirmSend && payout.status !== "SettlementAuthorized") {
    throw new Error(`payout status is ${payout.status}, expected SettlementAuthorized`);
  }

  if (
    await isPayoutSettlementNonceConsumed(
      provider,
      cfg.iwa_circle,
      circleId,
      recipient.memberRef,
      PAYOUT_SETTLE_NONCE
    )
  ) {
    throw new Error(`payout settlement nonce ${feltHex(PAYOUT_SETTLE_NONCE)} is already consumed`);
  }

  if (confirmSend) await waitForProvingWindow(provider, stageBlock);

  // Stage 3 — the pool transaction
  console.log("\n--- G. Stage 3: pool transaction (open note + privacy_invoke) ---");
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
  const usdc = normFelt(cfg.usdc_token);
  const amount = payout.amount;

  await submitPoolTx({
    transfers,
    provider,
    account,
    confirmSend,
    proverUrl,
    label: "payout settlement",
    build: (t) =>
      t
        .build({
          autoSetup: true,
          autoSelectNotes: "all",
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(usdc, (tok) => tok.transfer({ recipient: self, amount: sdk.Open }))
        .invoke((args) => {
          const note = args.openNotes[0];
          if (note === undefined) {
            throw new Error("no open note was created — payout settlement requires exactly one");
          }
          // The settlement signature binds the open note id, so it is produced
          // here, against the note the transaction will actually carry.
          const sig = signPayoutSettlement(recipient, {
            circleId: BigInt(circleId),
            round: BigInt(round),
            helper: BigInt(helper),
            pool: BigInt(normFelt(cfg.privacy_pool)),
            token: BigInt(usdc),
            amount,
            openNoteId: BigInt(note.noteId),
            nonce: PAYOUT_SETTLE_NONCE,
          });
          console.log(`  open note id: ${feltHex(BigInt(note.noteId))}`);
          console.log(`  settlement message hash: ${feltHex(sig.messageHash)}`);
          return {
            contractAddress: helper,
            calldata: privacyInvokeCalldata({
              operation: IwaOperation.SettlePayout,
              circleId,
              round,
              memberRef: recipient.memberRef,
              token: usdc,
              openNoteId: BigInt(note.noteId),
              nonce: PAYOUT_SETTLE_NONCE,
              r: sig.r,
              s: sig.s,
            }),
          };
        }),
  });

  if (confirmSend) {
    const after = await getPayoutState(provider, cfg.iwa_circle, circleId, round);
    const liability = await getRoundLiability(provider, cfg.iwa_circle, circleId, round);
    console.log(`\n  payout status: ${after.status}`);
    console.log(`  round outstanding liability: ${formatUnits(liability.outstanding, USDC_DECIMALS)} USDC`);
  } else {
    console.log("\nDRY RUN COMPLETE — nothing was sent.");
  }
}

main().catch(die);

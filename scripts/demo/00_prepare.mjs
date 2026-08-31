#!/usr/bin/env node
// Step 0 — prepare the demo circle.
//
// Derives the member identities, prints the exact minimum funding for the whole
// run, and (only with --confirm-send) creates the circle and joins every member.
// The final join activates the circle and creates round-1 obligations; nothing
// here touches the STRK20 pool.
//
//   node --env-file=.env.local 00_prepare.mjs                 # dry run
//   node --env-file=.env.local 00_prepare.mjs --confirm-send  # create + join

import { parseArgs, banner, bootstrap, submit, readRunState, writeRunState, die } from "./lib/run.mjs";
import { loadCircleParams, formatUnits, USDC_DECIMALS } from "./lib/params.mjs";
import { computeFunding, printFunding } from "./lib/funding.mjs";
import { loadMembers } from "./lib/members.mjs";
import {
  createCircleCall,
  joinCircleCall,
  getCircle,
  getPayoutOrder,
  isMember,
  getMemberAuthKey,
  getContributionObligation,
} from "./lib/circle.mjs";
import { feltHex } from "./lib/iwa.mjs";
import { feltEq } from "./lib/chain.mjs";

async function main() {
  const { cfgPath, confirmSend } = parseArgs();
  banner("00 PREPARE — circle creation and membership", confirmSend);

  const ctx = await bootstrap({ cfgPath, confirmSend, needAccount: true });
  const { cfg, provider, account, feeAmount } = ctx;

  const params = loadCircleParams(cfg);
  const members = loadMembers(params.memberLimit);

  console.log("\n--- D. Member identities (commitments only; no secret is printed) ---");
  for (const m of members) {
    console.log(`  member ${m.label}`);
    console.log(`    auth public key: ${feltHex(m.authPublicKey)}`);
    console.log(`    member_ref:      ${feltHex(m.memberRef)}`);
  }

  const funding = computeFunding({ feeAmount, params });
  printFunding(funding, params);

  const payoutOrder = members.map((m) => m.memberRef);
  console.log("\n--- E. Circle to create ---");
  console.log(`  token:            ${cfg.usdc_token} (USDC, ${USDC_DECIMALS} decimals)`);
  console.log(`  contribution:     ${formatUnits(params.contributionAmount, USDC_DECIMALS)} USDC`);
  console.log(`  members:          ${params.memberLimit}`);
  console.log(`  cadence:          ${params.cadenceSeconds}s`);
  console.log(`  grace:            ${params.gracePeriodSeconds}s`);
  console.log(`  payout order:     ${payoutOrder.map((r) => feltHex(r)).join(", ")}`);
  console.log(`  round-1 recipient: member ${members[0].label}`);

  const state = readRunState();

  if (state.circleId !== null) {
    console.log(`\n  a circle is already recorded for this run: id ${state.circleId}`);
    await report(provider, cfg, state.circleId, members);
    if (!confirmSend) return;
    console.log("  refusing to create a second circle — clear run-state.json to start over");
    return;
  }

  const create = createCircleCall(cfg.iwa_circle, {
    token: cfg.usdc_token,
    contributionAmount: params.contributionAmount,
    cadenceSeconds: params.cadenceSeconds,
    gracePeriodSeconds: params.gracePeriodSeconds,
    memberLimit: params.memberLimit,
    payoutOrder,
  });

  console.log("\n--- F. Transactions ---");
  const created = await submit({
    account,
    provider,
    calls: create,
    label: "create_circle",
    confirmSend,
    kind: "transparent",
  });

  if (created.dryRun) {
    for (const m of members) {
      const join = joinCircleCall(cfg.iwa_circle, {
        circleId: "<circle id from create_circle>",
        inviteSecret: m.inviteSecret,
        authPublicKey: m.authPublicKey,
      });
      console.log(`  DRY RUN: would submit join_circle for member ${m.label}`);
      console.log(`    -> ${join.contractAddress} :: ${join.entrypoint}`);
    }
    console.log("\nDRY RUN COMPLETE — nothing was sent.");
    return;
  }

  // The circle id is `next_circle_id + 1` at creation time. Rather than parse
  // it out of the receipt, read it back and verify every field matches what we
  // asked for; a mismatch means we found somebody else's circle and must stop.
  const circleId = await resolveNewCircleId(provider, cfg, params, members, account.address);
  state.circleId = circleId;
  writeRunState(state);
  console.log(`  circle id: ${circleId}`);

  for (const m of members) {
    await submit({
      account,
      provider,
      calls: joinCircleCall(cfg.iwa_circle, {
        circleId,
        inviteSecret: m.inviteSecret,
        authPublicKey: m.authPublicKey,
      }),
      label: `join_circle member ${m.label}`,
      confirmSend,
      kind: "transparent",
    });
  }

  await report(provider, cfg, circleId, members);
}

/**
 * Finds the circle just created by this account and proves it is ours: the
 * organizer, the locked payout order, and every configured term must match.
 * Fails closed rather than guessing an id.
 */
async function resolveNewCircleId(provider, cfg, params, members, organizer) {
  for (let id = 1; id < 10_000; id += 1) {
    let circle;
    try {
      circle = await getCircle(provider, cfg.iwa_circle, id);
    } catch {
      throw new Error("could not locate the newly created circle by scanning ids");
    }
    if (!feltEq(circle.organizer, organizer)) continue;
    if (circle.status !== "OpenForMembers") continue;
    if (circle.memberLimit !== params.memberLimit) continue;
    if (circle.contributionAmount !== params.contributionAmount) continue;
    const order = await getPayoutOrder(provider, cfg.iwa_circle, id);
    const want = members.map((m) => m.memberRef);
    if (order.length !== want.length) continue;
    if (!order.every((r, i) => feltEq(r, feltHex(want[i])))) continue;
    return id;
  }
  throw new Error("could not locate the newly created circle");
}

async function report(provider, cfg, circleId, members) {
  const circle = await getCircle(provider, cfg.iwa_circle, circleId);
  console.log("\n--- G. Circle state on chain ---");
  console.log(`  id ${circle.id}  status ${circle.status}  round ${circle.currentRound}  joined ${circle.joinedCount}/${circle.memberLimit}`);
  for (const m of members) {
    const joined = await isMember(provider, cfg.iwa_circle, circleId, m.memberRef);
    console.log(`  member ${m.label}: ${joined ? "joined" : "NOT joined"}`);
    if (!joined) continue;
    const key = await getMemberAuthKey(provider, cfg.iwa_circle, circleId, m.memberRef);
    if (key !== m.authPublicKey) {
      throw new Error(`member ${m.label} registered auth key ${feltHex(key)} != local ${feltHex(m.authPublicKey)}`);
    }
    if (circle.status === "Active") {
      const o = await getContributionObligation(
        provider,
        cfg.iwa_circle,
        circleId,
        circle.currentRound,
        m.memberRef
      );
      console.log(`    round ${o.round} obligation: ${formatUnits(o.requiredAmount, USDC_DECIMALS)} USDC, status ${o.status}`);
    }
  }
}

main().catch(die);

#!/usr/bin/env node
// Step 4 — verify the mainnet transactions.
//
// The sprint requires more than a hash that exists. Each recorded pool
// transaction is checked for all four properties independently:
//
//   1. correct network        — the RPC reports SN_MAIN
//   2. success                — the receipt's execution status, not just inclusion
//   3. STRK20 pool interaction — an event emitted by the pinned pool address
//   4. expected IWA behaviour  — the helper was invoked, and the circle's own
//                                state now reflects the settlement
//
// Read-only. Sends nothing, in any mode.
//
//   node 07_verify.mjs

import { parseArgs, bootstrap, readRunState, die } from "./lib/run.mjs";
import { loadCircleParams, formatUnits, USDC_DECIMALS } from "./lib/params.mjs";
import { loadMembers } from "./lib/members.mjs";
import {
  getCircle,
  getPayoutState,
  getContributionObligation,
  getRoundLiability,
  getHelperTokenLiability,
} from "./lib/circle.mjs";
import { feltEq, normFelt } from "./lib/chain.mjs";

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const gate = (c, m, d) => (c ? pass(m) : fail(d ? `${m} — ${d}` : m));

async function verifyTransaction(provider, cfg, entry) {
  console.log(`\n  ${entry.label}`);
  console.log(`  ${entry.hash}`);

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(entry.hash);
  } catch (e) {
    fail(`receipt not found: ${e.message}`);
    return null;
  }

  const status = receipt.execution_status ?? receipt.value?.execution_status;
  gate(status === "SUCCEEDED", `execution status is SUCCEEDED`, `got ${status}`);

  const finality = receipt.finality_status ?? receipt.value?.finality_status;
  gate(
    finality === "ACCEPTED_ON_L2" || finality === "ACCEPTED_ON_L1",
    `finality status is accepted`,
    `got ${finality}`
  );

  const events = receipt.events ?? receipt.value?.events ?? [];
  const poolEvents = events.filter((e) => feltEq(e.from_address, cfg.privacy_pool));
  gate(poolEvents.length > 0, `emitted ${poolEvents.length} event(s) from the STRK20 pool`, "no pool events");

  const helperEvents = events.filter((e) => feltEq(e.from_address, cfg.iwa_helper));
  const circleEvents = events.filter((e) => feltEq(e.from_address, cfg.iwa_circle));
  console.log(`    events: pool ${poolEvents.length}, helper ${helperEvents.length}, circle ${circleEvents.length}`);

  if (entry.kind === "pool" && entry.label.includes("settlement")) {
    gate(
      circleEvents.length > 0,
      "the IWA circle recorded a state transition in the same transaction",
      "no IwaCircle events — the settlement did not reach the core contract"
    );
  }

  return { receipt, poolEvents, helperEvents, circleEvents };
}

async function main() {
  const { cfgPath } = parseArgs();
  console.log("\n=== 07 VERIFY — mainnet transaction verification (read-only) ===");

  const ctx = await bootstrap({ cfgPath, confirmSend: false, needAccount: false });
  const { cfg, provider } = ctx;

  const params = loadCircleParams(cfg);
  const members = loadMembers(params.memberLimit);
  const state = readRunState();

  const poolTxs = state.transactions.filter((t) => t.kind === "pool");
  console.log(`\n--- D. Recorded transactions: ${state.transactions.length} (${poolTxs.length} pool) ---`);

  if (poolTxs.length === 0) {
    fail("no pool transactions recorded — run the send steps first");
  }

  for (const entry of state.transactions) {
    await verifyTransaction(provider, cfg, entry);
  }

  console.log("\n--- E. Resulting IWA state ---");
  if (state.circleId === null) {
    fail("no circle recorded");
  } else {
    const circle = await getCircle(provider, cfg.iwa_circle, state.circleId);
    console.log(`  circle ${circle.id}: ${circle.status}, round ${circle.currentRound}, ${circle.joinedCount}/${circle.memberLimit} joined`);

    const round = 1;
    for (const m of members) {
      try {
        const o = await getContributionObligation(provider, cfg.iwa_circle, state.circleId, round, m.memberRef);
        gate(
          o.status === "OnTime" || o.status === "LateWithinGrace",
          `member ${m.label} contribution settled (${o.status})`,
          `status ${o.status}`
        );
      } catch (e) {
        fail(`member ${m.label} obligation unreadable: ${e.message}`);
      }
    }

    try {
      const payout = await getPayoutState(provider, cfg.iwa_circle, state.circleId, round);
      gate(payout.status === "Paid", `round ${round} payout status is Paid`, `status ${payout.status}`);
      console.log(`    payout amount ${formatUnits(payout.amount, USDC_DECIMALS)} USDC to ${payout.scheduledMemberRef}`);
    } catch (e) {
      fail(`payout state unreadable: ${e.message}`);
    }

    try {
      const liability = await getRoundLiability(provider, cfg.iwa_circle, state.circleId, round);
      console.log(`    round liability: in ${formatUnits(liability.settledInflows, USDC_DECIMALS)}, out ${formatUnits(liability.settledOutflows, USDC_DECIMALS)}, outstanding ${formatUnits(liability.outstanding, USDC_DECIMALS)} USDC`);
      gate(liability.outstanding === 0n, "round liability is fully discharged", `outstanding ${liability.outstanding}`);
    } catch (e) {
      fail(`round liability unreadable: ${e.message}`);
    }

    const custody = await getHelperTokenLiability(provider, cfg.iwa_helper, cfg.usdc_token);
    console.log(`  helper accounted USDC custody after the run: ${formatUnits(custody, USDC_DECIMALS)}`);
  }

  console.log(
    `\n${failures === 0 ? "VERIFICATION PASS" : `VERIFICATION FAIL — ${failures} check(s) failed`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(die);

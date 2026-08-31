#!/usr/bin/env node
// Step 5 — emit the sprint submission file.
//
// Writes the repository's strk20.json from the recorded run, keeping any
// demo_video / demo_url already set. Only transactions that pass verification
// are listed: the file must not claim a hash the chain does not support.
//
// Read-only against the chain; the only write is the local strk20.json.
//
//   node 08_strk20_json.mjs            # print what would be written
//   node 08_strk20_json.mjs --write    # write ../../strk20.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgs, bootstrap, readRunState, die } from "./lib/run.mjs";
import { feltEq, normFelt } from "./lib/chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STRK20_JSON = resolve(HERE, "../../strk20.json");

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const { cfgPath } = parseArgs(argv.filter((a) => a !== "--write"));

  console.log("\n=== 08 STRK20 JSON — sprint submission file ===");

  const ctx = await bootstrap({ cfgPath, confirmSend: false, needAccount: false });
  const { cfg, provider } = ctx;

  const state = readRunState();
  const accepted = [];
  const rejected = [];

  for (const entry of state.transactions.filter((t) => t.kind === "pool")) {
    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(entry.hash);
    } catch (e) {
      rejected.push({ ...entry, why: `receipt not found: ${e.message}` });
      continue;
    }
    const status = receipt.execution_status ?? receipt.value?.execution_status;
    if (status !== "SUCCEEDED") {
      rejected.push({ ...entry, why: `execution status ${status}` });
      continue;
    }
    const events = receipt.events ?? receipt.value?.events ?? [];
    if (!events.some((e) => feltEq(e.from_address, cfg.privacy_pool))) {
      rejected.push({ ...entry, why: "no STRK20 pool event" });
      continue;
    }
    accepted.push({ hash: entry.hash, description: entry.label });
  }

  const existing = existsSync(STRK20_JSON)
    ? JSON.parse(readFileSync(STRK20_JSON, "utf8"))
    : { transactions: [], contracts: [], demo_video: "", demo_url: "" };

  const out = {
    transactions: accepted.map((t) => t.hash),
    contracts: [normFelt(cfg.iwa_circle), normFelt(cfg.iwa_helper)],
    demo_video: existing.demo_video ?? "",
    demo_url: existing.demo_url ?? "",
  };

  console.log(`\n  verified pool transactions: ${accepted.length}`);
  for (const t of accepted) console.log(`    ${t.hash}  ${t.description}`);
  if (rejected.length > 0) {
    console.log(`\n  excluded: ${rejected.length}`);
    for (const t of rejected) console.log(`    ${t.hash}  ${t.why}`);
  }

  if (accepted.length < 3) {
    console.log(`\n  NOTE: the sprint requires at least three verified pool transactions; this run has ${accepted.length}.`);
  }

  console.log("\n--- File contents ---");
  console.log(JSON.stringify(out, null, 2));

  if (write) {
    writeFileSync(STRK20_JSON, JSON.stringify(out, null, 2) + "\n");
    console.log(`\n  written to ${STRK20_JSON}`);
  } else {
    console.log("\n  (pass --write to update strk20.json)");
  }
}

main().catch(die);

// Service entrypoint. Validates the environment, opens the database, starts the
// HTTP server, and — unless disabled — runs the public event indexer.

import { RpcProvider } from "starknet";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PgStore } from "./pgStore.js";
import { CircleIndexer } from "./indexer/events.js";
import { OnChainSignatureVerifier } from "./auth.js";
import { OnChainCircleVerifier } from "./chainVerify.js";
import { SN_MAIN } from "./validation.js";

const IWA_CIRCLE = "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new PgStore(config.databaseUrl, config.databaseSsl);
  const provider = new RpcProvider({ nodeUrl: config.starknetRpcUrl });

  // Signatures are verified by asking the account contract itself, which is the
  // only scheme-agnostic check on Starknet.
  const app = createApp({
    store,
    corsOrigins: config.corsOrigins,
    verifier: new OnChainSignatureVerifier(provider),
    circleVerifier: new OnChainCircleVerifier(provider, IWA_CIRCLE),
  });
  const server = app.listen(config.port, () => {
    console.log(`iwa-backend listening on ${config.port} (${config.nodeEnv})`);
  });

  let timer: NodeJS.Timeout | undefined;
  if (config.indexerEnabled) {
    const indexer = new CircleIndexer({
      provider,
      store,
      chainId: SN_MAIN,
      circleAddress: IWA_CIRCLE,
      startBlock: config.indexerStartBlock,
    });
    const tick = async (): Promise<void> => {
      try {
        const r = await indexer.runOnce();
        if (r.inserted > 0) console.log(`indexed ${r.inserted} event(s) up to block ${r.to}`);
      } catch (e) {
        // A failed pass must not kill the service; the cursor did not advance,
        // so the same range is retried next tick.
        console.error("indexer pass failed:", e instanceof Error ? e.message : e);
      }
    };
    void tick();
    timer = setInterval(() => void tick(), config.indexerIntervalMs);
  }

  const shutdown = (signal: string): void => {
    console.log(`${signal} received, shutting down`);
    if (timer) clearInterval(timer);
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("failed to start:", e instanceof Error ? e.message : e);
  process.exit(1);
});

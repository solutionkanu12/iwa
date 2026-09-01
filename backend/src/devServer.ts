// Development server: the real routes, the real auth, an in-memory store.
//
// Exists so the frontend flow can be exercised without Postgres. It is NOT for
// production — data lives only in memory and disappears on restart, and the
// signature verifier still checks against the chain, so a real Ready signature
// is required exactly as in production.
//
//   npm run dev:memory

import { RpcProvider } from "starknet";

import { createApp } from "./app.js";
import { MemoryStore } from "./store.js";
import { OnChainSignatureVerifier } from "./auth.js";
import { OnChainCircleVerifier } from "./chainVerify.js";

const PORT = Number(process.env.PORT ?? 8080);
const RPC = process.env.STARKNET_RPC_URL ?? "https://api.cartridge.gg/x/starknet/mainnet";
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The deployed accounting contract, the same one production verifies against. */
const IWA_CIRCLE = "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be";

const provider = new RpcProvider({ nodeUrl: RPC });

const app = createApp({
  store: new MemoryStore(),
  corsOrigins: ORIGINS,
  verifier: new OnChainSignatureVerifier(provider),
  circleVerifier: new OnChainCircleVerifier(provider, IWA_CIRCLE),
});

app.listen(PORT, () => {
  console.log(`iwa-backend (in-memory, development only) on ${PORT}`);
  console.log(`CORS: ${ORIGINS.join(", ")}`);
  console.log("Data is not persisted. Use npm start with Postgres for anything real.");
});

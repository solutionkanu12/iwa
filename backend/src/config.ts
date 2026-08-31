// Environment configuration, validated at boot.
//
// A misconfigured service must fail to start, not start and behave subtly
// wrongly. Nothing here has a default that points at production by accident.

import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Postgres connection string. Railway and Render both provide this. */
  DATABASE_URL: z.string().min(1),
  /** Set when the provider terminates TLS itself (Railway, Render internal). */
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  STARKNET_RPC_URL: z.string().url(),
  /** Comma-separated exact origins. No wildcard in production. */
  CORS_ORIGINS: z.string().default(""),
  /** Blocks the indexer loop when false, e.g. on a second replica. */
  INDEXER_ENABLED: z.enum(["true", "false"]).default("true"),
  INDEXER_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  /** Block to start indexing from on a cold database. */
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).default(14160000),
});

export type Config = {
  port: number;
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  databaseSsl: boolean;
  starknetRpcUrl: string;
  corsOrigins: string[];
  indexerEnabled: boolean;
  indexerIntervalMs: number;
  indexerStartBlock: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment: ${detail}`);
  }
  const v = parsed.data;

  const corsOrigins = v.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  if (v.NODE_ENV === "production" && corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must list the exact frontend origins in production");
  }
  if (corsOrigins.includes("*")) {
    throw new Error("CORS_ORIGINS must not be a wildcard");
  }

  return {
    port: v.PORT,
    nodeEnv: v.NODE_ENV,
    databaseUrl: v.DATABASE_URL,
    databaseSsl: v.DATABASE_SSL === "true",
    starknetRpcUrl: v.STARKNET_RPC_URL,
    corsOrigins,
    indexerEnabled: v.INDEXER_ENABLED === "true",
    indexerIntervalMs: v.INDEXER_INTERVAL_MS,
    indexerStartBlock: v.INDEXER_START_BLOCK,
  };
}

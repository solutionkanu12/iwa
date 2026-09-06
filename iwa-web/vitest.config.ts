import { defineConfig } from "vitest/config";

// Node-only unit tests for chain-neutral core/adapter types.
// Keep this separate from vite.config.ts so production builds stay uncoupled.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/core/**/*.test.ts",
      "src/chains/**/*.test.ts",
      "src/lib/**/*.test.ts",
      "src/app/**/*.test.ts",
      "src/app/**/*.test.tsx",
      "src/landing/**/*.test.ts",
      "src/screens/**/*.test.ts",
      "src/screens/**/*.test.tsx",
    ],
  },
});

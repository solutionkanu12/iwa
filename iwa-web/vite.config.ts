import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Iwa frontend dev/build config. Static site, no server, no env secrets beyond
// a public RPC URL (added later behind the lib/ seam).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      // Three pages: index.html (main.tsx) serves both the landing page and
      // the app from one bundle, so a connected wallet carries straight
      // through with no second connect step. litepaper.html and roadmap.html
      // stay separate, untouched entries.
      input: {
        main: "index.html",
        litepaper: "litepaper.html",
        roadmap: "roadmap.html",
      },
    },
  },
});

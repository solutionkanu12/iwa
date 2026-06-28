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
      // Three pages: the app (index.html), the marketing landing page
      // (landing.html), and the litepaper (litepaper.html). The app and landing
      // entries are unchanged.
      input: {
        main: "index.html",
        landing: "landing.html",
        litepaper: "litepaper.html",
      },
    },
  },
});

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
      // Four pages: the app (index.html), the marketing landing page
      // (landing.html), the litepaper (litepaper.html), and the roadmap
      // (roadmap.html). The app, landing, and litepaper entries are unchanged.
      input: {
        main: "index.html",
        landing: "landing.html",
        litepaper: "litepaper.html",
        roadmap: "roadmap.html",
      },
    },
  },
});

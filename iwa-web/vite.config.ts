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
      // Two pages: the app (index.html) and the public marketing landing page
      // (landing.html). The app entry is unchanged.
      input: {
        main: "index.html",
        landing: "landing.html",
      },
    },
  },
});

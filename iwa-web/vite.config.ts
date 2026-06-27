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
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 43800,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:43802",
      "/auth": "http://127.0.0.1:43802",
    },
  },
});

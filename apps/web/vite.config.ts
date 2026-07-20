import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@svyft/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
  build: { commonjsOptions: { include: [/[\\/]packages[\\/]shared[\\/]/, /node_modules/] } },
});

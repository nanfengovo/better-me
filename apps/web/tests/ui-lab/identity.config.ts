import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Normal main.tsx/IdentityGate/App, separate hostname/cookie/storage. No jobs or real Agent Host.
export default defineConfig({ root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: fileURLToPath(new URL("../../../../output/identity-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: 5323, strictPort: true, hmr: false, allowedHosts: ["identity-regression.localhost"],
    proxy: { "/api/v1/agent": { target: "http://127.0.0.1:5329", changeOrigin: false } },
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });

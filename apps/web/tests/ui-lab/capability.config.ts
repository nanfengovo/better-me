import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const adoption = process.env.CAPABILITY_LAB_ADOPTION === "1", handoff = process.env.CAPABILITY_LAB_HANDOFF === "1", m2 = process.env.CAPABILITY_LAB_M2 === "1";
export default defineConfig({ root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: fileURLToPath(new URL("../../../../output/capability-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: adoption ? 5396 : handoff ? 5395 : m2 ? 5394 : 5393, strictPort: true, hmr: false, allowedHosts: ["capability-regression.localhost", "capability-m2.localhost", "capability-review.localhost", "capability-adoption.localhost"],
    proxy: { "/api/v1/agent": { target: adoption ? "http://127.0.0.1:5402" : handoff ? "http://127.0.0.1:5401" : m2 ? "http://127.0.0.1:5400" : "http://127.0.0.1:5399", changeOrigin: false } },
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });

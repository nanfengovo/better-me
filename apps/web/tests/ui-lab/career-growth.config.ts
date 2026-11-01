import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deliberately no real job-service, Agent Host, app-data or credential middleware.
export default defineConfig({ root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: fileURLToPath(new URL("../../../../output/career-growth-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: 5203, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });

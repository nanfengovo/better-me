import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// No application data plugins, job service, normal browser storage or port 5173.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: fileURLToPath(new URL("../../../../output/chatgpt-lab-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: 5197, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] },
    proxy: { "/api/v1/agent/": "http://127.0.0.1:5207" },
  },
});

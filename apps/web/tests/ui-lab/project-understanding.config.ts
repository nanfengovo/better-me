import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deliberately not the normal dev config: no jobs service, no real data directory.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: fileURLToPath(new URL("../../../../output/understanding-lab-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: Number(process.env.BETTER_ME_UNDERSTANDING_WEB_PORT ?? 5196), strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] },
    proxy: { "/api/v1/agent/understanding": `http://127.0.0.1:${process.env.BETTER_ME_UNDERSTANDING_TEST_PORT ?? 5206}` },
  },
});

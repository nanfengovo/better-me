import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [react(), tailwindcss()],
  cacheDir: fileURLToPath(new URL("../../../../output/delivery-lab-cache/", import.meta.url)),
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5411, strictPort: true, hmr: false, allowedHosts: ["delivery-verification.localhost"], fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: fileURLToPath(new URL("../../../../output/ui-audit/", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL("./ui-audit.html", import.meta.url)) },
  },
  preview: { host: "0.0.0.0", port: 5196, strictPort: true },
});

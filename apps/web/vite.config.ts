import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { jdExtractorPlugin } from "./server/jd-extractor";

export default defineConfig({
  plugins: [react(), tailwindcss(), jdExtractorPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
});

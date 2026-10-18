import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { jdExtractorPlugin } from "./server/jd-extractor";
import { opportunitySourcesPlugin } from "./server/opportunity-sources";
import { networkProxyPlugin } from "./server/network-proxy";
import { atlasAssetsPlugin } from "./server/atlas-assets";

export default defineConfig({
  plugins: [react(), tailwindcss(), atlasAssetsPlugin(), networkProxyPlugin(), jdExtractorPlugin({ useNativeLiepin: true, useNativeBoss: true, useNative51Job: true }), opportunitySourcesPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    watch: {
      // Saving a test must not reload the workbench and end a live browser session.
      ignored: ["**/tests/**", "**/.agent-memory/.tmp/**"],
    },
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
});

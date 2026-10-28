import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { jdExtractorPlugin } from "./server/jd-extractor";
import { opportunitySourcesPlugin } from "./server/opportunity-sources";
import { networkProxyPlugin } from "./server/network-proxy";
import { atlasAssetsPlugin } from "./server/atlas-assets";
import { cesiumAssetsPlugin } from "./server/cesium-assets";
import { atlasDevIndexPlugin } from "./server/atlas-dev-index";
import { agentHostDevPlugin } from "./server/agent-host-dev";

const isWin = process.platform === "win32";

export default defineConfig({
  plugins: [react(), tailwindcss(), atlasAssetsPlugin(), cesiumAssetsPlugin(), agentHostDevPlugin(), atlasDevIndexPlugin(), networkProxyPlugin(), jdExtractorPlugin({ useNativeLiepin: isWin, useNativeBoss: isWin, useNative51Job: isWin }), opportunitySourcesPlugin()],
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

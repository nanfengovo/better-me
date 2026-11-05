/** Opt-in isolated browser fixture. Never starts normal services, reads existing stores, or calls models. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createAgentServer } from "../../agent-host/src/server.js";
import { socialIdp } from "../../agent-host/tests/fixtures/social-idp.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-social-browser-"));
// Resolve a Host-owned test dependency without adding it to the Web runtime.
const { MemorySaver } = createRequire(new URL("../../agent-host/package.json", import.meta.url))("@langchain/langgraph");
const frontend = "http://localhost:5383", idp = await socialIdp(frontend + "/api/v1/agent/identity/oidc/callback");
const host = createAgentServer({ port: 5389, host: "127.0.0.1", allowedOrigins: [frontend], authToken: "better-me-agent-token",
  identityDirectory: path.join(directory, "accounts"), checkpointer: new MemorySaver() as never, runtimeDefinitions: [], oidc: idp.options });
const web = await createServer({ configFile: false, root: fileURLToPath(new URL("../", import.meta.url)),
  cacheDir: path.join(directory, "vite-cache"), plugins: [react(), tailwindcss(), { name: "social-fixture-only", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", frontend);
      if (url.pathname === "/__fixture/catalog" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(Buffer.from(chunk)));
        req.on("end", () => { const data = JSON.parse(Buffer.concat(chunks).toString());
          idp.controls.offline = data.offline === true; idp.controls.disabled = new Set(data.disabled ?? []);
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ syntheticOnly: true })); });
        return;
      }
      if (url.pathname === "/") req.url = "/tests/ui-lab/social-login.html" + url.search;
      next();
    });
  } }], resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5383, strictPort: true, hmr: false,
    proxy: { "/api/v1/agent": { target: "http://127.0.0.1:5389", changeOrigin: false } },
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] } } });
await web.listen();
console.log(JSON.stringify({ isolation: "signed-fictional-identity-only", url: frontend, directory }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void (async () => { host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve()));
    await web.close(); await idp.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); })();
});

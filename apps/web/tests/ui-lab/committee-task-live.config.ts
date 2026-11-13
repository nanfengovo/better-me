import http from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createAgentServer } from "../../../agent-host/src/server";
import { MemorySaver } from "../../../agent-host/tests/fixtures/checkpointer";

const origin = "http://127.0.0.1:5296", token = "synthetic_committee_only_" + "x".repeat(43), root = fileURLToPath(new URL("../../", import.meta.url));
function isolatedCommittee(): Plugin { return { name: "isolated-committee-kernel-real-http",
  transformIndexHtml(html) { return html.replace("<head>", `<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({ mode: "docker", origin, agentToken: token, jobToken: token })}</script>`); },
  async configureServer(vite) {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-committee-browser-"))), source = path.join(directory, "synthetic-source"); await mkdir(source); await writeFile(path.join(source, "lease.ts"), "export const lease = 'synthetic only';\n// 完整合成源码😀\n");
    let modelCalls = 0, committeeCalls = 0, adapters = 0, legacyCalls = 0; const paths: string[] = [];
    const host = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [origin], runtimeDefinitions: [], identityDirectory: path.join(directory, "identity"), checkpointer: new MemorySaver() as never,
      careerStudioLocalClient: runtime => ({ binding: async () => ({ id: "synthetic-metadata", version: "v1", location: "local", endpointFingerprint: "c".repeat(64), ...runtime }), complete: async () => { legacyCalls++; throw Error("legacy executor tripwire"); } }),
      careerTaskReasoner: async () => { adapters++; return async (prompt, _signal, phase, _images, _source, schema) => {
        modelCalls++; if (phase === "free_chat") return JSON.stringify({ kind: "reply", content: "已有合成根账" });
        if (phase !== "studio_committee" || !schema || prompt.includes("PRIVATE-PRIOR-CHAT")) throw Error("unexpected phase or inherited chat");
        committeeCalls++; await delay(committeeCalls>=16?1500:400); if (committeeCalls === 4) return { text: "  完整部分回复😀\r\nTAIL  ", finishReason: "length" };
        const branch = Array.isArray(schema.anyOf) ? schema.anyOf[0] as Record<string, unknown> : schema;
        const properties = branch.properties as Record<string, { const: string; prefixItems?: Array<{ properties: Record<string, { const: unknown }> }> }>;
        if (properties.kind!.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: properties.requests!.prefixItems!.map(item => Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, value.const]))) });
        const snapshot = JSON.parse(prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!);
        return JSON.stringify({ kind: "assessment", role: prompt.match(/Role=(\w+);/)![1], summary: "仅合成审查，非事实认证。", claims: snapshot.claims.map((claim: { id: string }) => ({ claimId: claim.id, support: "unknown", citations: [], counterCitations: [], risks: [], missing: ["本人贡献未知"], questions: ["哪些行为已经实际验证？"], defense: [] })) });
      }; } });
    await once(host, "listening"); const address = host.address(); if (!address || typeof address === "string") throw Error("synthetic Host failed");
    vite.httpServer?.once("close", () => host.close());
    vite.middlewares.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'");
      const pathname = new URL(request.url ?? "/", origin).pathname;
      if (pathname === "/__committee-task-qa/state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ modelCalls, committeeCalls, adapters, legacyCalls, paths, directory, source })); return; }
      if (!pathname.startsWith("/api/")) return next(); paths.push(`${request.method} ${pathname}`);
      if (!pathname.startsWith("/api/v1/agent/tasks") && !pathname.startsWith("/api/v1/agent/identity/") && !pathname.startsWith("/api/v1/agent/career-studio/")) { response.statusCode = 403; response.end(); return; }
      const proxy = http.request({ hostname: "127.0.0.1", port: address.port, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${address.port}` } }, upstream => { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); });
      proxy.on("error", () => { response.statusCode = 502; response.end(); }); request.pipe(proxy);
    });
  },
}; }
export default defineConfig({ root, plugins: [react(), tailwindcss(), isolatedCommittee()], resolve: { dedupe: ["react", "react-dom"] }, optimizeDeps: { entries: ["tests/ui-lab/committee-task-live.html"] }, server: { host: "127.0.0.1", port: 5296, strictPort: true, hmr: false, fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });

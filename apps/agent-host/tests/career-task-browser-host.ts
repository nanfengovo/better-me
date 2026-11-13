/** Manual browser acceptance harness. Entirely synthetic, private temp stores,
 * ephemeral ports, no provider key, no real model or business service. */
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const directory = process.env.CAREER_TASK_FIXTURE_DIRECTORY ?? await mkdtemp(path.join(os.tmpdir(), "betterme-career-ui-"));
let hostPort = 0;
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
const web = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  if (url.pathname.startsWith("/api/v1/agent")) {
    const proxy = http.request({ hostname: "127.0.0.1", port: hostPort, path: req.url, method: req.method,
      headers: { ...req.headers, origin: origin, host: `127.0.0.1:${hostPort}` },
    }, upstream => { res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy); return;
  }
  if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  try {
    let filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!filename.startsWith(`${root}${path.sep}`) && filename !== root) throw Error("outside static root");
    if (!(await stat(filename).catch(() => undefined))?.isFile()) filename = path.join(root, "index.html");
    const contents = await readFile(filename);
    res.writeHead(200, { "Content-Type": mime[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(contents);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
web.listen(Number(process.env.CAREER_TASK_FIXTURE_PORT ?? 0), "127.0.0.1"); await once(web, "listening");
const address = web.address(); if (!address || typeof address === "string") throw Error("missing fixture address");
const origin = `http://127.0.0.1:${address.port}`;
let calls = 0;
let generatedCandidates=0;
const host = createAgentServer({ port: 0, host: "127.0.0.1", allowedOrigins: [origin], authToken: "better-me-agent-token",
  checkpointer: new MemorySaver() as never, identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"), runtimeDefinitions: [],
  careerTaskReasoner: async () => async (prompt,_signal,phase) => {
    calls++;
    if(phase==="tool_source")return JSON.stringify({source:++generatedCandidates===1?"function(){return {records:[]}}":"function(input){return {records:input.text.split(/\\r?\\n/).map((text,i)=>({line:i+1,text:text.trim()})).filter(row=>row.text.length>0)}}"});
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)) as { fieldManifest: { id: string; targetRef: unknown }[]; evidence: { id: string; kind: string; sourceId: string; excerpt: string }[];availableTools:{tool:string}[];toolArtifacts:{versionId:string}[];installedToolVersions:string[];materialManifest:{id:string;kind:string}[];recentObservations:{tool:string}[] };
    if (!input.evidence.some(e => e.kind === "job")) return JSON.stringify({ kind: "tool", tool: "read_job" });
    const field = input.fieldManifest[0]!;
    const original = input.evidence.find(e => e.sourceId === `resume:${field.id}`);
    if (!original) return JSON.stringify({ kind: "tool", tool: "read_resume", id: field.id });
    if(input.availableTools.some(t=>t.tool==="build_tool")&&!input.toolArtifacts.length)return JSON.stringify({kind:"tool",tool:"build_tool",id:"material-lines-v1"});
    const version=input.toolArtifacts[0]?.versionId??input.installedToolVersions[0];
    if(version&&input.materialManifest[0]&&!input.recentObservations.some(t=>t.tool==="use_tool"))return JSON.stringify({kind:"tool",tool:"use_tool",id:version,materialId:input.materialManifest[0].id});
    const statement=input.materialManifest.find(m=>m.kind==="user_statement"&&!input.evidence.some(e=>e.sourceId===`material:${m.id}`));
    if(statement)return JSON.stringify({kind:"tool",tool:"read_material",id:statement.id});
    if (!input.evidence.some(e => e.kind === "user_statement")) return JSON.stringify({ kind: "ask_user", question: "合成验收：这段项目中，你本人承担了什么工作？", evidenceIds: [original.id] });
    return JSON.stringify({ kind: "draft", patches: [{ fieldId: field.id, targetRef: field.targetRef, originalText: original.excerpt,
      proposedText: `面向目标岗位：${original.excerpt}`, evidenceIds: [original.id], rationale: "合成验收仅调整表达，不增加能力、数字或归属。" }], unknowns: ["此为离线合成验收，未调用外部模型。"] });
  },
});
await once(host, "listening"); const hostAddress = host.address();
if (!hostAddress || typeof hostAddress === "string") throw Error("missing host address"); hostPort = hostAddress.port;
console.log(JSON.stringify({ fixtureOrigin: origin, storage: directory, externalModelCalls: 0 }));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  console.log(JSON.stringify({ syntheticDecisions: calls,generatedCandidates, externalModelCalls: 0 }));
  host.closeAllConnections(); web.closeAllConnections();
  host.close(); web.close(() => process.exit(0));
});

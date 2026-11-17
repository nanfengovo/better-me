/** Opt-in real public-index benchmark. The explicit SQLite file is opened only
 * by a read-only WAL worker; no outbox, external source, model or writer starts.
 * Usage: node --import tsx scripts/verify-atlas-browse-readonly.ts /absolute/jobs.sqlite */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { createJobHttpServer } from "../apps/job-service/src/http.ts";
import type { RuntimeResponse, SerializedToolResult } from "../apps/job-service/src/application-runtime-protocol.ts";
import type { TrustedToolContext, ToolResult } from "@better-me/opportunities";
import { compute } from "../apps/web/tests/fixtures/atlas-compute-harness.ts";

const databasePath = process.argv[2];
assert.ok(databasePath && isAbsolute(databasePath), "Choose one explicit absolute public-index SQLite path.");
const bootstrap = `const {tsImport}=await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); await tsImport(${JSON.stringify(new URL("../apps/job-service/src/application-runtime-worker.ts", import.meta.url).href)}, ${JSON.stringify(import.meta.url)});`;
const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv: [], workerData: {
  databasePath, readOnly: true, config: { dataDirectory: "/tmp", allowedOrigins: ["http://localhost:5296"] },
} });
const pending = new Map<number, (result: SerializedToolResult) => void>();
const wire: Array<{ tool: string; bytes: number; ms: number; ok: boolean }> = [];
let sequence = 0;
const ready = new Promise<void>((resolve, reject) => {
  worker.on("error", reject);
  worker.on("message", (message: RuntimeResponse) => {
    if (message.type === "ready") resolve();
    else if (message.type === "result") { pending.get(message.id)?.(message.result); pending.delete(message.id); }
  });
});
const permitted = new Set(["jobs.browse", "jobs.browse-query", "jobs.browse-penetration", "jobs.browse-detail", "jobs.search"]);
const registry = {
  async executeSerialized(tool: string, input: unknown, context: TrustedToolContext): Promise<SerializedToolResult> {
    assert.ok(permitted.has(tool), "benchmark permits public reads only");
    const id = ++sequence, started = performance.now(), { signal: _signal, ...wireContext } = context;
    const result = await new Promise<SerializedToolResult>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Read-only benchmark timed out.")); }, 45_000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      worker.postMessage({ type: "execute", id, tool, input, context: wireContext });
    });
    wire.push({ tool, bytes: result.json.byteLength, ms: Math.round(performance.now() - started), ok: result.ok });
    return result;
  },
  async execute<O>(tool: string, input: unknown, context: TrustedToolContext): Promise<ToolResult<O>> {
    return JSON.parse(new TextDecoder().decode((await registry.executeSerialized(tool, input, context)).json));
  },
};
const token = randomBytes(24).toString("hex"), server = createJobHttpServer({ registry, token, allowedOrigins: ["http://localhost:5296"], port: 0 });
const { client, responses } = compute();
let ticker: ReturnType<typeof setInterval> | undefined;
try {
  await ready;
  const { url } = await server.listen();
  const gaps: number[] = []; let previous = performance.now();
  ticker = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 16);
  const start = performance.now(), data = await client.readSnapshot(url, token, { view: "browse" });
  const readMs = Math.round(performance.now() - start);
  const queryStart = performance.now(), query = { mapLevel: "location" as const, page: { limit: 50 } };
  const first = await client.queryPage(data, query);
  const firstQueryMs = Math.round(performance.now() - queryStart);
  clearInterval(ticker);
  const secondStart = performance.now(), second = await client.queryPage(data, query, {}, { pageIndex: 1 });
  const nextPageMs = Math.round(performance.now() - secondStart);
  assert.deepEqual(first.summary.mapBuckets, second.summary.mapBuckets);
  assert.equal(first.summary.totalJobs, data.jobs.length);
  const csharpStart = performance.now(), csharpQuery = { ...query, search: { text: "C#" } };
  const csharp = await client.queryPage(data, csharpQuery);
  const csharpMs = Math.round(performance.now() - csharpStart);
  const reference = await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(csharpQuery) });
  const expected = (await reference.json()).value;
  assert.equal(csharp.summary.totalJobs, expected.totalJobs);
  assert.deepEqual(csharp.summary.mapBuckets, expected.mapBuckets);
  assert.deepEqual(csharp.page.items.map(row => row.job.id), expected.items.map((row: { job: { id: string } }) => row.job.id));
  const detailStart = performance.now(), detail = await client.detail(data, first.page.items[0]!.job.id);
  const detailMs = Math.round(performance.now() - detailStart);
  assert.equal(detail.snapshotRevision, data.revision);
  assert.equal(detail.job.description, first.page.items[0]!.job.description);
  const beforePoll = responses.length, pollStart = performance.now();
  assert.equal(await client.readSnapshot(url, token, { view: "browse" }), data);
  const unchangedMs = Math.round(performance.now() - pollStart);
  assert.equal(responses.slice(beforePoll).filter(message => message.type === "chunk").length, 0);
  console.log(JSON.stringify({ readOnly: true, writes: 0, externalCalls: 0, revision: data.revision, jobs: data.jobs.length,
    browseObservations: data.observations.length, browseSnapshots: data.snapshots.length, browseDescriptionBytes: data.jobs.reduce((sum, job) => sum + job.description.length, 0),
    readMs, firstQueryMs, nextPageMs, csharpMs, csharpMatches: csharp.summary.totalJobs, mappedJobs: first.summary.mappedJobs,
    detailMs, detailSnapshots: detail.snapshots.length, unchangedMs, callerMaxTickGapMs: Math.round(Math.max(...gaps)), referenceMatches: true, wire }, null, 2));
} finally {
  clearInterval(ticker); client.dispose();
  // Only this isolated read-only worker is terminated. No user service is stopped.
  await worker.terminate(); await server.close();
}

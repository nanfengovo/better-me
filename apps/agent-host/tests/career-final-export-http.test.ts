import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { CareerStudio } from "../src/career-studio/service.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { createFinalExportHttp, type CareerFinalExportRenderer } from "../src/career-studio/final-export-http.js";
import { careerExportRendererFromEnvironment } from "../src/career-studio/export-config.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = Buffer.from("<!doctype html><html><body>Synthetic only</body></html>");
async function fixture(t: test.TestContext, mode: "configured" | "unconfigured" | "late" = "configured") {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "betterme-export-http-")));
  const studio = new CareerStudio({ ownerId: "synthetic-export-owner", directory, broker: new EvidenceBroker({ forbiddenRoots: [directory] }) });
  let valid = true, calls = 0;
  const access = { session: "synthetic-export-session", valid: async () => valid };
  const { context } = await studio.createContext({ workspaceKey: "synthetic-export", resumeId: "resume-export", sourceFingerprint: "a".repeat(64), claims: [], jobs: [], consent: true }, access);
  // A transport/lifecycle seam, not a fake renderer acceptance test. Actual
  // Chromium and isolated LibreOffice are separately tested by the renderer.
  const renderer: CareerFinalExportRenderer = { close() {}, async render(input) {
    calls++; assert.equal(await input.isCurrent(), true);
    if (mode === "late") valid = false;
    return { format: input.format, inputContentHash: input.inputContentHash, sourceSha256: digest(input.input), renderedSha256: digest(source), sourceBytes: input.input, pdfBytes: source, renderer: { name: "synthetic-transport-only", version: "not-a-file-validation" }, at: new Date().toISOString() };
  } };
  const readBody = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
  const handle = createFinalExportHttp({ studio, ...(mode !== "unconfigured" ? { renderer } : {}), readBody,
    sendJson(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } });
  const server = createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url!, "http://localhost").pathname, { ...access, session: String(req.headers["x-fixture-session"] ?? access.session) })) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { studio.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const body = { contextId: context.id, operationId: "synthetic-operation", format: "pdf", contentHash: context.sourceFingerprint, inputSha256: digest(source), inputBase64: source.toString("base64"), consent: true };
  const post = async (patch = {}, session = access.session) => { const result = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent/career-studio/layout/export`, { method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Session": session }, body: JSON.stringify({ ...body, ...patch }) }); return { status: result.status, data: await result.json() }; };
  return { post, calls: () => calls };
}
test("final export transport binds exact bytes, version and operation without persisting or choosing an executable", async t => {
  const f = await fixture(t), result = await f.post(); assert.equal(result.status, 200); assert.equal(result.data.sourceSha256, digest(source)); assert.equal(result.data.operationId, "synthetic-operation"); assert.equal(f.calls(), 1);
});
test("forged byte hash, malformed base64, alternate version and HTTP executable fields cannot reach renderer", async t => {
  const f = await fixture(t);
  for (const patch of [{ inputSha256: "b".repeat(64) }, { inputBase64: "Zm9v=" }, { contentHash: "c".repeat(64) }, { executablePath: "/untrusted" }, { consent: false }]) assert.notEqual((await f.post(patch)).status, 200);
  assert.equal(f.calls(), 0);
});
test("a different session and late identity revocation cannot receive file success", async t => {
  const f = await fixture(t, "late"); assert.notEqual((await f.post({}, "other-session")).status, 200); assert.equal(f.calls(), 0); assert.notEqual((await f.post()).status, 200); assert.equal(f.calls(), 1);
});
test("unconfigured renderer reports unavailable, with no discovery or fallback", async t => {
  const f = await fixture(t, "unconfigured"); const result = await f.post(); assert.equal(result.status, 422); assert.equal(result.data.error, "final_export_renderer_not_configured"); assert.equal(f.calls(), 0);
});
test("installation export configuration is explicit, path-bounded and does not launch or discover a binary", () => {
  assert.equal(careerExportRendererFromEnvironment({}), undefined);
  assert.throws(() => careerExportRendererFromEnvironment({ BETTERME_CAREER_EXPORT_CHROMIUM_SHA256: "a".repeat(64) }), /incomplete/);
  assert.throws(() => careerExportRendererFromEnvironment({ BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS: "[]" }), /incomplete/);
  for (const env of [{ BETTERME_CAREER_EXPORT_CHROMIUM: "relative" }, { BETTERME_CAREER_EXPORT_SOFFICE: "/synthetic/soffice", BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS: '["relative"]' }, { BETTERME_CAREER_EXPORT_CHROMIUM: "/synthetic/chromium", BETTERME_CAREER_EXPORT_CHROMIUM_SHA256: "not-a-hash" }]) assert.throws(() => careerExportRendererFromEnvironment(env));
  careerExportRendererFromEnvironment({ BETTERME_CAREER_EXPORT_CHROMIUM: "/synthetic/not-launched" })!.close();
});

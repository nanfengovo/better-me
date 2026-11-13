import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { CareerStudio, type StudioPublicationRecord } from "../src/career-studio/service.js";
import { createCareerStudioHttp } from "../src/career-studio/http.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";

const readBody = async (request: IncomingMessage): Promise<unknown> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
const sendJson = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };

test("production Studio publication projection preserves self-report contribution and limitations over actual official MCP HTTP, never relabels excerpt review as independent verification", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-mcp-provenance-"))), ownerId = "synthetic-provenance-owner";
  const studio = new CareerStudio({ ownerId, directory, broker: new EvidenceBroker({ forbiddenRoots: [directory] }) });
  const access = { session: "synthetic-provenance-session", valid: async () => true };
  // A synthetic legacy derived publication record, NOT a business Fact write
  // or a forged independent receipt. Current publicationReview uses this
  // internal status while explicitly limiting its personal attribution.
  const record: StudioPublicationRecord = { id: "synthetic-publication", contextId: "synthetic-context", operationId: "synthetic-committee", claimId: "synthetic-claim", claimHash: "a".repeat(64), receiptHash: "b".repeat(64), createdAt: new Date().toISOString(),
    fact: { id: "synthetic-publication", revision: "a".repeat(64), status: "verified", disclosure: "publishable", statement: "实现一个合成本地状态恢复机制。", verificationReceiptHash: "b".repeat(64),
      contribution: "implementation（本人自述，非独立作者认证）：实现合成恢复边界；角色：个人演示；部署：未部署。",
      limitations: "仅核对授权片段版本；个人归属为本人自述，无独立作者认证，不证明生产规模或公司认可。",
      evidence: [{ id: "synthetic-excerpt", revision: "c".repeat(64), summary: "合成授权片段版本已核对，原文不公开。" }] },
    review: { kind: "implementation", role: "个人演示", action: "实现合成恢复边界", deployment: "未部署" } };
  studio.store.put("publication-review", record.id, 0, record);
  const server = createServer(async (request, response) => { const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
    if (await handler.handlePublic(request, response, pathname)) return;
    if (!await handler.handleOwner(request, response, pathname, access)) sendJson(response, 404, { error: "synthetic_route_unknown" });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const handler = createCareerStudioHttp({ studio, ownerId, baseURL, allowedOrigins: [], readBody, sendJson });
  t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`${baseURL}/api/v1/agent/career-studio/twin/token-issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "mcp", scopes: ["career:facts:read"], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxCalls: 2 }) });
  assert.equal(response.status, 200);
  const issued = z.object({ token: z.string(), mcpEndpoint: z.string().url() }).passthrough().parse(await response.json());
  const client = new Client({ name: "synthetic-provenance-reader", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(issued.mcpEndpoint), { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } }, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } }));
  t.after(() => client.close());
  const result = await client.callTool({ name: "list_career_facts", arguments: { expectedRevision: studio.publicationRevision(), limit: 20 } });
  assert.notEqual(result.isError, true);
  const output = z.object({ revision: z.number(), facts: z.array(z.object({ id: z.string(), text: z.string(), status: z.string(), evidenceIds: z.array(z.string()), contribution: z.string().optional(), limitations: z.string().optional() }).strict()) }).strict().parse(result.structuredContent);
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0]!.status, "self_reported");
  assert.equal(output.facts[0]!.contribution, record.fact.contribution);
  assert.equal(output.facts[0]!.limitations, record.fact.limitations);
  assert.deepEqual(output.facts[0]!.evidenceIds, ["synthetic-excerpt"]);
  assert.equal(studio.store.get<StudioPublicationRecord>("publication-review", record.id)!.value.fact.status, "verified", "projection must not rewrite a stored publication or business Fact");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { GROWTH_PRACTICE_RUNTIME, GROWTH_PRACTICE_STARTER_SOURCE } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("generic career-task routes cannot admit synthetic growth tasks into career storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-route-boundary-"));
  const token = "synthetic-growth-route-token";
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never });
  try {
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = await registerTestIdentity(origin, token, "synthetic-growth-boundary");
    const headers = { ...owner.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const sourceText = "只在合成成长空间练习。";
    const input = { kind: "growth_practice", workspaceKey: "synthetic-boundary", rootScopeKey: "growth:synthetic-boundary",
      objective: "合成练习不能写进职业任务目录", runtimeBinding: GROWTH_PRACTICE_RUNTIME,
      request: { sourceId: "checkpoint-note-v1", sourceText, sourceHash: createHash("sha256").update(sourceText).digest("hex"),
        sourceCode: GROWTH_PRACTICE_STARTER_SOURCE, answer: "保存断点", explanation: "只读恢复" },
      consent: true, idempotencyKey: "synthetic-growth-route-boundary" };
    for (const route of ["tasks", "career-tasks"]) {
      const response = await fetch(`${origin}/api/v1/agent/${route}`, { method: "POST", headers, body: JSON.stringify(input) });
      assert.equal(response.status, 422, `growth practice must use its isolated journey route, not ${route}`);
      assert.deepEqual(await response.json(), { error: "growth_practice_use_journey" });
    }
    const response = await fetch(`${origin}/api/v1/agent/tasks`, { headers });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { tasks: [] });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("an imported learning text is immutable, byte-verified and private to its authenticated owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-learning-http-"));
  const token = "synthetic-learning-materials-only";
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "understanding"), checkpointer: new MemorySaver() as never });
  try {
    await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const alice = await registerTestIdentity(origin, token, "learning-alice");
    const bob = await registerTestIdentity(origin, token, "learning-bob");
    const call = (headers: Record<string, string>, suffix: string, body?: unknown) => fetch(`${origin}/api/v1/agent/growth/learning${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers: { ...headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = "工具结果与操作编号一起持久化。恢复时先读取回执；已有成功回执时不要重复执行。";
    const input = { requestId: "original-text-v1", consent: true, name: "工具回执讲义.txt", mediaType: "text/plain", base64: Buffer.from(text).toString("base64") };
    const imported = await call(alice.headers, "/materials", input);
    assert.equal(imported.status, 201, await imported.clone().text());
    const { material } = await imported.json();
    assert.equal(material.pages[0].blocks[0].text, text);
    assert.equal(material.pages[0].status, "text");
    assert.equal(material.modelConsent, false, "import never authorizes model sharing");
    const duplicate = await call(alice.headers, "/materials", input);
    assert.equal((await duplicate.json()).material.id, material.id);
    assert.equal((await call(bob.headers, `/materials/${material.id}`)).status, 404);
    assert.equal((await call(bob.headers, `/materials/${material.id}/bytes`)).status, 404);
    assert.equal((await call(bob.headers, `/materials/${material.id}/passages/1/b1`)).status, 404);
    const created = await call(alice.headers, "/paths", { requestId: "private-goal", consent: true, title: "合成隔离目标", weeklyHours: 3 });
    assert.equal(created.status, 201);
    const privatePath = (await created.json()).path;
    assert.equal((await call(bob.headers, `/paths/${privatePath.id}`)).status, 404);
    const malformed = await fetch(`${origin}/api/v1/agent/growth/learning/paths`, {
      method: "POST", headers: { ...alice.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{",
    });
    assert.equal(malformed.status, 400);
    const raw = await call(alice.headers, `/materials/${material.id}/bytes`);
    assert.equal(await raw.text(), text, "original bytes have a binary endpoint, not the task text reader");
    const second = await call(alice.headers, "/materials", { ...input, requestId: "original-text-v2", base64: Buffer.from(text + "\n没有回执时先对账，不能直接重试。").toString("base64") });
    const revision = (await second.json()).material;
    assert.notEqual(revision.id, material.id);
    assert.equal((await (await call(alice.headers, `/materials/${material.id}`)).json()).material.hash, material.hash);
    assert.equal((await call(alice.headers, "/materials", { ...input, base64: Buffer.from("不同正文").toString("base64") })).status, 409);
    const revoked = await call(alice.headers, `/materials/${material.id}/revoke`, { requestId: "revoke-original", consent: true });
    assert.equal(revoked.status, 200);
    assert.equal((await call(alice.headers, `/materials/${material.id}/bytes`)).status, 403);
    assert.equal((await call(alice.headers, `/materials/${material.id}/passages/1/b1`)).status, 403);
    assert.equal(JSON.stringify(await (await call(alice.headers, `/materials/${material.id}`)).json()).includes(text), false);
    assert.deepEqual((await (await fetch(`${origin}/api/v1/agent/tasks`, { headers: { ...alice.headers, Authorization: `Bearer ${token}` } })).json()).tasks, []);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

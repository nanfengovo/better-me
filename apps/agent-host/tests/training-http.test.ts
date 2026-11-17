import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
test("training HTTP derives owner from auth and never runs posted code or exposes other owners", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "betterme-training-http-")),
    token = "training-fixture-only";
  const host = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    allowedOrigins: [],
    runtimeDefinitions: [],
    identityDirectory: path.join(dir, "identity"),
    runsDirectory: path.join(dir, "runs"),
    understandingDirectory: path.join(dir, "understanding"),
    checkpointer: new MemorySaver() as never,
  });
  try {
    await once(host, "listening");
    const address = host.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    const one = await registerTestIdentity(origin, token, "training-owner-one"),
      two = await registerTestIdentity(origin, token, "training-owner-two");
    const call = (h: Record<string, string>, route: string, body?: object) =>
      fetch(origin + "/api/v1/agent/growth/learning/training" + route, {
        method: body ? "POST" : "GET",
        headers: {
          ...h,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    assert.equal((await call({}, "")).status, 401);
    const req = {
      goal: "demo",
      evidence: "demo case",
      consent: true,
      requestId: randomUUID(),
      engine: { type: "example", example: "rewrite" },
    };
    assert.equal(
      (await call(one.headers, "/plan", { ...req, source: "i=>1" })).status,
      400,
    );
    const { plan } = await (await call(one.headers, "/plan", req)).json();
    assert.equal(plan.origin, "example");
    const build = { planId: plan.id, requestId: randomUUID(), consent: true };
    assert.equal((await call(two.headers, "/build", build)).status, 404);
    const { kit } = await (await call(one.headers, "/build", build)).json();
    assert.equal(kit.modelCalls, 0);
    assert.equal(
      (
        await call(one.headers, "/" + kit.id + "/commands", {
          action: "keep",
          revision: 0,
        })
      ).status,
      200,
    );
    assert.equal((await call(two.headers, "/" + kit.id)).status, 404);
    assert.deepEqual(await (await call(two.headers, "")).json(), { kits: [] });
    assert.equal(
      (
        await call(two.headers, "/" + kit.id + "/commands", {
          action: "discard",
          revision: 1,
        })
      ).status,
      404,
    );
    assert.equal((await call(one.headers, "/" + kit.id)).status, 200);
  } finally {
    await new Promise<void>((r) => host.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

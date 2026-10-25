import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";

describe("agent-host HTTP Server", () => {
  let server: http.Server;
  const port = 5199;
  const token = "test-agent-secret-token";
  const baseUrl = `http://127.0.0.1:${port}`;

  before(async () => {
    const checkpointer = new MemorySaver() as any;
    server = createAgentServer({
      port,
      host: "127.0.0.1",
      allowedOrigins: ["http://127.0.0.1:5173"],
      authToken: token,
      checkpointer,
    });
    await new Promise((resolve) => server.once("listening", resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("rejects unauthorized requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  it("returns 404 when querying unknown thread state", async () => {
    const res = await fetch(`${baseUrl}/api/v1/agent/jd-match/state/unknown-thread-404`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "thread_not_found");
  });
});

import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { startLocalAgentRun, streamLocalAgentRun } from "../src/services/agent-client.ts";

afterEach(() => mock.restoreAll());

test("starts a local run with an explicit ContextPack and sandbox mode", async () => {
  let request: RequestInit | undefined;
  mock.method(globalThis, "fetch", async (_url, options) => {
    request = options;
    return Response.json({ run: { id: "run_1", status: "running" }, eventsUrl: "/events", statusUrl: "/status" }, { status: 202 });
  });
  const result = await startLocalAgentRun({ runtimeId: "codex", prompt: "读岗位", sandboxMode: "required", contextPack: { role: "test", task: "读岗位", content: { source: "fixture" } } });
  assert.equal(result.run.id, "run_1");
  assert.equal((request?.headers as Record<string, string>).Authorization, "Bearer better-me-agent-token");
  const body = JSON.parse(String(request?.body));
  assert.equal(body.sandboxMode, "required");
  assert.equal(body.contextPack.content.source, "fixture");
});

test("parses chunked SSE frames and ignores keepalives", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": keepalive\n\n"));
      controller.enqueue(encoder.encode("id: run_1:1:x\nevent: text.delta\ndata: {\"id\":\"run_1:1:x\",\"runId\":\"run_1\",\"sequence\":1,"));
      controller.enqueue(encoder.encode("\"type\":\"text.delta\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"payload\":{\"text\":\"hi\"}}\n\n"));
      controller.close();
    },
  });
  mock.method(globalThis, "fetch", async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }> = [];
  await streamLocalAgentRun({ runId: "run_1", after: 0, onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{
    id: "run_1:1:x",
    runId: "run_1",
    sequence: 1,
    type: "text.delta",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { text: "hi" },
  }]);
});

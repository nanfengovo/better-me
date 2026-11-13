import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { startLocalAgentRun, streamLocalAgentRun,startCareerWorkflow,resumeCareerWorkflow,getLegacyCareerWorkflow } from "../src/services/agent-client.ts";

afterEach(() => mock.restoreAll());

test("retired local execution refuses before any network request", async () => {
  let calls=0;
  mock.method(globalThis,"fetch",async()=>{calls++;throw Error("retired client must not fetch");});
  await assert.rejects(startLocalAgentRun({runtimeId:"codex",prompt:"完整原文"}),error=>error instanceof Error&&"code" in error&&error.code==="runtime_run_moved_to_tasks");
  assert.equal(calls,0);
});

test("retired career start/resume refuse before fetch; legacy checkpoint reads full data and rejects mismatched responses",async()=>{
  let calls=0;mock.method(globalThis,"fetch",async()=>{calls++;throw Error("no retired execution request");});
  const input={threadId:"legacy",task:"  原文😀  "};
  await assert.rejects(startCareerWorkflow(input),error=>error instanceof Error&&"code" in error&&error.code==="career_workflow_moved_to_tasks");
  await assert.rejects(resumeCareerWorkflow({threadId:"legacy",approval:{status:"approved",actorScope:"synthetic",idempotencyKey:"synthetic-key"}}),error=>error instanceof Error&&"code" in error&&error.code==="career_workflow_moved_to_tasks");
  await assert.rejects(getLegacyCareerWorkflow({threadId:"../foreign"}),/标识无效/);assert.equal(calls,0);
  const full="  完整历史😀\r\n"+"不裁剪。".repeat(10000)+"END  ",record={legacy:true,readOnly:true,threadId:"legacy",checkpointId:"synthetic-checkpoint",state:{task:full,artifacts:[{payload:{task:full}}]},pendingWrites:[["interrupt",full]]};
  mock.method(globalThis,"fetch",async(url,init)=>{calls++;assert.match(String(url),/\/workflows\/career\/state\/legacy$/);assert.equal(init?.body,undefined);assert.equal(init?.method??"GET","GET");return Response.json(record);});
  assert.deepEqual(await getLegacyCareerWorkflow({threadId:"legacy"}),record);assert.equal(calls,1);
  mock.method(globalThis,"fetch",async()=>Response.json({...record,threadId:"other"}));
  await assert.rejects(getLegacyCareerWorkflow({threadId:"legacy"}),/格式不完整/);
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

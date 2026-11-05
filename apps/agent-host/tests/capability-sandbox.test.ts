import test from "node:test";
import assert from "node:assert/strict";
import { executeTransform } from "../src/capabilities/sandbox.js";

test("generated transform executes in a fresh JSON-only realm", async () => {
  assert.deepEqual(await executeTransform("x => ({value:x.value+1, host:typeof process, net:typeof fetch, fs:typeof require})", { value: 2 }),
    { value: 3, host: "undefined", net: "undefined", fs: "undefined" });
  await executeTransform("x => { globalThis.previous=x; return x; }", { canary: "first-only" });
  assert.equal(await executeTransform("() => typeof previous", {}), "undefined");
});

test("host escape probes cannot acquire files, secrets, sockets or subprocesses", async () => {
  assert.deepEqual(await executeTransform(`() => [typeof process,typeof require,typeof fetch,typeof WebSocket,typeof std,typeof os,typeof Buffer,
    (function(){}).constructor('return typeof process')()]`, {}), Array(8).fill("undefined"));
  await assert.rejects(executeTransform(`() => import('node:fs')`, {}));
});
test("infinite execution, heap exhaustion and oversized output are forcibly rejected", async () => {
  await assert.rejects(executeTransform("() => {while(true){}}", {}));
  await assert.rejects(executeTransform("() => {const a=[];while(true)a.push(new Array(10000).fill('memory'));}", {}));
  await assert.rejects(executeTransform("() => 'a'.repeat(3*1024*1024)", {}));
  await assert.rejects(executeTransform("x => x", "x".repeat(3*1024*1024)));
});
test("cancellation terminates an active interpreter rather than leaving orphan work", async () => {
  const abort = new AbortController(); const started = Date.now();
  const result = executeTransform("() => {while(true){}}", {}, abort.signal);
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(result, /cancelled/); assert.ok(Date.now() - started < 1500);
  assert.equal(await executeTransform("() => 42", {}), 42);
});

test("an allocation beyond the 16 MiB engine heap is rejected by memory policy, not merely a time limit", async () => {
  await assert.rejects(executeTransform("() => new Array(10*1024*1024).fill(0)", {}), /sandbox_memory_limit/);
});

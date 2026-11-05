import { Worker } from "node:worker_threads";

export const EXECUTION_PROFILE = "quickjs-wasm-json-v1";
export const LIMITS = Object.freeze({ inputBytes: 2 * 1024 * 1024, outputBytes: 2 * 1024 * 1024,
  sourceBytes: 64 * 1024, heapBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024, executionMs: 2000, wallMs: 4000 });

// Only this trusted bootstrap runs in Node. Generated source is DATA passed to
// QuickJS, never evaluated by Node, imported, or given a host function/handle.
const BOOTSTRAP = `
const {parentPort,workerData:d}=require('node:worker_threads');
(async()=>{
  const {getQuickJS}=await import(d.engine);
  const engine=await getQuickJS(), rt=engine.newRuntime();
  rt.setMemoryLimit(d.limits.heapBytes); rt.setMaxStackSize(d.limits.stackBytes);
  const deadline=Date.now()+d.limits.executionMs;
  rt.setInterruptHandler(()=>Date.now()>deadline);
  const vm=rt.newContext();
  try {
    const program='"use strict";const transform=('+d.source+');const output=transform(JSON.parse('+JSON.stringify(d.input)+'));if(output instanceof Promise)throw Error("async_not_allowed");JSON.stringify(output)';
    const result=vm.evalCode(program,'generated-transform.js');
    if(result.error){
      let reason='';
      try{const message=vm.getProp(result.error,'message');try{if(vm.typeof(message)==='string')reason=vm.getString(message);}finally{message.dispose();}}
      finally{result.error.dispose();}
      throw Error(/out of memory/i.test(reason)?'sandbox_memory_limit':/interrupted/i.test(reason)?'sandbox_deadline':'sandbox_execution_failed');
    }
    try {
      if(vm.typeof(result.value)!=='string') throw Error('sandbox_non_json_output');
      const output=vm.getString(result.value);
      if(Buffer.byteLength(output)>d.limits.outputBytes) throw Error('sandbox_output_limit');
      parentPort.postMessage({ok:true,output});
    } finally {result.value.dispose();}
  } finally {vm.dispose();rt.dispose();}
})().catch(error=>parentPort.postMessage({ok:false,code:['sandbox_memory_limit','sandbox_deadline','sandbox_output_limit','sandbox_non_json_output'].includes(error.message)?error.message:'sandbox_execution_failed'}));
`;

/** Fresh WASM realm per call; no filesystem/network/process/credentials bridged. */
export async function executeTransform(source: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const serialized = JSON.stringify(input);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > LIMITS.inputBytes) throw new Error("sandbox_input_limit");
  if (Buffer.byteLength(source) > LIMITS.sourceBytes) throw new Error("sandbox_source_limit");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(BOOTSTRAP, { eval: true, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      workerData: { engine: import.meta.resolve("quickjs-emscripten"), source, input: serialized, limits: LIMITS } });
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // Await termination before resolving: no orphan execution after cancellation.
      void worker.terminate().then(() => error ? reject(error) : resolve(value));
    };
    const abort = () => finish(new Error("sandbox_cancelled"));
    const timer = setTimeout(() => finish(new Error("sandbox_deadline")), LIMITS.wallMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("error", () => finish(new Error("sandbox_worker_failed")));
    worker.once("exit", () => { if (!settled) finish(new Error("sandbox_worker_exited")); });
    worker.once("message", (message: { ok?: boolean; output?: string; code?: string }) => {
      if (!message.ok || typeof message.output !== "string") return finish(new Error(message.code ?? "sandbox_execution_failed"));
      try { finish(undefined, JSON.parse(message.output)); } catch { finish(new Error("sandbox_non_json_output")); }
    });
  });
}

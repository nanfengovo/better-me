import { Worker } from "node:worker_threads";
import { createAtlasComputeClient, type AtlasComputePort } from "../../src/components/atlas/compute-client.ts";
import type { ComputeRequest, ComputeResponse } from "../../src/components/atlas/compute-protocol.ts";

export function compute(options: { onResponse?: (message: ComputeResponse) => void } = {}) {
  const entry = new URL("./atlas-compute-node-worker.ts", import.meta.url).href;
  const bootstrap = `const {tsImport}=await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv: [] });
  const requests: ComputeRequest[] = [], responses: ComputeResponse[] = [];
  const port: AtlasComputePort = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) { requests.push(message); worker.postMessage(message); },
    terminate() { void worker.terminate(); },
  };
  worker.on("message", data => { responses.push(data); options.onResponse?.(data); port.onmessage?.call(worker as unknown as globalThis.Worker, { data } as MessageEvent); });
  worker.on("error", () => port.onerror?.call(worker as unknown as globalThis.Worker, {} as ErrorEvent));
  return { client: createAtlasComputeClient(port), requests, responses };
}

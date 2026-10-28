import { parentPort } from "node:worker_threads";
import { startAtlasComputeWorker } from "../../src/components/atlas/compute-worker.ts";
import type { ComputeRequest, ComputeResponse } from "../../src/components/atlas/compute-protocol.ts";

const port = {
  onmessage: null as null | ((event: { data: ComputeRequest }) => void),
  postMessage: (message: ComputeResponse) => parentPort!.postMessage(message),
};
parentPort!.on("message", data => port.onmessage?.({ data }));
startAtlasComputeWorker(port);

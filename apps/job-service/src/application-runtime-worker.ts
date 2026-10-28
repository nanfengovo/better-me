import { parentPort, workerData } from "node:worker_threads";
import { createJobApplication } from "./application.js";
import { configuredApplicationOptions } from "./configured-application.js";
import { openJobRepository } from "./repository.js";
import { READ_LANE_TOOLS, type RuntimeConfig, type RuntimeRequest, type RuntimeResponse } from "./application-runtime-protocol.js";
import { ToolError, type ToolResult } from "@better-me/opportunities";

const port = parentPort!;
const { databasePath, config, readOnly } = workerData as RuntimeConfig;
const repository = openJobRepository(databasePath, { readOnly });
const application = createJobApplication({ ...configuredApplicationOptions(config, repository), backgroundEnrichment: !readOnly });
const calls = new Map<number, AbortController>();
const pending = new Set<Promise<void>>();
let closing = false;
const send = (message: RuntimeResponse, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

port.on("message", (message: RuntimeRequest) => {
  if (message.type === "cancel") { calls.get(message.id)?.abort(); return; }
  if (message.type === "close") {
    if (closing) return;
    closing = true;
    void (async () => {
      await application.shutdown();
      while (pending.size) await Promise.allSettled([...pending]);
      repository.close();
      send({ type: "closed" });
      port.close();
    })();
    return;
  }
  const controller = new AbortController();
  calls.set(message.id, controller);
  const task = (async () => {
    let result: ToolResult;
    if (closing || readOnly && !READ_LANE_TOOLS.has(message.tool)) {
      const error = new ToolError(closing ? "cancelled" : "not-authorized");
      result = { ok: false, requestId: message.context.requestId, error: { code: error.code, message: error.message } };
    } else {
      result = await application.registry.execute(message.tool, message.input, { ...message.context, signal: controller.signal,
        ...(readOnly ? { allowedEffects: message.context.allowedEffects.filter(effect => effect === "read-index") } : {}) });
    }
    // Validation, bounded JSON traversal and serialization belong in this lane,
    // not the HTTP event loop. Transfer bytes, not a cloned whole-library object.
    const json = new TextEncoder().encode(JSON.stringify(result));
    send({ type: "result", id: message.id, result: { ok: result.ok, ...(!result.ok ? { errorCode: result.error.code } : {}), json } }, [json.buffer]);
  })().finally(() => { calls.delete(message.id); pending.delete(task); });
  pending.add(task);
});
send({ type: "ready" });

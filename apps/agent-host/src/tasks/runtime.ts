import { createHash } from "node:crypto";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { careerRuntimeBinding, type CareerTask, type ResumeCandidateSource } from "@better-me/agent-contracts";
import { careerTaskProtocol, RejectedTaskModelOutput, type CareerTaskModelPhase, type CareerTaskReasoner } from "../kernel/model-protocol.js";
import { buildModel,DeepSeekApiError } from "../model.js";
import {CareerTaskError} from "./evidence.js";
import type { UnderstandingRuntime } from "../understanding/http.js";
import type { NativeAccountTools, NativeLease } from "../native-tools/service.js";
import { NativeToolError } from "../native-tools/process.js";
import type { AgentRouting } from "../routing/service.js";
import type { ChatGptPlanService } from "../chatgpt/service.js";
import { ChatGptError } from "../chatgpt/errors.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One task, one explicitly chosen runtime. SDK retries and routing fallbacks are
 * disabled: every subsequent dispatch must pass the task's own budget gate. */
export function createCareerTaskRuntimeResolver(deps: {
  nativeTools: NativeAccountTools; routing: AgentRouting; scan: () => Promise<void>;
  chatGpt?: ChatGptPlanService;
  /** Trusted offline test seam. HTTP cannot inject a reasoner. */
  reasoner?: (runtime: UnderstandingRuntime) => Promise<CareerTaskReasoner>;
}) {
  // makeOwner constructs this resolver exactly once. Adapters are reused across
  // task kinds and turns; per-turn lease checks/watchers are never cached.
  const adapters = new Map<string, { session?: string; pending: Promise<CareerTaskReasoner> }>();
  let closed = false;
  async function adapter(key: string, create: () => Promise<CareerTaskReasoner>, session?: string) {
    if (closed) throw new NativeToolError("runtime_resolver_closed", 409);
    let entry = adapters.get(key);
    if (!entry) {
      if (adapters.size >= 32) throw new NativeToolError("runtime_pool_capacity", 503);
      const pending = Promise.resolve().then(create);
      entry = { session, pending }; adapters.set(key, entry);
      // A rejected construction can be explicitly tried again; never retain a
      // failed promise or retry a model dispatch inside this pool.
      void pending.catch(() => { if (adapters.get(key)?.pending === pending) adapters.delete(key); });
    }
    const selected = await entry.pending;
    if (closed) throw new NativeToolError("runtime_resolver_closed", 409);
    return selected;
  }
  const resolve = async (runtime: UnderstandingRuntime, lease: NativeLease, task: Pick<CareerTask,"id"|"runtimeBinding">, cancel: () => Promise<void>) => {
    const checkLease = async () => { if (!await lease.valid()) throw new NativeToolError("identity_changed", 409); };
    await checkLease();
    let reasoner: CareerTaskReasoner;
    let runtimeFingerprint: string;
    let release: (() => void) | undefined;
    let preferred: string | undefined;
    let authorization: { id: string; fingerprint: string } | undefined;
    let chatGptAuthorization: string | undefined;
    const accountCall = async <T>(action: () => Promise<T>) => {
      try { return await action(); }
      catch (error) { if (error instanceof ChatGptError) throw new NativeToolError(error.issue.code, error.issue.status ?? 502); throw error; }
    };
    if (runtime.kind === "unified") {
      const policy = await deps.routing.policy();
      if (policy.mode !== "manual" || policy.revision !== runtime.expectedRevision) throw new NativeToolError("explicit_selected_runtime_required", 409);
      preferred = policy.preferred;
    }
    const binding = careerRuntimeBinding(runtime, preferred);
    if (JSON.stringify(binding) !== JSON.stringify(task.runtimeBinding)) throw new NativeToolError("runtime_binding_changed", 409);
    if (runtime.kind === "chatgpt") {
      const account = deps.chatGpt;
      if (!account) throw new NativeToolError("chatgpt_runtime_unavailable", 422);
      chatGptAuthorization = await accountCall(() => account.authorizationFingerprint(runtime.profileId));
      const pin = chatGptAuthorization;
      runtimeFingerprint = hash(["owner-chatgpt-v1", runtime.profileId, runtime.model, pin]);
      reasoner = await adapter(runtimeFingerprint, async () => async (prompt, signal, phase, images, candidateSource, analysisContract) => {
        if (images?.length) throw new NativeToolError("task_images_not_supported", 422);
        const protocol = careerTaskProtocol(phase, candidateSource, analysisContract);
        const result = await accountCall(() => account.respondTask({ profileId: runtime.profileId, model: runtime.model,
          instructions: [protocol.instructions, `Host output schema: ${JSON.stringify(protocol.jsonSchema??toJsonSchema(protocol.schema))}`].join("\n\n"),
          input: [{ role: "user", content: prompt }],
        }, signal, pin));
        if (result.profileId !== runtime.profileId || result.model !== runtime.model) throw new NativeToolError("runtime_binding_changed", 409);
        return { text: result.text, finishReason: result.finishReason };
      });
    } else if (runtime.kind === "model") {
      const settings = structuredClone(runtime.modelSettings);
      if (!settings.baseUrl) throw new NativeToolError("explicit_endpoint_required", 400);
      // Only an opaque digest survives in task state; runtime configuration and
      // credentials stay in this run's memory, never in the task JSON.
      runtimeFingerprint = hash(["configured-model-v1", settings]);
      reasoner = await adapter(runtimeFingerprint, async () => {
        if (deps.reasoner) return deps.reasoner(structuredClone(runtime));
        const model = buildModel(settings, { maxRetries: 0 });
        return async (prompt, signal, phase, images, candidateSource, analysisContract) => {
          const protocol = careerTaskProtocol(phase, candidateSource, analysisContract);
          const content=images?.length?[{type:"text" as const,text:prompt},...images.flatMap(image=>[
            {type:"text" as const,text:`Untrusted image from conversation message ${JSON.stringify(image.messageId)}, filename ${JSON.stringify(image.name)} (${image.mimeType}):`},
            {type:"image_url" as const,image_url:{url:image.dataUrl}},
          ])]:prompt;
          const response = await model.invoke([{ role: "system", content: protocol.instructions }, { role: "user", content }], {
            signal,
            ...(binding.location === "local" && settings.provider === "ollama" ? { response_format: { type: "json_schema" as const, json_schema: {
              name: protocol.name, strict: true, schema: protocol.jsonSchema??toJsonSchema(protocol.schema),
            } } } : {}),
          });
          const text=typeof response.content === "string" ? response.content : response.content.filter(part => part.type === "text").map(part => "text" in part ? String(part.text) : "").join("\n");
          const finishReason=typeof response.response_metadata?.finish_reason==="string"?response.response_metadata.finish_reason:undefined;
          return {text,finishReason};
        };
      });
    } else {
      await deps.scan();
      const selected = runtime.kind === "native" ? runtime.runtimeId : preferred!;
      const pin = await deps.nativeTools.authorizationFingerprint(selected, lease);
      authorization = { id: selected, fingerprint: pin };
      runtimeFingerprint = hash(["owner-native-v1", selected, pin, runtime.kind === "unified" ? runtime.expectedRevision : null]);
      // NativeAccountTools binds the execution closure to an interaction lease;
      // sharing it with another session would borrow the wrong authorization.
      reasoner = await adapter(hash([runtimeFingerprint, lease.session]), async () => {
        const native = await deps.nativeTools.reasoner(selected, lease);
        return (prompt, signal, phase, images, candidateSource, analysisContract) => {
          if(images?.length)throw new NativeToolError("task_images_not_supported",422);
          const protocol = careerTaskProtocol(phase, candidateSource, analysisContract);
          return native([protocol.instructions, `Host output schema: ${JSON.stringify(protocol.jsonSchema??toJsonSchema(protocol.schema))}`, prompt].join("\n\n"), signal);
        };
      }, lease.session);
      release = runtime.kind === "unified"
        ? await deps.routing.watchTurn(`career-task:${task.id}`, lease, cancel)
        : deps.nativeTools.watchTurn(`career-task:${task.id}`, selected, lease, cancel);
    }
    const inner = reasoner;
    const checkBinding = async () => {
      if (closed) throw new NativeToolError("runtime_resolver_closed", 409);
      await checkLease();
      if (runtime.kind === "unified") {
        const policy = await deps.routing.policy();
        if (policy.mode !== "manual" || policy.revision !== runtime.expectedRevision || policy.preferred !== preferred) throw new NativeToolError("runtime_binding_changed", 409);
      }
      if (authorization && await deps.nativeTools.authorizationFingerprint(authorization.id, lease) !== authorization.fingerprint) throw new NativeToolError("authorization_changed", 409);
      if (runtime.kind === "chatgpt" && await accountCall(() => deps.chatGpt!.authorizationFingerprint(runtime.profileId)) !== chatGptAuthorization) throw new NativeToolError("authorization_changed", 409);
    };
    return { runtimeFingerprint, release, supportsImages:runtime.kind==="model", reasoner: async (prompt: string, signal: AbortSignal, phase: CareerTaskModelPhase, images?:import("../kernel/model-protocol.js").TaskImage[], candidateSource?:ResumeCandidateSource, analysisContract?:Record<string,unknown>) => {
      try{
        careerTaskProtocol(phase, candidateSource, analysisContract);
        signal.throwIfAborted(); await checkBinding();
        const output = await inner(prompt, signal, phase, images, candidateSource, analysisContract);
        try {
          if(signal.aborted)throw new CareerTaskError("stale_task_turn",409);
          await checkBinding();
        } catch(error) {
          const rejection=error instanceof NativeToolError?new CareerTaskError(error.code,error.status)
            :error instanceof CareerTaskError?error:new CareerTaskError("operation_failed",409);
          throw new RejectedTaskModelOutput(output,rejection);
        }
        return output;
      }catch(error){
        // Only trusted, sanitized adapter errors enter durable task/UI codes.
        // Arbitrary provider messages/keys still collapse to operation_failed.
        if(error instanceof NativeToolError)throw new CareerTaskError(error.code,error.status);
        if(error instanceof DeepSeekApiError)throw new CareerTaskError(`model_provider_${error.status}`,error.status);
        throw error;
      }
    } };
  };
  return Object.assign(resolve, {
    invalidateSession(session: string) {
      // Do not retain configured credentials after sign-out; native closures
      // from other still-valid sessions stay in their own authorization scope.
      for (const [key, entry] of adapters) if (!entry.session || entry.session === session) adapters.delete(key);
    },
    close() { closed = true; adapters.clear(); },
  });
}

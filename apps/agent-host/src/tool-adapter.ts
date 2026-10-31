/**
 * tool-adapter.ts — Bridge between @better-me/opportunities ToolDefinition
 * (with TrustedToolContext, budget, signal) and @langchain/core DynamicStructuredTool.
 *
 * The existing ToolDefinition / createToolRegistry in packages/opportunities/src/tools.ts
 * is the authoritative tool contract. This adapter wraps it so LangGraph nodes can
 * call registry.execute() through the standard LangChain tool interface.
 *
 * Context injection rules:
 *  - actorScope is always "agent-host/<threadId>" — never "user"
 *  - allowedEffects defaults to ["read-index"] per tool; callers may override for
 *    local-write tools that surface proposals through interrupt()
 *  - API keys and resume text never appear in TrustedToolContext
 *  - idempotencyKey is generated from threadId + toolName + stepIndex so retries
 *    after a checkpoint restore are idempotent
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createToolRegistry } from "@better-me/opportunities";
import type {
  ToolDefinition,
  TrustedToolContext,
  ToolEffect,
} from "@better-me/opportunities";

export interface ToolAdapterOptions {
  threadId: string;
  stepIndex: number;
  signal?: AbortSignal;
  /** Override allowed effects (default: ["read-index"]). */
  allowedEffects?: readonly ToolEffect[];
  /** Override budget (default: read-safe conservative values). */
  budget?: { requests: number; timeoutMs: number; bytes: number };
}

const DEFAULT_BUDGET = {
  requests: 20,
  timeoutMs: 30_000,
  bytes: 4 * 1024 * 1024, // 4 MB
} satisfies { requests: number; timeoutMs: number; bytes: number };

function makeContext(
  toolName: string,
  opts: ToolAdapterOptions
): TrustedToolContext {
  const safeScope = opts.threadId.replace(/[^A-Za-z0-9._:/-]/g, "-").slice(0, 180);
  const idPrefix = toolName.replace(/[^A-Za-z0-9]/g, "-").slice(0, 40);
  const idempotencyKey = `${safeScope}:${idPrefix}:step-${opts.stepIndex}`;
  return {
    requestId: `agent-${idPrefix}-${Date.now()}`,
    actorScope: `agent-host/${safeScope}`,
    idempotencyKey,
    signal: opts.signal ?? new AbortController().signal,
    allowedEffects: opts.allowedEffects ?? ["read-index"],
    budget: opts.budget ?? DEFAULT_BUDGET,
  };
}

/**
 * Wraps a single ToolDefinition into a @langchain/core DynamicStructuredTool.
 * The tool's Zod schema is passed through unchanged; no JSON-Schema conversion needed.
 */
export function adaptTool<I, O>(
  definition: ToolDefinition<I, O>,
  opts: ToolAdapterOptions
): DynamicStructuredTool {
  const registry = createToolRegistry([definition]);
  return new DynamicStructuredTool({
    name: definition.name,
    description: definition.description,
    // DynamicStructuredTool accepts ZodObject; ToolDefinition uses ZodType<I> which is
    // compatible — the generic stays open here to match the DynamicStructuredTool signature.
    schema: definition.inputSchema as unknown as z.ZodObject<z.ZodRawShape>,
    func: async (input: I) => {
      const context = makeContext(definition.name, opts);
      const result = await registry.execute<O>(definition.name, input, context);
      if (!result.ok) throw new Error(result.error.code);
      return JSON.stringify(result.value);
    },
  });
}

/**
 * Adapts every ToolDefinition from a registry snapshot into an array of
 * DynamicStructuredTools ready to bind to a model or a graph node.
 *
 * Only tools whose effect is in allowedEffects are included.
 */
export function adaptRegistryTools(
  definitions: readonly ToolDefinition<any, any>[],
  opts: ToolAdapterOptions
): DynamicStructuredTool[] {
  const allowed = opts.allowedEffects ?? (["read-index"] as readonly ToolEffect[]);
  return definitions
    .filter((d) => allowed.includes(d.effect))
    .map((d) => adaptTool(d, opts));
}

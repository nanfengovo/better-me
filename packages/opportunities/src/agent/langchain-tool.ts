import { z } from "zod";
import type { ToolDefinition, TrustedToolContext, ToolResult } from "../tools.js";

/**
 * Standard structured tool compatible with LangChain Core tool contracts.
 * Matches @langchain/core/tools StructuredTool / DynamicStructuredTool interfaces.
 */
export interface LangChainStructuredTool<TInput = any, TOutput = any> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TInput, z.ZodTypeDef, any>;
  call(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput>;
  invoke(input: TInput, options?: { signal?: AbortSignal }): Promise<TOutput>;
  asOpenAiFunction(): {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Context factory providing TrustedToolContext for an agent-initiated tool execution.
 */
export type AgentContextFactory<TInput = any> = (
  toolName: string,
  input: TInput,
  options?: { signal?: AbortSignal }
) => TrustedToolContext;

/**
 * Default context factory with safe defaults for Agent execution.
 */
export function createDefaultAgentContext(
  toolName: string,
  _input: any,
  options?: { signal?: AbortSignal; actorScope?: string }
): TrustedToolContext {
  const actorScope = options?.actorScope ?? "agent";
  const idPrefix = toolName.replace(/[^a-zA-Z0-9]/g, "-");
  const randomSuffix = Math.random().toString(36).substring(2, 9);
  return {
    requestId: `agent-${idPrefix}-${Date.now()}-${randomSuffix}`,
    actorScope,
    idempotencyKey: `idem-${idPrefix}-${Date.now()}-${randomSuffix}`,
    signal: options?.signal ?? new AbortController().signal,
    allowedEffects: ["read-index", "external-read", "local-write", "external-action"],
    budget: {
      requests: 50,
      timeoutMs: 15_000,
      bytes: 10 * 1024 * 1024,
    },
  };
}

/**
 * Convert a Zod schema to an OpenAI/JSON-Schema compatible parameter dictionary.
 */
export function zodToJsonSchemaObject(schema: z.ZodType<any>): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const field = value as z.ZodType<any>;
      const isOptional = field.isOptional();
      if (!isOptional) {
        required.push(key);
      }
      properties[key] = describeZodField(field);
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {},
  };
}

function describeZodField(field: z.ZodType<any>): Record<string, unknown> {
  if (field instanceof z.ZodOptional || field instanceof z.ZodNullable) {
    return describeZodField(field.unwrap());
  }
  if (field instanceof z.ZodString) {
    return { type: "string" };
  }
  if (field instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (field instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (field instanceof z.ZodArray) {
    return {
      type: "array",
      items: describeZodField(field.element),
    };
  }
  if (field instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: field.options,
    };
  }
  if (field instanceof z.ZodObject) {
    return zodToJsonSchemaObject(field);
  }
  return { type: "string" };
}

/**
 * Wraps a native ToolDefinition into a LangChain-compatible structured tool.
 */
export function toLangChainTool<I, O>(
  definition: ToolDefinition<I, O>,
  contextFactory: AgentContextFactory<I> = createDefaultAgentContext
): LangChainStructuredTool<I, O> {
  const jsonSchema = zodToJsonSchemaObject(definition.inputSchema);

  async function invoke(input: I, options?: { signal?: AbortSignal }): Promise<O> {
    const context = contextFactory(definition.name, input, options);
    // Construct single handler context
    let bytesCharged = 0;
    let requestsCharged = 0;
    const deadline = Date.now() + context.budget.timeoutMs;

    const handlerContext = {
      requestId: context.requestId,
      signal: context.signal,
      budget: context.budget,
      idempotencyKey: context.idempotencyKey,
      actorScope: context.actorScope,
      consumeRequests: (count = 1) => {
        requestsCharged += count;
        if (requestsCharged > context.budget.requests) {
          throw new Error("Tool budget exceeded: requests");
        }
      },
      consumeBytes: (count: number) => {
        bytesCharged += count;
        if (bytesCharged > context.budget.bytes) {
          throw new Error("Tool budget exceeded: bytes");
        }
      },
      throwIfCancelled: () => {
        if (context.signal.aborted) {
          throw new Error("Tool execution cancelled");
        }
        if (Date.now() >= deadline) {
          throw new Error("Tool execution timed out");
        }
      },
    };

    const parsedInput = await definition.inputSchema.parseAsync(input);
    const result = await definition.execute(parsedInput, handlerContext);
    return definition.outputSchema.parseAsync(result);
  }

  return {
    name: definition.name,
    description: definition.description,
    schema: definition.inputSchema,
    call: invoke,
    invoke,
    asOpenAiFunction: () => ({
      name: definition.name,
      description: definition.description,
      parameters: jsonSchema,
    }),
  };
}

/**
 * Wraps an existing ToolRegistry instance into a collection of LangChain-compatible structured tools.
 */
export function toLangChainRegistryTools(
  registry: {
    list: () => readonly { name: string; description: string; inputSchema: z.ZodType<any>; outputSchema: z.ZodType<any> }[];
    execute: (name: string, input: unknown, context: TrustedToolContext) => Promise<ToolResult<any>>;
  },
  contextFactory: AgentContextFactory = createDefaultAgentContext
): Map<string, LangChainStructuredTool> {
  const tools = new Map<string, LangChainStructuredTool>();

  for (const item of registry.list()) {
    const jsonSchema = zodToJsonSchemaObject(item.inputSchema);

    async function invoke(input: any, options?: { signal?: AbortSignal }) {
      const context = contextFactory(item.name, input, options);
      const res = await registry.execute(item.name, input, context);
      if (!res.ok) {
        throw new Error(`[${item.name}] Tool execution failed: ${res.error.code} - ${res.error.message}`);
      }
      return res.value;
    }

    tools.set(item.name, {
      name: item.name,
      description: item.description,
      schema: item.inputSchema,
      call: invoke,
      invoke,
      asOpenAiFunction: () => ({
        name: item.name,
        description: item.description,
        parameters: jsonSchema,
      }),
    });
  }

  return tools;
}

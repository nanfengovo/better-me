import { z } from "zod";

export const TOOL_EFFECTS = ["read-index", "external-read", "local-write", "external-action"] as const;
export type ToolEffect = typeof TOOL_EFFECTS[number];
export const TOOL_ERROR_CODES = [
  "invalid-input", "invalid-output", "invalid-context", "not-authorized", "unsupported-capability",
  "needs-auth", "needs-human-verification", "rate-limited", "partial-result", "source-changed",
  "timeout", "cancelled", "stale-version", "incomparable-salary", "location-unresolved",
  "budget-exceeded", "idempotency-conflict", "internal-error",
] as const;
export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];

const MESSAGES: Record<ToolErrorCode, string> = {
  "invalid-input": "工具输入格式无效。", "invalid-output": "工具返回数据不符合契约。",
  "invalid-context": "执行器上下文无效。", "not-authorized": "当前执行身份未获准执行此类操作。",
  "unsupported-capability": "当前工具不支持所请求的能力。", "needs-auth": "来源需要授权后继续。",
  "needs-human-verification": "来源需要人工验证后继续。", "rate-limited": "来源正在限流，请稍后重试。",
  "partial-result": "来源只返回了部分结果。", "source-changed": "来源结构变化，需要核查适配器。",
  "timeout": "工具执行超时。", "cancelled": "工具执行已取消。", "stale-version": "记录版本已变化，请重新读取。",
  "incomparable-salary": "该薪资缺少统一比较所需信息。", "location-unresolved": "该地点尚未定位。",
  "budget-exceeded": "本次操作超过执行预算。", "idempotency-conflict": "幂等键已用于不同的请求。",
  "internal-error": "工具执行失败；请核对操作状态后再重试。",
};

/** Only typed, fixed public errors cross the UI / HTTP / future Agent boundary. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode) {
    super(MESSAGES[code]);
    this.name = "ToolError";
    this.code = code;
  }
}

export type ToolBudget = { requests: number; timeoutMs: number; bytes: number };

/** Supplied by a trusted executor, never accepted as part of model-controlled tool arguments. */
export type TrustedToolContext = {
  requestId: string;
  signal: AbortSignal;
  budget: ToolBudget;
  idempotencyKey?: string;
  actorScope: string;
  allowedEffects: readonly ToolEffect[];
};

export type ToolHandlerContext = {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly budget: Readonly<ToolBudget>;
  readonly idempotencyKey?: string;
  readonly actorScope: string;
  /** Adapters must account for every outbound request and received byte, including retries. */
  consumeRequests(count?: number): void;
  consumeBytes(count: number): void;
  throwIfCancelled(): void;
};

export type ToolDefinition<I = unknown, O = unknown> = {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  readonly outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
  readonly effect: ToolEffect;
  readonly execute: (input: I, context: ToolHandlerContext) => O | Promise<O>;
};

export type ToolResult<O = unknown> =
  | { ok: true; requestId: string; value: O }
  | { ok: false; requestId: string; error: { code: ToolErrorCode; message: string } };

const CONTEXT_SCHEMA = z.object({
  requestId: z.string().min(1).max(150).regex(/^[A-Za-z0-9._:-]+$/),
  actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  budget: z.object({
    requests: z.number().int().min(0).max(10_000),
    timeoutMs: z.number().int().min(1).max(300_000),
    bytes: z.number().int().min(1).max(64 * 1024 * 1024),
  }).strict(),
  allowedEffects: z.array(z.enum(TOOL_EFFECTS)).max(TOOL_EFFECTS.length),
}).strict();

export function defineTool<I, O>(definition: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!definition || typeof definition !== "object" || !/^[a-z][a-z0-9]*(?:[._-][a-z][a-z0-9]*)*$/.test(definition.name)
    || definition.name.length > 150 || !Number.isSafeInteger(definition.version) || definition.version < 1
    || typeof definition.description !== "string" || !definition.description.trim() || definition.description.length > 2_000
    || !TOOL_EFFECTS.includes(definition.effect) || typeof definition.execute !== "function"
    || !(definition.inputSchema instanceof z.ZodType) || !(definition.outputSchema instanceof z.ZodType)) {
    throw new ToolError("invalid-input");
  }
  return Object.freeze({ ...definition });
}

/** JSON-only serialization also rejects hidden getters, Date, undefined, cycles and non-finite numbers. */
function jsonText(value: unknown, code: ToolErrorCode, maxBytes = Number.POSITIVE_INFINITY): string {
  const seen = new Set<object>();
  let bytes = 0;
  const charge = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) throw new ToolError("budget-exceeded");
  };
  const chargeString = (value: string) => {
    charge(2);
    for (let index = 0; index < value.length; index++) {
      const point = value.charCodeAt(index);
      if (point === 34 || point === 92 || point === 8 || point === 9 || point === 10 || point === 12 || point === 13) charge(2);
      else if (point < 32) charge(6);
      else if (point < 128) charge(1);
      else if (point < 2048) charge(2);
      else if (point >= 0xd800 && point <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { charge(4); index++; }
      else if (point >= 0xd800 && point <= 0xdfff) charge(6);
      else charge(3);
    }
  };
  function visit(item: unknown, depth: number): unknown {
    if (depth > 100) throw new ToolError(code);
    if (item === null) { charge(4); return item; }
    if (typeof item === "string") { chargeString(item); return item; }
    if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
    if (typeof item === "number" && Number.isFinite(item)) { charge(JSON.stringify(item).length); return item; }
    if (typeof item !== "object" || !item) throw new ToolError(code);
    if (seen.has(item) || Object.getOwnPropertySymbols(item).length) throw new ToolError(code);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new ToolError(code);
    seen.add(item);
    let output: unknown;
    if (Array.isArray(item)) {
      charge(2 + Math.max(0, item.length - 1));
      output = Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) throw new ToolError(code);
        return visit(descriptor.value, depth + 1);
      });
      if (Object.getOwnPropertyNames(item).length !== item.length + 1) throw new ToolError(code);
    } else {
      const keys = Object.getOwnPropertyNames(item).sort();
      charge(2 + Math.max(0, keys.length - 1));
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ToolError(code);
        chargeString(key); charge(1);
        result[key] = visit(descriptor.value, depth + 1);
      }
      output = result;
    }
    seen.delete(item);
    return output;
  }
  return JSON.stringify(visit(value, 0));
}

function failure(error: unknown, requestId: string): ToolResult<never> {
  const code = error instanceof ToolError && TOOL_ERROR_CODES.includes(error.code) ? error.code : "internal-error";
  return { ok: false, requestId, error: { code, message: MESSAGES[code] } };
}

function detachedResult<O>(result: ToolResult, requestId: string): ToolResult<O> {
  // A caller must not mutate the process-local receipt through a previously returned value.
  return { ...JSON.parse(JSON.stringify(result)), requestId } as ToolResult<O>;
}

async function awaitReceipt(pending: Promise<ToolResult>, context: TrustedToolContext, deadline: number): Promise<ToolResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ToolError("cancelled"));
    context.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => reject(new ToolError("timeout")), Math.max(0, deadline - Date.now()));
    if (context.signal.aborted) onAbort();
  });
  try { return await Promise.race([pending, interrupted]); }
  finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort) context.signal.removeEventListener("abort", onAbort);
  }
}

/** Shared runtime for HTTP, UI and future Agent wrappers; it never performs network or storage itself. */
export function createToolRegistry(definitions: readonly ToolDefinition<any, any>[]) {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const receipts = new Map<string, { signature: string; pending: Promise<ToolResult> }>();
  for (const raw of definitions) {
    const tool = defineTool(raw);
    if (tools.has(tool.name)) throw new ToolError("invalid-input");
    tools.set(tool.name, tool);
  }

  async function execute<O = unknown>(name: string, input: unknown, context: TrustedToolContext): Promise<ToolResult<O>> {
    let requestId = "invalid-context";
    try {
      const trusted = CONTEXT_SCHEMA.safeParse({
        requestId: context?.requestId, actorScope: context?.actorScope, idempotencyKey: context?.idempotencyKey,
        budget: context?.budget, allowedEffects: context?.allowedEffects,
      });
      if (!trusted.success || !(context.signal instanceof AbortSignal)) throw new ToolError("invalid-context");
      requestId = trusted.data.requestId;
      const deadline = Date.now() + trusted.data.budget.timeoutMs;
      const tool = tools.get(name);
      if (!tool) throw new ToolError("unsupported-capability");
      if (!trusted.data.allowedEffects.includes(tool.effect)) throw new ToolError("not-authorized");
      if (context.signal.aborted) throw new ToolError("cancelled");
      const inputText = jsonText(input, "invalid-input", trusted.data.budget.bytes);
      const mutating = tool.effect === "local-write" || tool.effect === "external-action";
      if (mutating && !trusted.data.idempotencyKey) throw new ToolError("invalid-context");
      const receiptKey = mutating ? JSON.stringify([trusted.data.actorScope, tool.name, trusted.data.idempotencyKey]) : undefined;
      const signature = JSON.stringify([tool.version, inputText]);
      if (Date.now() >= deadline) throw new ToolError("timeout");
      if (receiptKey) {
        const existing = receipts.get(receiptKey);
        if (existing) {
          if (existing.signature !== signature) throw new ToolError("idempotency-conflict");
          const result = await awaitReceipt(existing.pending, context, deadline);
          if (context.signal.aborted) throw new ToolError("cancelled");
          if (Date.now() >= deadline) throw new ToolError("timeout");
          if (result.ok) jsonText(result.value, "invalid-output", trusted.data.budget.bytes);
          const detached = detachedResult<O>(result, requestId);
          if (Date.now() >= deadline) throw new ToolError("timeout");
          return detached;
        }
      }
      if (receiptKey && receipts.size >= 10_000) throw new ToolError("budget-exceeded");

      const run = async (): Promise<ToolResult> => {
        const controller = new AbortController();
        let abortCode: "cancelled" | "timeout" = "cancelled";
        const forwardAbort = () => controller.abort();
        context.signal.addEventListener("abort", forwardAbort, { once: true });
        const timeout = setTimeout(() => { abortCode = "timeout"; controller.abort(); }, Math.max(0, deadline - Date.now()));
        let requests = 0;
        let bytes = 0;
        const check = () => {
          if (Date.now() >= deadline && !controller.signal.aborted) { abortCode = "timeout"; controller.abort(); }
          if (controller.signal.aborted) throw new ToolError(abortCode);
        };
        const consume = (kind: "requests" | "bytes", count: number) => {
          check();
          if (!Number.isSafeInteger(count) || count < 0) throw new ToolError("budget-exceeded");
          if (kind === "requests") requests += count; else bytes += count;
          if (requests > trusted.data.budget.requests || bytes > trusted.data.budget.bytes) throw new ToolError("budget-exceeded");
        };
        const handlerContext: ToolHandlerContext = Object.freeze({
          requestId, signal: controller.signal, budget: Object.freeze({ ...trusted.data.budget }),
          actorScope: trusted.data.actorScope, idempotencyKey: trusted.data.idempotencyKey,
          consumeRequests: (count = 1) => consume("requests", count),
          consumeBytes: (count: number) => consume("bytes", count), throwIfCancelled: check,
        });
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new ToolError(abortCode));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const work = async () => {
            check();
            const parsed = await tool.inputSchema.safeParseAsync(JSON.parse(inputText));
            if (!parsed.success) throw new ToolError("invalid-input");
            check();
            const output: unknown = await tool.execute(parsed.data, handlerContext);
            check();
            // Validate before and after parsing: coercions must not conceal an unserializable service result.
            jsonText(output, "invalid-output", trusted.data.budget.bytes - bytes);
            const validated = await tool.outputSchema.safeParseAsync(output);
            if (!validated.success) throw new ToolError("invalid-output");
            check();
            const serialized = jsonText(validated.data, "invalid-output", trusted.data.budget.bytes - bytes);
            consume("bytes", new TextEncoder().encode(serialized).byteLength);
            const detached: unknown = JSON.parse(serialized);
            check();
            return detached;
          };
          const value: unknown = await Promise.race([work(), aborted]);
          return { ok: true, requestId, value };
        } catch (error) {
          return failure(error, requestId);
        } finally {
          clearTimeout(timeout);
          context.signal.removeEventListener("abort", forwardAbort);
          if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        }
      };
      const pending = run();
      if (receiptKey) {
        receipts.set(receiptKey, { signature, pending });
        // Failed / interrupted operations are not silently retried by this runtime. A service must
        // use durable receipts for writes that may have committed before a timeout or cancellation.
      }
      const result = detachedResult<O>(await pending, requestId);
      if (Date.now() >= deadline) throw new ToolError("timeout");
      return result;
    } catch (error) {
      return failure(error, requestId);
    }
  }

  return Object.freeze({
    list: () => [...tools.values()].map(({ name, version, description, inputSchema, outputSchema, effect }) => ({ name, version, description, inputSchema, outputSchema, effect })),
    execute,
  });
}

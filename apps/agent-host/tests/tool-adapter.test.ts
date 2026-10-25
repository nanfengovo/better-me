import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool } from "@better-me/opportunities";
import { adaptTool, adaptRegistryTools } from "../src/tool-adapter.js";

describe("agent-host Tool Adapter", () => {
  it("adapts a native ToolDefinition into a LangChain DynamicStructuredTool", async () => {
    const inputSchema = z.object({
      keyword: z.string(),
      limit: z.number().optional(),
    });
    const outputSchema = z.object({
      found: z.number(),
      results: z.array(z.string()),
    });

    const nativeTool = defineTool({
      name: "jobs.test-search",
      version: 1,
      description: "Test searching jobs",
      effect: "read-index",
      inputSchema,
      outputSchema,
      execute: (input) => ({
        found: 1,
        results: [`Matched: ${input.keyword}`],
      }),
    });

    const lcTool = adaptTool(nativeTool, {
      threadId: "test-thread-01",
      stepIndex: 1,
    });

    assert.equal(lcTool.name, "jobs.test-search");
    assert.equal(lcTool.description, "Test searching jobs");

    // Execute via LangChain invoke
    const rawResult = await lcTool.invoke({ keyword: "TypeScript" });
    const parsed = JSON.parse(rawResult);
    assert.deepEqual(parsed, {
      found: 1,
      results: ["Matched: TypeScript"],
    });
  });

  it("filters tools based on allowedEffects", () => {
    const readTool = defineTool({
      name: "tool.read",
      version: 1,
      description: "Read tool",
      effect: "read-index",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
    });

    const writeTool = defineTool({
      name: "tool.write",
      version: 1,
      description: "Write tool",
      effect: "local-write",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
    });

    // Default: only "read-index"
    const readOnly = adaptRegistryTools([readTool, writeTool], {
      threadId: "thread-ro",
      stepIndex: 1,
    });
    assert.equal(readOnly.length, 1);
    assert.equal(readOnly[0]?.name, "tool.read");

    // Explicitly allowed local-write
    const both = adaptRegistryTools([readTool, writeTool], {
      threadId: "thread-rw",
      stepIndex: 1,
      allowedEffects: ["read-index", "local-write"],
    });
    assert.equal(both.length, 2);
  });
});

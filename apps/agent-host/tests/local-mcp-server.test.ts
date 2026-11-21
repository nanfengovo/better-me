import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDemoFactBase } from "@better-me/core";
import { createLocalCareerMcpServer } from "../src/career-mcp/local-stdio-server.js";

function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first!.text!) as Record<string, unknown>;
}

test("BetterMe local MCP server redacts PII by default, withholds unconfirmed metrics, audits rewrites, and saves isolated drafts", async () => {
  const demo = createDemoFactBase();
  demo.profile.email = "private.candidate@example.invalid";
  demo.profile.phone = "13900001234";

  const draftsDir = await mkdtemp(path.join(os.tmpdir(), "betterme-mcp-drafts-"));
  const server = createLocalCareerMcpServer({
    draftsDir,
    loadFactBase: async () => demo,
    loadOpportunities: async () => [
      {
        id: "opp-1",
        company: "Northstar Systems",
        title: "Senior Full-Stack Engineer",
        market: "overseas",
        workMode: "remote",
        status: "open",
        salaryText: "$160k - $190k",
        sourceUrl: "https://example.invalid/jobs/1",
        description: "TypeScript, React, PostgreSQL, Kubernetes.",
        location: { country: "US", city: "Remote" },
        application: { stage: "evaluating", nextAction: "Review architecture portfolio" },
      },
    ],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "betterme-mcp-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    assert.ok(toolNames.includes("get_fact_base_summary"));
    assert.ok(toolNames.includes("list_verified_claims"));
    assert.ok(toolNames.includes("list_opportunities"));
    assert.ok(toolNames.includes("check_rewrite_grounding"));
    assert.ok(toolNames.includes("score_resume_against_jd"));
    assert.ok(toolNames.includes("save_tailored_draft"));

    // 1. FactBase summary redacts email/phone/name by default
    const summaryRes = await client.callTool({ name: "get_fact_base_summary", arguments: { locale: "zh" } });
    const summaryText = JSON.stringify(summaryRes);
    assert.equal(summaryText.includes("private.candidate@example.invalid"), false);
    assert.equal(summaryText.includes("13900001234"), false);
    const summary = parseToolJson(summaryRes);
    assert.equal((summary.profile as Record<string, unknown>).displayName, "[redacted]");

    // 2. list_verified_claims withholds unconfirmed metric numbers
    const claimsRes = await client.callTool({ name: "list_verified_claims", arguments: { locale: "zh" } });
    const claimsPayload = parseToolJson(claimsRes);
    const claims = claimsPayload.claims as Array<{ metric?: { confirmed: boolean; value?: number } }>;
    assert.ok(claims.length > 0);
    for (const claim of claims) {
      if (claim.metric && !claim.metric.confirmed) {
        assert.equal(claim.metric.value, undefined);
      }
    }

    // 3. list_opportunities filters cleanly
    const oppsRes = await client.callTool({ name: "list_opportunities", arguments: { market: "overseas" } });
    const opps = parseToolJson(oppsRes);
    assert.equal(opps.total, 1);

    // 4. check_rewrite_grounding flags fabricated numbers
    const guardRes = await client.callTool({
      name: "check_rewrite_grounding",
      arguments: {
        sourceText: "优化查询性能并降低接口延迟。",
        candidateText: "优化查询性能，将接口延迟降低 75% 并支撑 10万 QPS。",
      },
    });
    const guard = parseToolJson(guardRes);
    assert.equal(guard.ok, false);
    assert.ok((guard.novelNumbers as string[]).includes("75%"));
    assert.ok((guard.novelNumbers as string[]).includes("10万"));

    // 5. score_resume_against_jd runs deterministic alignment
    const jdRes = await client.callTool({
      name: "score_resume_against_jd",
      arguments: {
        title: "Senior Full-Stack Engineer",
        company: "Northstar Systems",
        jdText: "Requirements: TypeScript, React, PostgreSQL, Kubernetes production clusters, distributed tracing.",
      },
    });
    assert.equal(jdRes.isError, undefined);
    const jdPayload = parseToolJson(jdRes);
    assert.ok(jdPayload.alignment);

    // 6. save_tailored_draft writes isolated draft JSON with grounding audit
    const draftRes = await client.callTool({
      name: "save_tailored_draft",
      arguments: {
        targetCompany: "Northstar Systems",
        targetRole: "Senior Full-Stack Engineer",
        bullets: [
          {
            sourceText: "重构核心调度接口，耗时从 400ms 降至 120ms。",
            proposedText: "重构调度核心链路，将接口平均响应耗时由 400ms 优化至 120ms。",
          },
          {
            sourceText: "负责前端组件库维护。",
            proposedText: "主导前端组件库重构，开发效率提升 300%。",
          },
        ],
        gaps: ["Kubernetes production ops"],
      },
    });
    const draftPayload = parseToolJson(draftRes);
    assert.equal(draftPayload.saved, true);
    assert.equal(draftPayload.allGrounded, false);
    assert.equal(draftPayload.flaggedBulletCount, 1);

    const files = await readdir(draftsDir);
    assert.equal(files.length, 1);
    const savedRaw = JSON.parse(await readFile(path.join(draftsDir, files[0]!), "utf8")) as {
      status: string;
      factPreservation: { flaggedBulletCount: number };
    };
    assert.equal(savedRaw.status, "pending_human_review");
    assert.equal(savedRaw.factPreservation.flaggedBulletCount, 1);

    // 7. Resources work cleanly
    const resources = await client.listResources();
    assert.ok(resources.resources.some((r) => r.uri === "betterme://factbase/summary"));
    const factResource = await client.readResource({ uri: "betterme://factbase/summary" });
    assert.ok(factResource.contents[0]);
  } finally {
    await client.close();
    await server.close();
    await rm(draftsDir, { recursive: true, force: true });
  }
});

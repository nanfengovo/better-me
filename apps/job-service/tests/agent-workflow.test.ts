import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineTool,
  toLangChainTool,
  toLangChainRegistryTools,
  StateGraph,
  START,
  END,
  createJobAuditWorkflow,
  stripAddressDecorations,
  type JobAuditState,
} from "@better-me/opportunities";
import { z } from "zod";
import { openJobRepository } from "../src/repository.js";
import { createJobApplication } from "../src/application.js";
import { projectSourcePage } from "../src/projection.js";
import { normalizeAddressKey, createAmapOfficeProvider } from "../src/office-address-provider.js";
import type { SourceDefinition } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import type { OfficeAddressProvider } from "../src/office-address.js";

const testSourceDef: SourceDefinition = {
  sourceId: "src-agent-test",
  name: "Agent Test Source",
  adapterId: "custom",
  adapterVersion: "1",
  capabilities: ["list-jobs"],
  runtime: ["local-service"],
  entityType: "job-posting",
  enabled: true,
  status: "active",
  entryUrl: "https://example.com",
  remoteFilters: [],
  endpointPolicy: { allowedHosts: ["example.com"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Example", homepageUrl: "https://example.com", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 },
};

describe("LangChain & LangGraph Thin Adapter for Job Audit Agent", () => {
  it("toLangChainTool adapts native ToolDefinition to LangChain tool with schema and OpenAI function format", async () => {
    const inputSchema = z.object({
      query: z.string(),
      limit: z.number().optional(),
    });
    const outputSchema = z.object({
      count: z.number(),
      items: z.array(z.string()),
    });

    const nativeTool = defineTool({
      name: "test.echo",
      version: 1,
      description: "Echo test items",
      effect: "read-index",
      inputSchema,
      outputSchema,
      execute: (input) => ({
        count: 1,
        items: [input.query.toUpperCase()],
      }),
    });

    const lcTool = toLangChainTool(nativeTool);

    assert.equal(lcTool.name, "test.echo");
    assert.equal(lcTool.description, "Echo test items");
    assert.ok(lcTool.schema instanceof z.ZodType);

    // Test call & invoke
    const res1 = await lcTool.invoke({ query: "agent-test" });
    assert.deepEqual(res1, { count: 1, items: ["AGENT-TEST"] });

    const res2 = await lcTool.call({ query: "call-test" });
    assert.deepEqual(res2, { count: 1, items: ["CALL-TEST"] });

    // Test OpenAI function serialization
    const openAiDef = lcTool.asOpenAiFunction();
    assert.equal(openAiDef.name, "test.echo");
    assert.equal(openAiDef.description, "Echo test items");
    assert.equal((openAiDef.parameters as any).type, "object");
    assert.ok((openAiDef.parameters as any).properties.query);
  });

  it("StateGraph executes nodes, handles conditional routing, and supports streaming", async () => {
    interface CounterState {
      count: number;
      history: string[];
    }

    const graph = new StateGraph<CounterState>();
    graph.addNode("increment", (state) => ({
      count: state.count + 1,
      history: [...state.history, `increment to ${state.count + 1}`],
    }));
    graph.addNode("double", (state) => ({
      count: state.count * 2,
      history: [...state.history, `doubled to ${state.count * 2}`],
    }));
    graph.addNode("finish", (state) => ({
      history: [...state.history, `finished at ${state.count}`],
    }));

    graph.addEdge(START, "increment");
    graph.addConditionalEdges("increment", (state) => {
      if (state.count < 3) return "double";
      return "finish";
    });
    graph.addEdge("double", "finish");
    graph.addEdge("finish", END);

    const compiled = graph.compile();

    // Stream test
    const events: string[] = [];
    for await (const event of compiled.stream({ count: 1, history: [] })) {
      events.push(event.node);
    }
    assert.deepEqual(events, ["increment", "double", "finish"]);

    // Invoke test
    const finalState = await compiled.invoke({ count: 1, history: [] });
    assert.equal(finalState.count, 4); // 1 + 1 = 2; doubled = 4; finished
    assert.equal(finalState.history.length, 3);
  });

  it("createJobAuditWorkflow orchestrates end-to-end location, salary, and controller audit", async () => {
    const repo = openJobRepository(":memory:");

    // Mock office geocoder returning valid building candidate for "博云路2号"
    const mockOfficeProvider: OfficeAddressProvider = {
      providerId: "amap-mock",
      search: async () => [{
        id: "cand-01",
        providerId: "amap-mock",
        proposal: {
          basis: "manual-user-confirmation",
          countryCode: "CN",
          formattedAddress: "上海市浦东新区张江高科技园区博云路2号",
          streetAddress: "博云路2号",
          coordinates: { longitude: 121.6033, latitude: 31.2001, coordinateSystem: "WGS84" },
          evidenceUrl: "https://restapi.amap.com/v3/geocode/geo",
          coordinateMeaning: "building",
        },
        attribution: "高德地图",
        evidenceUrl: "https://restapi.amap.com/v3/geocode/geo",
        estimated: true,
        verification: "unverified",
      }],
    };

    const app = createJobApplication({
      repository: repo,
      officeAddressProvider: mockOfficeProvider,
    });

    try {
      // Ingest test job with unverified location and salary
      const record: SourceJobRecord = {
        entityType: "job-posting",
        sourceRecordId: "job-agent-01",
        url: "https://example.com/job/01",
        title: "高级 C# / .NET 分布式架构师",
        companyName: "张江科技发展创新有限公司",
        description: "负责高性能分布式系统核心研发与微服务架构治理",
        locations: [{
          raw: "上海市浦东新区博云路2号",
          countryCode: "CN",
          city: "上海市",
          streetAddress: "博云路2号",
        }],
        compensations: [{
          raw: "30k-45k · 15薪",
          currency: "CNY",
          period: "month",
          min: 30000,
          max: 45000,
          monthsPerYear: 15,
          kind: "base",
          tax: "gross",
        }],
        workMode: "on-site",
        employmentType: "unknown",
        remoteEligibleRegions: [],
        availability: "unknown",
        completeness: "detail",
        evidence: [],
        warnings: [],
      };

      const before = await repo.readProjectionSnapshot();
      const proj = await projectSourcePage(before, testSourceDef, {
        records: [record],
        observedAt: new Date().toISOString(),
        coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] },
        warnings: [],
      }, "test-run");

      await repo.importSnapshot(proj.delta, {
        actorScope: "owner",
        idempotencyKey: "test-import-01",
        expectedRevision: before.revision,
      });

      const snapshotAfterImport = await repo.readSnapshot();
      const importedJob = snapshotAfterImport.jobs.find((j) => j.title.value.includes(".NET"));
      assert.ok(importedJob, "Job must be imported into repository");

      // Wrap app registry tools with LangChain adapter
      const tools = toLangChainRegistryTools(app.registry);
      assert.ok(tools.has("jobs.read-detail"));
      assert.ok(tools.has("locations.confirm-office-address"));
      assert.ok(tools.has("compensations.confirm-audit"));
      assert.ok(tools.has("companies.confirm-controller-override"));

      // Assemble LangGraph workflow
      const workflow = createJobAuditWorkflow(tools);

      // Execute Workflow
      const finalState = await workflow.invoke({
        jobId: importedJob.id,
        trace: [],
        errors: [],
      });

      if (finalState.errors.length > 0) {
        console.error("Workflow errors:", finalState.errors, finalState.officeAudit);
      }

      // Verify outcomes:
      // 1. Office Location Confirmed
      assert.equal(finalState.officeAudit?.status, "confirmed");
      assert.equal(finalState.officeAudit?.displayGrade, "building");
      assert.ok(finalState.officeAudit?.coordinates);
      assert.equal(finalState.officeAudit.coordinates?.longitude, 121.6033);

      // 2. Compensation Audited & Normalized
      assert.equal(finalState.compensationAudit?.status, "verified");
      assert.equal(finalState.compensationAudit?.currency, "CNY");
      assert.equal(finalState.compensationAudit?.annualMin, 30000 * 15); // 450,000
      assert.equal(finalState.compensationAudit?.annualMax, 45000 * 15); // 675,000
      assert.ok(finalState.compensationAudit?.receiptId);

      // 3. Controller Verified
      assert.equal(finalState.controllerAudit?.status, "confirmed");
      assert.equal(finalState.controllerAudit?.classification, "private-domestic");
      assert.ok(finalState.controllerAudit?.receiptId);

      // 4. Final Report Synthesized
      assert.equal(finalState.finalReport?.overallGrade, "verified-complete");
      assert.ok(finalState.finalReport?.salarySummary.includes("45.0万 - 67.5万 CNY/年"));
      assert.ok(finalState.finalReport?.locationSummary.includes("已核实办公楼"));
      assert.ok(finalState.finalReport?.controllerSummary.includes("民营企业（国内实控）"));

      // 5. Verify repository state was persisted with building displayGrade and verified salary
      const finalSnapshot = await repo.readSnapshot();
      const updatedJob = finalSnapshot.jobs.find((j) => j.id === importedJob.id)!;
      const updatedLoc = finalSnapshot.locations.find((l) => l.id === updatedJob.locationIds[0])!;
      assert.ok(updatedLoc.officeResolution, "Office resolution must be persisted in repository");
      assert.equal(updatedLoc.coordinates?.longitude, 121.6033);

      const updatedComp = finalSnapshot.compensations.find((c) => c.id === updatedJob.compensationIds[0])!;
      assert.equal(updatedComp.verification, "verified", "Compensation must be verified in repository");
    } finally {
      await app.shutdown();
      repo.close();
    }
  });

  it("createJobAuditWorkflow gracefully skips missing location or salary and outputs unverified grade", async () => {
    const repo = openJobRepository(":memory:");
    const app = createJobApplication({ repository: repo });

    try {
      // Ingest bare job with no locations and no compensations
      const bareRecord: SourceJobRecord = {
        entityType: "job-posting",
        sourceRecordId: "job-agent-bare",
        url: "https://example.com/job/bare",
        title: "初级软件工程师（远程兼职）",
        companyName: "虚拟实验网络",
        description: "纯远程测试岗位，无办公室与固定月薪披露",
        locations: [],
        compensations: [],
        workMode: "remote",
        employmentType: "unknown",
        remoteEligibleRegions: [],
        availability: "unknown",
        completeness: "detail",
        evidence: [],
        warnings: [],
      };

      const before = await repo.readProjectionSnapshot();
      const proj = await projectSourcePage(before, testSourceDef, {
        records: [bareRecord],
        observedAt: new Date().toISOString(),
        coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] },
        warnings: [],
      }, "test-bare-run");

      await repo.importSnapshot(proj.delta, {
        actorScope: "owner",
        idempotencyKey: "test-import-bare",
        expectedRevision: before.revision,
      });

      const snapshotAfterImport = await repo.readSnapshot();
      const importedJob = snapshotAfterImport.jobs.find((j) => j.title.value.includes("初级软件工程师"))!;
      assert.ok(importedJob);

      const tools = toLangChainRegistryTools(app.registry);
      const workflow = createJobAuditWorkflow(tools);

      const finalState = await workflow.invoke({
        jobId: importedJob.id,
        trace: [],
        errors: [],
      });

      // Assertions
      assert.equal(finalState.officeAudit?.status, "skipped");
      assert.equal(finalState.compensationAudit?.status, "skipped");
      assert.equal(finalState.finalReport?.overallGrade, "verified-partial"); // controller verified or partial
      assert.equal(finalState.errors.length, 0);
      assert.ok(finalState.finalReport?.salarySummary.includes("未核实薪资"));
      assert.ok(finalState.finalReport?.locationSummary.includes("未确认办公楼"));
    } finally {
      await app.shutdown();
      repo.close();
    }
  });

  it("normalizeAddressKey normalizes address strings and strips park/floor decorations", () => {
    assert.equal(
      normalizeAddressKey("上海市", "浦东新区科苑路399号张江创新园A座301室"),
      "上海市:科苑路_399号"
    );
    assert.equal(
      normalizeAddressKey("北京市", "海淀区东北旺西路8号中关村软件园二期（9号楼）"),
      "北京市:东北旺西路_8号"
    );
    assert.equal(
      normalizeAddressKey("杭州市", "余杭区文一西路969号阿里巴巴西溪园区"),
      "杭州市:文一西路_969号"
    );
    assert.equal(
      stripAddressDecorations("浦东新区科苑路399号张江创新园A座301室"),
      "浦东新区科苑路399号"
    );
  });

  it("persistent geo dictionary caches confirmed buildings and reuses them across address variants without transport calls", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "geo-cache-test-"));
    let transportCalls = 0;

    const mockTransport = {
      request: async (req: any) => {
        transportCalls++;
        return {
          status: 200,
          url: req.url,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            status: "1",
            info: "OK",
            count: "1",
            geocodes: [{
              formatted_address: "上海市浦东新区科苑路399号",
              country: "中国",
              province: "上海市",
              city: "上海市",
              district: "浦东新区",
              street: "科苑路",
              number: "399号",
              location: "121.594567,31.206789",
              level: "门牌号",
            }],
          }),
        };
      },
    };

    try {
      const provider = createAmapOfficeProvider(mockTransport as any, {
        key: "test-amap-key",
        dataDirectory: tempDir,
      });

      const dummyLocation = {
        id: "loc-test-1",
        kind: "office" as const,
        countryCode: "CN",
        coordinates: undefined,
      };

      const dummyContext: any = {
        throwIfCancelled: () => {},
      };

      // 1. First call: hits transport
      const cand1 = await provider.search({
        query: "科苑路399号",
        locality: "上海市",
        location: dummyLocation as any,
      }, dummyContext);

      assert.equal(cand1.length, 1);
      assert.equal(transportCalls, 1);
      assert.ok(existsSync(join(tempDir, "geo-address-cache.json")), "Cache file must be persisted");

      // 2. Second call with variant address (including park & room number):
      // Should normalize to same key and hit persistent cache with ZERO transport calls!
      const cand2 = await provider.search({
        query: "科苑路399号张江创新园A座301室",
        locality: "上海市",
        location: dummyLocation as any,
      }, dummyContext);

      assert.equal(cand2.length, 1);
      assert.equal(transportCalls, 1, "Must hit persistent geo cache without invoking transport");
      assert.equal(cand2[0].proposal.coordinates.longitude, cand1[0].proposal.coordinates.longitude);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("JobAuditWorkflow respects autonomyMode=read-only by leaving audit in pending-review and requiring human review", async () => {
    const repo = openJobRepository(":memory:");
    const mockOfficeProvider: OfficeAddressProvider = {
      providerId: "amap",
      search: async () => [
        {
          id: "cand-ro-1",
          providerId: "amap",
          proposal: {
            basis: "manual-user-confirmation",
            countryCode: "CN",
            formattedAddress: "上海市浦东新区张江高科技园区博云路2号浦软大厦",
            streetAddress: "博云路2号",
            coordinates: { longitude: 121.6033, latitude: 31.2052, coordinateSystem: "WGS84" as const },
            evidenceUrl: "https://lbs.amap.com/api",
            coordinateMeaning: "building",
          },
          attribution: "高德",
          evidenceUrl: "https://lbs.amap.com/api",
          estimated: true,
          verification: "unverified",
        },
      ],
    };

    const app = createJobApplication({ repository: repo, officeAddressProvider: mockOfficeProvider });

    try {
      const record: SourceJobRecord = {
        entityType: "job-posting",
        sourceRecordId: "job-ro-test",
        url: "https://example.com/job/ro",
        title: "C# 软件工程师（只读模式测试）",
        companyName: "测试科技有限公司",
        description: "测试只读模式",
        locations: [{
          raw: "上海市浦东新区博云路2号",
          countryCode: "CN",
          region: "上海市",
          city: "上海市",
          streetAddress: "博云路2号",
        }],
        compensations: [{
          raw: "30k-45k · 15薪",
          currency: "CNY",
          period: "month",
          min: 30000,
          max: 45000,
          monthsPerYear: 15,
          kind: "base",
          tax: "gross",
        }],
        workMode: "on-site",
        employmentType: "unknown",
        remoteEligibleRegions: [],
        availability: "unknown",
        completeness: "detail",
        evidence: [],
        warnings: [],
      };

      const before = await repo.readProjectionSnapshot();
      const proj = await projectSourcePage(before, testSourceDef, {
        records: [record],
        observedAt: new Date().toISOString(),
        coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] },
        warnings: [],
      }, "test-ro-run");

      await repo.importSnapshot(proj.delta, {
        actorScope: "owner",
        idempotencyKey: "test-import-ro",
        expectedRevision: before.revision,
      });

      const snapshotAfterImport = await repo.readSnapshot();
      const importedJob = snapshotAfterImport.jobs.find((j) => j.id === "job-ro-test") || snapshotAfterImport.jobs[0]!;

      const tools = toLangChainRegistryTools(app.registry);
      const workflow = createJobAuditWorkflow(tools);

      // Run in read-only autonomy mode
      const finalState = await workflow.invoke({
        jobId: importedJob.id,
        autonomyMode: "read-only",
        trace: [],
        errors: [],
      });

      // Office audit should be pending-review, not confirmed
      assert.equal(finalState.officeAudit?.status, "pending-review");
      assert.equal(finalState.officeAudit?.requiresHumanReview, true);
      assert.ok(finalState.officeAudit?.previewFingerprint);
      assert.equal(finalState.officeAudit?.receiptId, undefined);

      // Compensation audit should be pending-review
      assert.equal(finalState.compensationAudit?.status, "pending-review");
      assert.equal(finalState.compensationAudit?.requiresHumanReview, true);

      // Final report should flag requiresHumanReview
      assert.equal(finalState.finalReport?.requiresHumanReview, true);
      assert.equal(finalState.finalReport?.pendingReviewsCount, 2);

      // Repository must NOT have officeResolution or verified compensation in read-only mode
      const finalSnapshot = await repo.readSnapshot();
      const loc = finalSnapshot.locations.find((l) => l.id === importedJob.locationIds[0])!;
      assert.equal(loc.officeResolution, undefined, "Office resolution must NOT be committed in read-only mode");
    } finally {
      await app.shutdown();
      repo.close();
    }
  });
});

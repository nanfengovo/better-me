import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type SourceDefinition,
  type CompanyControllerOverrideProposal,
  type CompensationAuditProposal,
  type TrustedToolContext,
  type CompensationAuditPreview,
} from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository, RepositoryError, type JobRepository } from "../src/repository.js";
import { projectSourcePage } from "../src/projection.js";

const AT = "2026-10-20T00:00:00.000Z";
const opts = (idempotencyKey: string, expectedRevision: number, actorScope = "owner") => ({
  actorScope,
  idempotencyKey,
  expectedRevision,
});
const code = (value: string) => (error: unknown) =>
  error instanceof RepositoryError && error.code === value;

const source: SourceDefinition = {
  sourceId: "corp-audit-source",
  name: "Synthetic corporate and comp source",
  adapterId: "synthetic",
  adapterVersion: "1",
  capabilities: ["list-jobs"],
  runtime: ["local-service"],
  entityType: "job-posting",
  enabled: true,
  status: "active",
  remoteFilters: [],
  endpointPolicy: {
    allowedHosts: ["careers.example.test"],
    allowedPathPrefixes: ["/"],
    requireHttps: true,
    allowRedirects: false,
    maxRedirects: 0,
  },
  attribution: { label: "Synthetic", usage: "metadata", requiresAttribution: true },
  refreshPolicy: {
    mode: "manual",
    minIntervalSeconds: 0,
    maxRecords: 10,
    maxPages: 1,
    requestsPerMinute: 30,
  },
};

function record(): SourceJobRecord {
  return {
    entityType: "job-posting",
    sourceRecordId: "job-audit-42",
    url: "https://careers.example.test/jobs/audit-42",
    title: "高级云原生开发专家",
    companyName: "示范科技有限公司",
    description: "负责大规模分布式系统架构，年薪制保障与股权激励。",
    locations: [{ raw: "上海市浦东新区张江高科", countryCode: "CN", city: "上海" }],
    compensations: [
      {
        raw: "人民币 30,000 - 45,000 元/月，14薪",
        currency: "CNY",
        period: "month",
        min: 30000,
        max: 45000,
        tax: "gross",
        kind: "base",
        monthsPerYear: 14,
      },
    ],
    workMode: "on-site",
    employmentType: "social",
    remoteEligibleRegions: [],
    availability: "unknown",
    completeness: "detail",
    evidence: [],
    warnings: [],
  };
}

async function ingest(repo: JobRepository, key = "seed") {
  const before = await repo.readProjectionSnapshot();
  const projection = await projectSourcePage(
    before,
    source,
    {
      records: [record()],
      observedAt: AT,
      coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] },
      warnings: [],
    },
    key,
  );
  return repo.importSnapshot(projection.delta, opts(key, before.revision));
}

async function fixture(work: (repo: JobRepository, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "better-me-audit-test-"));
  const path = join(dir, "jobs.sqlite");
  const repo = openJobRepository(path, { now: () => AT });
  try {
    await ingest(repo, "seed");
    await work(repo, path);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("company controller override preview is read-only and reflects state ownership classification", async () =>
  fixture(async (repo) => {
    const data = await repo.readSnapshot();
    const company = data.companies[0]!;
    const observation = data.observations[0]!;

    const proposal: CompanyControllerOverrideProposal = {
      controllers: [
        {
          name: "国务院国有资产监督管理委员会",
          jurisdictionCode: "CN",
          kind: "state",
        },
      ],
      evidence: [
        {
          observationId: observation.id,
          sourceUrl: "https://careers.example.test/jobs/audit-42",
          quote: "国有控股骨干企业",
          observedAt: AT,
        },
      ],
      reason: "国家企查查披露显示实际控制人为国务院国资委",
    };

    const preview = await repo.previewCompanyControllerOverride({
      companyId: company.id,
      expectedRevision: data.revision,
      proposal,
    });

    assert.equal(preview.companyId, company.id);
    assert.equal(preview.classification.status, "verified");
    assert.equal(preview.classification.ownership, "state");
    assert.equal(preview.proposedControllers.verification, "verified");
    assert.match(preview.colorMatch.color, /^#[0-9a-fA-F]{6}$/);

    // Read snapshot remains untouched
    const after = await repo.readSnapshot();
    assert.equal(after.revision, data.revision);
    assert.equal(after.companies[0]!.manualOverrides.length, 0);

    // Confirm override
    const receipt = await repo.confirmCompanyControllerOverride(
      {
        companyId: company.id,
        expectedRevision: data.revision,
        proposal,
        previewFingerprint: preview.previewFingerprint,
        reviewed: true,
      },
      opts("confirm-ctrl", data.revision),
    );

    assert.equal(receipt.ok, true);
    assert.equal(receipt.revision, data.revision + 1);
    assert.equal(receipt.classification.ownership, "state");

    const updated = await repo.readSnapshot();
    assert.equal(updated.revision, data.revision + 1);
    const updatedCompany = updated.companies.find((c) => c.id === company.id)!;
    assert.equal(updatedCompany.manualOverrides.length, 1);
    assert.equal(updatedCompany.manualOverrides[0]!.field, "ultimateControllers");

    // Idempotent retry returns same receipt
    const replayed = await repo.confirmCompanyControllerOverride(
      {
        companyId: company.id,
        expectedRevision: data.revision,
        proposal,
        previewFingerprint: preview.previewFingerprint,
        reviewed: true,
      },
      opts("confirm-ctrl", data.revision),
    );
    assert.deepEqual(replayed, receipt);

    // Revoke
    const revoked = await repo.revokeCompanyControllerOverride(
      {
        companyId: company.id,
        expectedRevision: updated.revision,
        decisionId: receipt.decisionId,
        reason: "误判国资委全资控股，予以撤回",
        reviewed: true,
      },
      opts("revoke-ctrl", updated.revision),
    );

    assert.equal(revoked.ok, true);
    assert.equal(revoked.revision, updated.revision + 1);
    const reverted = await repo.readSnapshot();
    assert.equal(reverted.companies[0]!.manualOverrides.length, 0);
  }));

test("compensation audit preview calculates normalized CNY annual salary and saves verified audit", async () =>
  fixture(async (repo) => {
    const data = await repo.readSnapshot();
    const job = data.jobs[0]!;
    const compId = job.compensationIds[0]!;
    const observation = data.observations[0]!;

    const proposal: CompensationAuditProposal = {
      currency: "CNY",
      period: "month",
      min: 30000,
      max: 45000,
      tax: "gross",
      kind: "base",
      monthsPerYear: 14,
      evidence: [
        {
          observationId: observation.id,
          sourceUrl: "https://careers.example.test/jobs/audit-42",
          quote: "人民币 30,000 - 45,000 元/月，14薪",
          observedAt: AT,
        },
      ],
      reason: "岗位详情注明14薪，核算税前年薪 42万-63万",
    };

    const preview = await repo.previewCompensationAudit({
      jobId: job.id,
      compensationId: compId,
      expectedRevision: data.revision,
      proposal,
    });

    assert.equal(preview.jobId, job.id);
    assert.equal(preview.compensationId, compId);
    assert.equal(preview.proposed.verification, "verified");
    assert.equal(preview.normalized.cnyAnnual?.min, 30000 * 14);
    assert.equal(preview.normalized.cnyAnnual?.max, 45000 * 14);
    assert.equal(preview.normalized.verification, "verified");
    assert.equal(preview.normalized.status, "comparable");

    // Snapshot unchanged
    assert.equal((await repo.readSnapshot()).revision, data.revision);

    // Confirm
    const receipt = await repo.confirmCompensationAudit(
      {
        jobId: job.id,
        compensationId: compId,
        expectedRevision: data.revision,
        proposal,
        previewFingerprint: preview.previewFingerprint,
        reviewed: true,
      },
      opts("confirm-comp", data.revision),
    );

    assert.equal(receipt.ok, true);
    assert.equal(receipt.revision, data.revision + 1);
    assert.equal(receipt.compensation.verification, "verified");
    assert.equal(receipt.normalized.cnyAnnual?.min, 420000);
    assert.equal(receipt.normalized.cnyAnnual?.max, 630000);

    const updated = await repo.readSnapshot();
    const updatedComp = updated.compensations.find((c) => c.id === compId)!;
    assert.equal(updatedComp.verification, "verified");
    assert.equal(updatedComp.monthsPerYear, 14);

    // Revoke
    const revoked = await repo.revokeCompensationAudit(
      {
        jobId: job.id,
        compensationId: compId,
        expectedRevision: updated.revision,
        decisionId: receipt.decisionId,
        reason: "重新核实无固定14薪",
        reviewed: true,
      },
      opts("revoke-comp", updated.revision),
    );

    assert.equal(revoked.ok, true);
    assert.equal(revoked.compensation.verification, "unverified");
    assert.equal(revoked.compensation.evidence.length, 0);
  }));

test("application registry exposes compensation and company controller tools", async () =>
  fixture(async (repo) => {
    const app = await createJobApplication({ repository: repo, now: () => AT });
    try {
      const data = await repo.readSnapshot();
      const job = data.jobs[0]!;
      const compId = job.compensationIds[0]!;
      const observation = data.observations[0]!;

      // Execute preview via tool registry
      const preview = await app.registry.execute(
        "compensations.preview-audit",
        {
          jobId: job.id,
          compensationId: compId,
          expectedRevision: data.revision,
          proposal: {
            currency: "CNY",
            period: "month",
            min: 30000,
            max: 45000,
            tax: "gross",
            kind: "base",
            monthsPerYear: 14,
            evidence: [
              {
                observationId: observation.id,
                sourceUrl: "https://careers.example.test/jobs/audit-42",
                quote: "人民币 30,000 - 45,000 元/月，14薪",
                observedAt: AT,
              },
            ],
            reason: "核算年化",
          },
        },
        {
          requestId: "test-request-preview",
          actorScope: "tester",
          idempotencyKey: "test-preview",
          budget: { requests: 10, bytes: 500_000, timeoutMs: 5000 },
          allowedEffects: ["read-index", "local-write"],
          signal: new AbortController().signal,
        },
      );

      assert.equal(preview.ok, true);
      if (!preview.ok) throw new Error("Expected ok result");
      assert.equal(preview.value.jobId, job.id);
      assert.equal(preview.value.normalized.cnyAnnual?.min, 420000);
    } finally {
      await app.shutdown();
    }
  }));

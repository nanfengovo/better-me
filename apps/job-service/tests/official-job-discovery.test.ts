import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry, type TrustedToolContext, type ToolResult } from "@better-me/opportunities";
import type { OfficialJobDiscoveryResult } from "@better-me/source-adapters";
import { createOfficialJobDiscoveryTools } from "../src/official-job-discovery.ts";
import { openJobRepository } from "../src/repository.ts";
import type { ImportReceipt } from "../src/repository-schema.ts";

function context(key?: string, actorScope = "local-owner"): TrustedToolContext {
  return { requestId: "job-discovery", actorScope, allowedEffects: ["external-read", "read-index", "local-write"],
    signal: new AbortController().signal, budget: { requests: 8, bytes: 1_000_000, timeoutMs: 5000 }, ...(key ? { idempotencyKey: key } : {}) };
}
function success<T>(result: ToolResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("a continuation expands the same criteria and cannot be attached to another actor or modified resume", async () => {
  const observedAt = "2026-11-21T05:00:00Z";
  const repo = openJobRepository(":memory:", { now: () => observedAt });
  const transport: SourceTransport = { async request() { throw new Error("No public result in this fixture."); } };
  const queries: string[] = [];
  const app = createToolRegistry([...createOfficialJobDiscoveryTools({
    repository: repo, now: () => observedAt, transport, detailTransport: transport,
    searchProvider: { async search(input) { queries.push(input.query); return { results: [], partial: false }; } },
  }, async () => ({ observedAt, status: "partial", candidates: [], queries: [], warnings: [] }))]);
  try {
    const input = { role: "Software Engineer", skills: ["C#"] };
    const first = success(await app.execute<OfficialJobDiscoveryResult>("jobs.discover-official", input, context()));
    assert.equal(first.discovery?.round, 0);
    const next = { ...input, continueDiscovery: first.discovery!.sessionId };
    const foreign = await app.execute("jobs.discover-official", next, context(undefined, "other-owner"));
    const modified = await app.execute("jobs.discover-official", { ...next, skills: ["Java"] }, context());
    assert.ok(!foreign.ok && foreign.error.code === "stale-version");
    assert.ok(!modified.ok && modified.error.code === "stale-version");
    const second = success(await app.execute<OfficialJobDiscoveryResult>("jobs.discover-official", next, context()));
    const third = success(await app.execute<OfficialJobDiscoveryResult>("jobs.discover-official", next, context()));
    assert.equal(second.discovery?.sessionId, first.discovery?.sessionId);
    assert.equal(third.discovery?.round, 2);
    assert.notEqual(queries[0], queries[1]);
    const snapshot = await repo.readSnapshot();
    assert.equal(snapshot.jobs.length, 0);
    assert.equal(snapshot.sources.length, 0);
  } finally { repo.close(); }
});

test("role-led discovery accepts no client-supplied posting, keeps evidence separate, and reuses job and receipt", async () => {
  let observedAt = "2026-11-21T05:00:00.000Z";
  const url = "https://jobs.lever.co/example/employer-job-1";
  const job = { url, title: "Backend Engineer", company: "Example", description: "C# platform development with no travel.", location: "Shanghai",
    verification: "official-detail" as const, verificationEvidence: "Employer posting API", availability: "unknown" as const,
    matchedSkills: ["C#"], travel: "not-required" as const, travelEvidence: "no travel" };
  const repo = openJobRepository(":memory:", { now: () => observedAt });
  const noNetwork = { request: async () => { throw new Error("Unexpected network request"); } };
  const application = () => createToolRegistry([...createOfficialJobDiscoveryTools({ repository: repo, now: () => observedAt,
    transport: noNetwork, detailTransport: noNetwork }, async () => ({
    observedAt, status: "partial", queries: ["C# Shanghai"], candidates: [job,
      { url: "https://example.org/careers", title: "Careers", verification: "unverified-lead", matchedSkills: [], travel: "unknown", availability: "unknown" }],
    warnings: [],
  }))]);
  const query = { role: "Backend Engineer", skills: ["C#"] };
  try {
    const app = application();
    const results = success(await app.execute<OfficialJobDiscoveryResult>("jobs.discover-official", query, context()));
    const candidateId = results.candidates[0]!.candidateId;
    assert.ok(candidateId); assert.equal(results.candidates[1]!.candidateId, undefined);
    assert.equal((await repo.readSnapshot()).revision, 0);
    const command = { candidateId };
    assert.equal((await app.execute("jobs.import-discovered-official", { ...command, company: "Injected" }, context("bad"))).ok, false);
    assert.equal((await app.execute("jobs.import-discovered-official", command, context("bad-owner", "another-owner"))).ok, false);
    const receipt = success(await app.execute<ImportReceipt>("jobs.import-discovered-official", command, context("first")));
    assert.equal(receipt.counts.newJobs, 1);
    const saved = await repo.readSnapshot();
    assert.equal(saved.jobs.length, 1);
    assert.equal(saved.snapshots[0]?.text, job.description);
    assert.equal(saved.listings[0]?.canonicalUrl, url);
    assert.equal(saved.listings[0]?.sourceId, "official-job-discovery");
    assert.equal(saved.jobs[0]?.status, "unknown");
    assert.equal(saved.locations[0]?.kind, "unknown");
    assert.equal(saved.companies[0]?.ultimateControllers.verification, "unknown");
    assert.deepEqual(saved.sources[0]?.capabilities, []);
    const next = success(await app.execute<OfficialJobDiscoveryResult>("jobs.discover-official", query, context()));
    const duplicate = success(await app.execute<ImportReceipt>("jobs.import-discovered-official", { candidateId: next.candidates[0]!.candidateId }, context("second")));
    assert.equal(duplicate.counts.newJobs, 0);
    assert.deepEqual(duplicate.jobIds, receipt.jobIds);
    assert.equal((await repo.readSnapshot()).observations.length, 1);
    observedAt = "2026-11-21T06:00:00.000Z";
    const expired = await app.execute("jobs.import-discovered-official", command, context("expired"));
    assert.ok(!expired.ok && expired.error.code === "stale-version");
    const restarted = application();
    assert.deepEqual(success(await restarted.execute("jobs.import-discovered-official", command, context("first"))), receipt);
    const conflict = await restarted.execute("jobs.import-discovered-official", { candidateId: next.candidates[0]!.candidateId }, context("first"));
    assert.ok(!conflict.ok);
  } finally { repo.close(); }
});

import { createJobApplication } from "../src/application.ts";
import { createJobHttpServer } from "../src/http.ts";
import type { SourceTransport } from "@better-me/source-adapters";

for (const order of ["job-first", "source-first", "concurrent"] as const) {
  test("cross-company Workable discovery and board refresh keep one canonical job: " + order, async () => {
    const company = { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", title: "Example Labs", url: "https://jobs.workable.com/company/example/example-labs" };
    const org = { ...company, workableUid: company.id, website: "https://example.org/" };
    const id = "170614f6-a1e6-4701-9d7d-489486d1b763";
    const row = { id, company, title: "Software Engineer", state: "published", description: "<p>C# and .NET, with React.</p>", requirementsSection: "No travel required.",
      url: "https://jobs.workable.com/view/unique-id/software-engineer", linkoutUrl: null, location: { city: "Shanghai", countryName: "China" } };
    const agency = { ...row, id: "170614f6-a1e6-4701-9d7d-489486d1b764", company: { ...company, title: "Example Recruitment" }, url: "https://jobs.workable.com/view/agency/other" };
    const outside = { ...row, id: "170614f6-a1e6-4701-9d7d-489486d1b765", location: { city: "Berlin", countryName: "Germany" } };
    const transport: SourceTransport = { request: async ({ url }) => {
      const target = new URL(url);
      assert.equal(target.hostname, "jobs.workable.com");
      const headers = { "content-type": "application/json" };
      if (target.pathname === "/api/v1/jobs") {
        assert.equal(target.searchParams.get("location"), "Shanghai, China");
        return { url, status: 200, headers, text: JSON.stringify({ totalSize: 3, jobs: [row, agency, outside] }) };
      }
      if (target.pathname === "/api/v1/jobs/" + id || target.pathname === "/api/v1/jobs/" + agency.id)
        return { url, status: 200, headers, text: JSON.stringify(target.pathname.endsWith(agency.id) ? agency : row) };
      if (target.pathname === "/api/v1/companies/" + company.id)
        return { url, status: 200, headers, text: JSON.stringify({ ...org, totalSize: 1, jobs: [row] }) };
      throw new Error("unexpected external request");
    } };
    const repo = openJobRepository(":memory:");
    const app = createJobApplication({ repository: repo, transport, officialJobDetailTransport: transport, backgroundEnrichment: false,
      careerWebSearchProvider: { search: async () => ({ results: [], partial: false }) } });
    const http = createJobHttpServer({ token: "synthetic-discovery-service-token", allowedOrigins: [], registry: app.registry, port: 0 });
    const address = await http.listen();
    async function post<Output>(path: string, body: object, key?: string): Promise<Output> {
      const res = await fetch(address.url + "/api/v1/" + path, { method: "POST", headers: {
        authorization: "Bearer synthetic-discovery-service-token", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}),
      }, body: JSON.stringify(body) });
      return success(await res.json() as ToolResult<Output>);
    }
    try {
      const discovered = await post<OfficialJobDiscoveryResult>("jobs/discover-official", { role: "软件工程师", skills: ["C#", ".NET"], region: "上海" });
      assert.equal(discovered.candidates.length, 2);
      const found = discovered.candidates.find(job => job.candidateId)!;
      assert.equal(found.company, company.title); assert.equal(found.companyWebsite, org.website); assert.equal(found.travel, "not-required");
      assert.equal(found.detailEvidenceUrl, "https://jobs.workable.com/api/v1/jobs/" + id);
      assert.ok(found.sourceProposal); assert.equal(found.sourceProposal.enabled, false);
      const lead = discovered.candidates.find(job => job.verification === "unverified-lead");
      assert.equal(lead?.company, agency.company.title); assert.equal(lead?.sourceProposal, undefined);
      assert.equal((await repo.readSnapshot()).sources.length, 0);
      const save = () => post<ImportReceipt>("jobs/discover-official/import", { candidateId: found.candidateId }, "one-job");
      if (order === "job-first") { await save(); assert.deepEqual((await repo.readSnapshot()).sources.map(s => s.enabled), [false]); }
      const source = { ...found.sourceProposal, enabled: true, status: "active" as const };
      await repo.registerSource(source, { actorScope: "local-owner", idempotencyKey: "one-board" });
      const sync = () => post<{ run: { status: string } }>("sources/" + source.sourceId + "/sync", { maxPages: 1 }, "refresh");
      if (order === "concurrent") {
        const [, refreshed] = await Promise.all([save(), sync()]);
        assert.ok(["succeeded", "complete", "completed", "partial"].includes(refreshed.run.status), refreshed.run.status);
      } else {
        await sync();
        if (order === "source-first") await save();
      }
      const saved = await repo.readSnapshot();
      assert.equal(saved.jobs.length, 1);
      assert.ok(saved.listings.some(listing => listing.sourceId === source.sourceId), JSON.stringify(saved.listings));
      assert.equal(saved.jobs[0]?.listingIds.length, saved.listings.length);
      assert.ok(saved.listings.every(listing => listing.canonicalJobId === saved.jobs[0]?.id));
      assert.equal(saved.jobs[0]?.description, "C# and .NET, with React.\n\nNo travel required.");
    } finally { await http.close(); await app.shutdown(); repo.close(); }
  });
}

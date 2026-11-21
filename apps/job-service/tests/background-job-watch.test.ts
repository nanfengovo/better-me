import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRegistry, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { assessJobWatchMatch, type JobWatchConfig, type JobWatchStatus, type OfficialJobDiscoveryCandidate } from "@better-me/source-adapters";
import { createBackgroundJobWatch } from "../src/background-job-watch.ts";
import { openJobRepository } from "../src/repository.ts";

const config: JobWatchConfig = { intervalMinutes: 30, criteria: { role: "软件工程师", skills: ["C#"], secondarySkills: ["Python", "React"],
  region: "中国", preferForeignEmployer: true, preferLowTravel: true } };
const base: OfficialJobDiscoveryCandidate = {
  url: "https://careers.example.org/job/software", jobId: "req1", title: "Software Engineer", company: "Example",
  description: "Requirements:\n3+ years of professional experience in C# and .NET.\nNo travel required.",
  location: "Shanghai, China", verification: "official-detail", verificationEvidence: "Employer career site", matchedSkills: ["C#"],
  travel: "not-required", travelEvidence: "No travel required.", employerNature: "foreign-disclosed",
  employerNatureEvidence: "We are a German company.", availability: "open",
};
const other = (changes: Partial<OfficialJobDiscoveryCandidate>): OfficialJobDiscoveryCandidate => ({ ...base, ...changes });
const sample = (job: OfficialJobDiscoveryCandidate) => assessJobWatchMatch(job, config.criteria);
test("requires official open postings, real primary-skill requirements and employer evidence before alerting", () => {
  assert.equal(sample(base)?.tier, "priority");
  assert.match(sample(base)!.skillEvidence[0]!.quote, /experience in C#/);
  assert.equal(sample(other({ description: "Qualifications:\nExperience with .NET framework.\nNo travel required." }))?.tier, "priority");
  const optional = other({ description: "Qualifications:\n5+ years C++ experience required.\nThe following skills are optional & would be added advantage.\nC# development experience." });
  assert.equal(sample(optional)?.tier, "related");
  assert.equal(sample(optional)?.skillEvidence.length, 0);
  assert.equal(sample(other({ description: "Responsibilities:\nMaintain C# platform.\nQualifications:\n5 years of Java experience." }))?.tier, "related");
  assert.equal(sample(other({ description: "任职要求：\n熟练掌握 C#。\n加分项：\nPython经验。", title: "软件工程师" }))?.tier, "priority");
  assert.equal(sample(other({ travel: "unknown", travelEvidence: undefined }))?.tier, "confirm");
  assert.equal(sample(other({ travel: "required", travelEvidence: "15% travel." }))?.tier, "related");
  assert.equal(sample(other({ travel: "mentioned", travelEvidence: "Could travel domestically or internationally." }))?.tier, "related");
  assert.equal(sample(other({ employerNature: "unknown", employerNatureEvidence: undefined }))?.tier, "related");
  assert.equal(sample(other({ availability: "unknown" })), undefined);
  assert.equal(sample(other({ verification: "unverified-lead" })), undefined);
});

function context(actorScope = "local-owner"): TrustedToolContext {
  return { requestId: randomUUID(), idempotencyKey: randomUUID(), actorScope, allowedEffects: ["read-index", "local-write"],
    budget: { requests: 0, bytes: 8 * 1024 * 1024, timeoutMs: 5000 }, signal: new AbortController().signal };
}
function success<T>(result: ToolResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }

test("durable automatic rounds resume after restart and acknowledge only selected alerts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "betterme-job-watch-"));
  const repo = openJobRepository(":memory:");
  const transport = { request: async () => { throw new Error("fixture: network must not be called"); } };
  const handle = { watchId: randomUUID(), watchKey: randomUUID() };
  let now = Date.parse("2026-11-21T04:00:00Z");
  let seedCalls = 0, expandCalls = 0;
  let researchGate: (() => void) | undefined;
  const make = () => createBackgroundJobWatch({
    databasePath: join(directory, "watch.sqlite"), repository: repo, transport, detailTransport: transport,
    now: () => now, autoStart: false, expansionIntervalMs: 1000,
    seed: async (_input, { context }) => {
      seedCalls++;
      return { observedAt: context.observedAt, status: "partial", candidates: [base,
        other({ jobId: "optional", url: "https://careers.example.org/job/optional", description: "Requirements:\nC++ required.\nOptional skills:\nC#." })], queries: [], warnings: [] };
    },
    expand: async (_input, cursor, { context }) => {
      expandCalls++;
      assert.equal(cursor.round, expandCalls > 2 ? expandCalls - 2 : expandCalls - 1, "cursor survives stop, reopen, and a cancelled expansion");
      cursor.round++;
      cursor.visited.add("https://new.example.org/careers/" + expandCalls);
      if (researchGate) await new Promise<void>(resolve => { const prior = researchGate; researchGate = () => { prior?.(); resolve(); }; });
      context.throwIfCancelled();
      cursor.closedUrls = expandCalls === 3 ? [base.url] : [];
      return { observedAt: context.observedAt, status: "partial", candidates: [base,
        other({ jobId: "req-2", url: "https://second.example.org/jobs/backend", company: "Second", title: "Backend Engineer",
          travel: "unknown", travelEvidence: undefined })], queries: [], warnings: [] };
    },
  });
  let worker = make();
  let registry = createToolRegistry([...worker.definitions]);
  const read = async () => success(await registry.execute<JobWatchStatus>("jobs.watch-status", { ...handle, offset: 0 }, context()));
  try {
    success(await registry.execute("jobs.watch-start", { ...handle, config }, context()));
    assert.equal((await read()).phase, "scheduled");
    await worker.runDue();
    const first = await read();
    assert.equal(first.unread, 1);
    assert.equal(first.priority, 1);
    assert.equal(first.total, 2);
    assert.ok(first.latestAlertAt);
    assert.equal(first.hits?.[0]?.job.candidateId, undefined);
    const wrongHandle = await registry.execute("jobs.watch-status", { ...handle, watchKey: randomUUID() }, context());
    assert.ok(!wrongHandle.ok && wrongHandle.error.code === "not-authorized");
    const wrongActor = await registry.execute("jobs.watch-status", handle, context("other-owner"));
    assert.ok(!wrongActor.ok && wrongActor.error.code === "not-authorized");
    success(await registry.execute("jobs.watch-ack", { ...handle, hitIds: [first.hits![0]!.id] }, context()));
    assert.equal((await read()).unread, 0);
    await worker.stop();
    worker = make(); registry = createToolRegistry([...worker.definitions]);
    assert.equal((await read()).rounds, 1);
    now += 2000;
    await worker.runDue();
    const second = await read();
    assert.equal(seedCalls, 1);
    assert.equal(expandCalls, 1);
    assert.equal(second.rounds, 2);
    assert.equal(second.pages, 1);
    assert.equal(second.total, 3);
    assert.equal(second.unread, 1, "rediscovery does not alert on the already read job");
    assert.equal(second.confirm, 1);
    const matches = success(await registry.execute<JobWatchStatus>("jobs.watch-status", { ...handle, offset: 0, view: "matches" }, context()));
    const related = success(await registry.execute<JobWatchStatus>("jobs.watch-status", { ...handle, offset: 0, view: "related" }, context()));
    assert.equal(matches.hits?.length, 2);
    assert.equal(related.hits?.length, 1);
    assert.equal(second.hits?.[0]?.job.company, "Second");
    success(await registry.execute("jobs.watch-ack", { ...handle, hitIds: [second.hits![0]!.id] }, context()));
    assert.equal((await read()).unread, 0);
    // Pause must cancel an in-flight read and prevent stale results from committing.
    researchGate = () => {};
    now += 2000;
    const running = worker.runDue();
    for (let attempt = 0; attempt < 20 && expandCalls !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(expandCalls, 2);
    success(await registry.execute("jobs.watch-enable", { ...handle, enabled: false }, context()));
    researchGate!();
    await running;
    const paused = await read();
    assert.equal(paused.phase, "paused");
    assert.equal(paused.rounds, 2);
    assert.equal(paused.nextRunAt, undefined);
    now += 60_000;
    await worker.runDue();
    assert.equal(expandCalls, 2);
    researchGate = undefined;
    success(await registry.execute("jobs.watch-enable", { ...handle, enabled: true }, context()));
    await worker.runDue();
    assert.equal((await read()).rounds, 3);
    assert.equal((await read()).priority, 0, "explicitly closed postings leave the review list");
    now += 2000;
    await worker.runDue();
    assert.equal((await read()).priority, 1);
    assert.equal((await read()).unread, 0, "a rediscovered, already alerted posting does not notify again");
    assert.deepEqual((await repo.readSnapshot()).jobs, []);
    assert.deepEqual((await repo.readSnapshot()).sources, []);
  } finally {
    await worker.stop(); repo.close(); rmSync(directory, { force: true, recursive: true });
  }
});

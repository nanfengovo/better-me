import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecommendationClaim, createRecommendationRanker, extractRecommendationProfile, recommendResumeJobs, recommendationSourceUrl } from "../src/lib/resume-job-recommendations";
import { fixtureResume, recommendationDataset } from "./fixtures/resume-recommendations";

test("ranks local technical/tag evidence, excludes closed/irrelevant jobs and never mutates resume or index", async () => {
  const dataset = recommendationDataset();
  const before = JSON.stringify({ dataset, fixtureResume });
  const profile = extractRecommendationProfile(fixtureResume);
  assert.ok(profile.skills.includes("C#"));
  assert.ok(profile.tags.includes("RCS"));
  const result = await recommendResumeJobs(dataset, profile);
  assert.deepEqual(result.jobs.map(job => job.id), ["tags", "local", "other"]);
  assert.equal(result.jobs[0]!.locationMatch, "same-area");
  assert.deepEqual(result.jobs.find(job => job.id === "local")!.matchedSkills, ["C#", ".NET", "Docker"]);
  assert.ok(result.jobs.find(job => job.id === "local")!.unmentionedSkills.includes("Redis"));
  assert.ok(!result.jobs[0]!.unmentionedSkills.includes("RCS"));
  assert.ok(result.jobs[0]!.match.percentage >= result.jobs[1]!.match.percentage);
  assert.equal(result.excludedClosed, 1);
  assert.equal(JSON.stringify({ dataset, fixtureResume }), before);
});

test("does not confuse Java with JavaScript, C# with C++/C, or TS with unrelated words", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  profile.skills = ["Java"];
  profile.tags = [];
  const data = recommendationDataset([{ id: "js", description: "JavaScript React" }, { id: "java", description: "Java Spring" }]);
  assert.deepEqual((await recommendResumeJobs(data, profile)).jobs.map(job => job.id), ["java"]);
  profile.skills = ["C#"];
  const langs = recommendationDataset([{ id: "c", description: "C C++ Qt" }, { id: "cs", description: "CSharp" }]);
  assert.deepEqual((await recommendResumeJobs(langs, profile)).jobs.map(job => job.id), ["cs"]);
  profile.skills = ["TypeScript"];
  assert.equal((await recommendResumeJobs(recommendationDataset([{ id: "typescript", description: "TypeScript TS" }]), profile)).jobs.length, 1);
});

test("same-area filter does not infer foreign offices or missing locations; empty profile never recommends by city alone", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const data = recommendationDataset([{ id: "foreign", description: "C#", city: "Shanghai", country: "US" }, { id: "missing", description: "C#" }, { id: "local", description: "C#", city: "上海市" }]);
  assert.deepEqual((await recommendResumeJobs(data, profile, { sameAreaOnly: true })).jobs.map(job => job.id), ["local"]);
  profile.skills = []; profile.tags = []; profile.roles = [];
  assert.equal((await recommendResumeJobs(data, profile)).jobs.length, 0);
});

test("extracts disclosed skills from experience text, not contact details or the import's unreviewed raw text", () => {
  const fact = structuredClone(fixtureResume);
  fact.experiences[0]!.techStack = [];
  fact.experiences[0]!.claims[0]!.text = { zh: "使用 Node.js 与 TypeScript 开发服务" };
  fact.importSource = { fileName: "private.txt", importedAt: fact.updatedAt, rawText: "Python", unparsedLines: [] };
  fact.profile.email = "java@company.org";
  const profile = extractRecommendationProfile(fact);
  assert.ok(profile.skills.includes("TypeScript"));
  assert.ok(profile.skills.includes("Node.js"));
  assert.ok(!profile.skills.includes("Java"));
  assert.ok(!profile.skills.includes("Python"));
});

test("rejects unsafe links, demo domains and closed jobs, with a bounded top result count", async () => {
  assert.equal(recommendationSourceUrl("javascript:alert(1)"), undefined);
  assert.equal(recommendationSourceUrl("https://user:pass@company.org/job"), undefined);
  const data = recommendationDataset([{ id: "demo", description: "C#", url: "https://example.com/jobs/1" }, { id: "valid", description: "C#" }]);
  assert.deepEqual((await recommendResumeJobs(data, extractRecommendationProfile(fixtureResume))).jobs.map(job => job.id), ["valid"]);
});

test("supports cancellation before and during a large ranking pass", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(recommendResumeJobs(recommendationDataset(), extractRecommendationProfile(fixtureResume), { signal: abort.signal }), { name: "AbortError" });
  const second = new AbortController();
  const data = recommendationDataset(Array.from({ length: 410 }, (_, i) => ({ id: `item-${i}`, description: "C# .NET" })));
  const pending = recommendResumeJobs(data, extractRecommendationProfile(fixtureResume), { signal: second.signal });
  second.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("distinct source identities with the same company, role and city occupy separate slots", async () => {
  const data = recommendationDataset([
    { id: "weak", title: "后端工程师", description: "C#", city: "上海" },
    { id: "strong", title: "后端工程师", description: "C# .NET Docker", city: "上海" },
    { id: "distinct", title: "软件工程师", description: "C# .NET", city: "上海" },
  ]);
  data.companies[1]!.names = [...data.companies[0]!.names];
  const result = await recommendResumeJobs(data, extractRecommendationProfile(fixtureResume));
  assert.deepEqual(result.jobs.map(job => job.id), ["strong", "weak", "distinct"]);
  assert.equal(result.candidates, 3);
});

test("match degree is bounded, explainable and reflects job evidence rather than a relative rank", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const data = recommendationDataset([{ id: "full", title: "后端开发工程师", description: "C# .NET Docker RCS 物流", city: "上海" },
    { id: "partial", title: "后端开发工程师", description: "C# Java Python", city: "上海" }]);
  const before = JSON.stringify({ data, profile });
  const result = await recommendResumeJobs(data, profile);
  const full = result.jobs.find(job => job.id === "full")!, partial = result.jobs.find(job => job.id === "partial")!;
  assert.equal(full.match.percentage, 100);
  assert.ok(partial.match.percentage < full.match.percentage);
  assert.deepEqual(full.match.dimensions.map(item => item.weight), [55, 15, 20, 10]);
  assert.equal(full.match.dimensions[0]!.matched, 4);
  assert.equal(full.match.dimensions[0]!.total, 4);
  assert.equal(partial.match.dimensions[0]!.total, 3);
  assert.equal((await recommendResumeJobs(recommendationDataset([{ id: "partial", title: "后端开发工程师", description: "C# Java Python", city: "上海" }]), profile)).jobs[0]!.match.percentage, partial.match.percentage);
  assert.equal(JSON.stringify({ data, profile }), before);
});

test("attributes skills only to eligible records and deduplicates copies without promoting team or training mentions", async () => {
  const fact = structuredClone(fixtureResume);
  const exp = fact.experiences[0]!;
  exp.techStack = ["K8s", "Redis", "Docker", "AWS", "Kafka", "Java"];
  const rows = [
    ["negative", "我没有使用过 Kubernetes", "Kubernetes"],
    ["team", "团队用 Redis 缓存订单", "Redis"],
    ["practice", "在练习题中使用了 Docker", "Docker"],
    ["planned", "I plan to use AWS", "AWS"],
    ["self-report", "我熟悉 Kafka", "Kafka"],
    ["unconfirmed", "Java", "Java"],
    ["personal-action", "我使用 PostgreSQL 开发订单服务", "数据库"],
  ] as const;
  exp.claims = rows.map(([kind, zh, tag], index) => {
    const claim = { id: String(index), kind: "action", text: { zh }, tags: [tag] };
    assert.equal(classifyRecommendationClaim(claim), kind);
    return claim;
  });
  const example = exp.claims.at(-1)!;
  assert.equal(classifyRecommendationClaim({ ...example, text: { zh: "项目使用 PostgreSQL" } }), "team");
  assert.equal(classifyRecommendationClaim({ ...example, text: { zh: "我为团队开发了 PostgreSQL 运维脚本" } }), "personal-action");
  exp.claims.push({ ...example, id: "same-source-copy" });
  const profile = extractRecommendationProfile(fact);
  assert.deepEqual(profile.skills, ["PostgreSQL"]);
  assert.deepEqual(profile.tags, ["数据库"]);
  assert.deepEqual((await recommendResumeJobs(recommendationDataset([{ id: "false", description: "Kubernetes Docker Redis" }, { id: "true", description: "Postgres" }]), profile)).jobs.map(job => job.id), ["true"]);
});

test("changing a requirement review reranks its job independently of its text match", async () => {
  const data = recommendationDataset([{ id: "one", description: "C# .NET Docker" }, { id: "two", description: "C#" }]);
  const profile = extractRecommendationProfile(fixtureResume);
  const plain = await recommendResumeJobs(data, profile);
  const reviewed = await recommendResumeJobs(data, profile, { requirementReview: job => job.id === "two" ? { supported: 1, partial: 0, total: 1 } : undefined });
  assert.equal(reviewed.jobs[0]!.id, "two");
  assert.deepEqual(reviewed.jobs[0]!.match, plain.jobs.find(job => job.id === "two")!.match);
  const withdrawn = await recommendResumeJobs(data, profile, { requirementReview: () => undefined });
  assert.deepEqual(withdrawn, plain);
});

test("an explicit target opens a role with missing skills and preserves the separate text score", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const pool = recommendationDataset([{ id: "transfer", title: "前端工程师", description: "Vue TypeScript" }]);
  assert.deepEqual((await recommendResumeJobs(pool, profile)).jobs, []);
  const mixed = recommendationDataset([{ id: "transfer", title: "前端工程师", description: "Vue TypeScript" },
    { id: "previous", title: "后端工程师", description: "C# .NET Docker RCS 物流" }]);
  const result = await recommendResumeJobs(mixed, { ...profile, targetRole: "前端" });
  assert.equal(result.jobs[0]!.id, "transfer");
  assert.deepEqual(result.jobs[0]!.matchedSkills, []);
  assert.ok(result.jobs[0]!.unmentionedSkills.includes("TypeScript"));
  const reviewed = await recommendResumeJobs(pool, profile, { requirementReview: () => ({ supported: 1, partial: 0, total: 3 }) });
  assert.equal(reviewed.jobs[0]!.id, "transfer");
});

test("matches explicitly named foreign cities locally and preserves uncertainty for private free-form addresses", async () => {
  const fact = structuredClone(fixtureResume);
  fact.profile.location = { zh: "Berlin" };
  const pool = recommendationDataset([{ id: "berlin", city: "Berlin", country: "DE", description: "C#" }]);
  const profile = extractRecommendationProfile(fact);
  assert.deepEqual(profile.locationAliases, []);
  assert.equal((await recommendResumeJobs(pool, profile, { sameAreaOnly: true })).jobs[0]!.locationMatch, "same-area");
  fact.profile.location = { zh: "A street and a building" };
  assert.equal((await recommendResumeJobs(pool, extractRecommendationProfile(fact))).jobs[0]!.locationMatch, "unknown");
});

test("an explicitly selected work arrangement uses the disclosed mode and leaves unknown jobs out of that filter", async () => {
  const dataset = recommendationDataset([
    { id: "remote", title: "后端开发", description: "C# .NET", city: "上海" },
    { id: "undisclosed", title: "后端开发", description: "C# .NET remote client", city: "上海" },
  ]);
  dataset.jobs[0]!.workMode = "remote";
  dataset.jobs[1]!.workMode = "unknown";
  const profile = extractRecommendationProfile(fixtureResume);
  const filtered = await recommendResumeJobs(dataset, profile, { workMode: "remote" });
  assert.deepEqual(filtered.jobs.map(item => item.id), ["remote"]);
  assert.equal((await recommendResumeJobs(dataset, profile)).jobs.length, 2);
});


test("successive snapshots reuse only unchanged scores and prune dropped jobs", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const first = recommendationDataset([{ id: "retained", description: "C# .NET", city: "上海" },
    { id: "changed", description: "C#", city: "上海" }]);
  const second = recommendationDataset([{ id: "retained", description: "C# .NET", city: "上海" },
    { id: "changed", description: "C#", city: "上海" }, { id: "added", description: "Docker" }]);
  const computed: string[] = [];
  const review = (job: { id: string; company: string }) => {
    computed.push(job.id);
    return job.company === "核实过的公司" ? { supported: 1, partial: 0, total: 1 } : undefined;
  };
  const rank = createRecommendationRanker(profile, { requirementReview: review, limit: 6 });
  await rank(first);
  assert.deepEqual(computed, ["retained", "changed"]);
  const growing = await rank(second);
  assert.deepEqual(computed, ["retained", "changed", "added"]);
  assert.equal(growing.candidates, 3);
  // A new version of the same job must be reviewed against its changed
  // materials, including the resolved foreign records which the job IDs reference.
  const third = structuredClone(second);
  third.jobs[1]!.description = "Docker Redis";
  third.companies[1]!.names[0] = "核实过的公司";
  third.locations[1]!.city = "北京";
  third.locations[1]!.raw = "北京";
  third.listings[1]!.canonicalUrl = "https://careers.company.org/jobs/new-listing";
  third.jobs.pop();
  const changed = await rank(third);
  assert.deepEqual(computed, ["retained", "changed", "added", "changed"]);
  assert.equal(changed.candidates, 2);
  const revised = changed.jobs.find(job => job.id === "changed")!;
  assert.equal(revised.sourceUrl, "https://careers.company.org/jobs/new-listing");
  assert.equal(revised.locationMatch, "other-area");
  assert.deepEqual(revised.matchedSkills, ["Docker"]);
  assert.deepEqual(revised.requirementReview, { supported: 1, partial: 0, total: 1 });
  const expected = await recommendResumeJobs(third, profile, { limit: 6, requirementReview: job => job.company === "核实过的公司"
    ? { supported: 1, partial: 0, total: 1 } : undefined });
  assert.deepEqual(changed, expected);
  const repeated = await rank(third);
  assert.deepEqual(computed, ["retained", "changed", "added", "changed"]);
  repeated.jobs[0]!.matchedSkills.push("edited outside scorer");
  assert.deepEqual(await rank(third), expected);
  await rank(second);
  assert.deepEqual(computed.slice(-2), ["changed", "added"]);
});

test("rank sessions isolate filters and the review revision while an aborted older pass cannot revive its jobs", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const old = recommendationDataset(Array.from({ length: 120 }, (_, i) => ({ id: `old-${i}`, description: "C# Docker" })));
  const next = recommendationDataset([{ id: "kept", title: "后端工程师", description: "C#", city: "上海" },
    { id: "frontend", title: "前端工程师", description: "React", city: "上海" }]);
  next.jobs[1]!.workMode = "remote";
  const rank = createRecommendationRanker(profile);
  const abort = new AbortController();
  const superseded = rank(old, abort.signal);
  abort.abort();
  const cancelled = assert.rejects(superseded, { name: "AbortError" });
  const replacement = await rank(next);
  await cancelled;
  assert.deepEqual(replacement.jobs.map(item => item.id), ["kept"]);
  assert.deepEqual(await rank(next), replacement);
  const newScope = createRecommendationRanker({ ...profile, roles: ["前端"], targetRole: "前端" }, {
    workMode: "remote", requirementReview: () => ({ supported: 1, partial: 0, total: 1 }),
  });
  assert.equal((await newScope(next)).jobs[0]!.id, "frontend");
  assert.equal((await newScope(next)).jobs[0]!.requirementReview?.supported, 1);
  const withdrawn = createRecommendationRanker({ ...profile, roles: ["前端"], targetRole: "前端" }, { workMode: "remote" });
  assert.equal((await withdrawn(next)).jobs[0]!.requirementReview, undefined);
  // The original scope was not modified by the new career direction or evidence.
  assert.deepEqual(await rank(next), replacement);
});

test("incremental ranking preserves canonical deduplication when a batch repeats a changed posting", async () => {
  const profile = extractRecommendationProfile(fixtureResume);
  const pool = recommendationDataset([{ id: "same", description: "C#" }, { id: "other", description: "Docker" }]);
  const rank = createRecommendationRanker(profile);
  await rank(pool);
  const duplicate = structuredClone(pool);
  duplicate.jobs.push({ ...duplicate.jobs[0]!, description: "C# .NET Docker", status: "open" });
  const expected = await recommendResumeJobs(duplicate, profile);
  const repeated = await rank(duplicate);
  assert.equal(repeated.candidates, 2);
  assert.equal(repeated.jobs.find(job => job.id === "same")!.status, "open");
  assert.deepEqual(repeated, expected);
  assert.deepEqual(await rank(duplicate), expected);
});

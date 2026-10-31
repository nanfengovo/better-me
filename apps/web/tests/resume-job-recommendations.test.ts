import assert from "node:assert/strict";
import test from "node:test";
import { extractRecommendationProfile, recommendResumeJobs, recommendationSourceUrl } from "../src/lib/resume-job-recommendations";
import { fixtureResume, recommendationDataset } from "./fixtures/resume-recommendations";

test("ranks local technical/tag evidence, excludes closed/irrelevant jobs and never mutates resume or index", async () => {
  const dataset = recommendationDataset();
  const before = JSON.stringify({ dataset, fixtureResume });
  const profile = extractRecommendationProfile(fixtureResume);
  assert.ok(profile.skills.includes("C#"));
  assert.ok(profile.tags.includes("RCS"));
  const result = await recommendResumeJobs(dataset, profile);
  assert.deepEqual(result.jobs.map(job => job.id), ["local", "tags", "other"]);
  assert.equal(result.jobs[0]!.locationMatch, "same-area");
  assert.deepEqual(result.jobs[0]!.matchedSkills, ["C#", ".NET", "Docker"]);
  assert.ok(result.jobs[0]!.unmentionedSkills.includes("Redis"));
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

test("cross-source identities do not fill multiple recommendation slots and the strongest evidence wins", async () => {
  const data = recommendationDataset([
    { id: "weak", title: "后端工程师", description: "C#", city: "上海" },
    { id: "strong", title: "后端工程师", description: "C# .NET Docker", city: "上海" },
    { id: "distinct", title: "软件工程师", description: "C# .NET", city: "上海" },
  ]);
  data.companies[1]!.names = [...data.companies[0]!.names];
  const result = await recommendResumeJobs(data, extractRecommendationProfile(fixtureResume));
  assert.deepEqual(result.jobs.map(job => job.id), ["strong", "distinct"]);
  assert.equal(result.candidates, 2);
});

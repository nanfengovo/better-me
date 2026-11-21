import assert from "node:assert/strict";
import test from "node:test";
import { discoverWorkdayJobs, workdayBoard, workdaySource } from "../src/workday-job-search.js";
import { withEmployerGroupEvidence } from "../src/employer-group-evidence.js";
import type { SourceAdapterContext, SourceTransport } from "../src/contracts.js";
import { validateJobPostingJsonLdSource } from "../src/jobposting-jsonld-contracts.js";

const observedAt = "2026-11-21T03:00:00Z";
const context: SourceAdapterContext = { requestId: "example", actorScope: "local", observedAt,
  signal: new AbortController().signal, budget: { requests: 40, bytes: 2_000_000, timeoutMs: 20_000 },
  throwIfCancelled() {}, consumeRequests() {}, consumeBytes() {} };

test("Workday reviews current posts from a newly registered tenant, keeps national scope distinct from the city, and checks related vacancies", async () => {
  const board = workdayBoard("https://example.wd3.myworkdayjobs.com/en-US/External")!;
  const source = await workdaySource(board, "Example");
  const paths = ["/job/Shanghai/Software-Developer_1", "/job/Suzhou/Software-Developer_2", "/job/Shanghai/Software-Developer_3", "/job/Berlin/Software-Developer_4"];
  const observed = new Set<string>();
  const transport: SourceTransport = { async request({ url }) {
    if (!url.startsWith(new URL(board.home).origin + "/")) throw new Error("other board unavailable");
    observed.add(url);
    let text: string;
    if (url === board.sitemap) text = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + paths.filter(path => !path.endsWith("_2")).map(path => "<url><loc>" + board.home + path + "</loc></url>").join("") + "</urlset>";
    else {
      const path = paths.find(path => url === board.cxs + path);
      assert.ok(path);
      text = JSON.stringify({ jobPostingInfo: { title: "Software Developer", jobDescription: "Implement .NET services.<p>Travel Required:</p><p>Occasional</p>",
        jobReqId: path.slice(-1), jobPostingSiteId: board.site, externalUrl: board.home + path, location: path.split("/")[2],
        country: { descriptor: path.includes("Berlin") ? "Germany" : "China" }, canApply: !path.endsWith("_3"), posted: true },
        hiringOrganization: { name: "Example Shanghai" }, similarJobs: [{ externalPath: paths[1] }, { externalPath: "//other.example/job/1234" }] });
    }
    return { url, text, status: 200, headers: {} };
  } };
  const query = { role: "软件工程师", skills: ["C#"] };
  const run = (region: string) => discoverWorkdayJobs({ ...query, region }, { context, transport, registeredSources: [source] });
  const local = await run("上海市"), national = await run("中国");
  assert.deepEqual(local.candidates.map(hit => hit.location), ["Shanghai"]);
  assert.deepEqual(national.candidates.map(hit => hit.location).sort(), ["Shanghai", "Suzhou"]);
  assert.ok(national.candidates.every(hit => hit.sourceId === source.sourceId && !hit.sourceProposal && hit.availability === "open"));
  assert.deepEqual(local.candidates[0]!.matchedSkills, []);
  assert.deepEqual(local.candidates[0]!.relatedSkills, [".NET"]);
  assert.equal(local.candidates[0]!.travel, "low-frequency");
  assert.ok(![...observed].some(url => url.includes("other.example")));
  assert.equal(validateJobPostingJsonLdSource(source).enumerationUrls[0], board.sitemap);
});

test("group references require the matching official tenant, company and verified posting", () => {
  const job = { company: "Bosch Group", title: ".NET engineer", url: "https://jobs.smartrecruiters.com/BoschGroup/123456", travel: "unknown", availability: "open", matchedSkills: ["C#"], verification: "official-detail" } as const;
  const candidate = { ...job, matchedSkills: [...job.matchedSkills] };
  assert.equal(withEmployerGroupEvidence(candidate).employerGroup?.name, "Bosch");
  assert.equal(withEmployerGroupEvidence({ ...candidate, verification: "unverified-lead" }).employerGroup, undefined);
  assert.equal(withEmployerGroupEvidence({ ...candidate, company: "Other" }).employerGroup, undefined);
  assert.equal(withEmployerGroupEvidence({ ...candidate, url: "https://jobs.smartrecruiters.com/BoschGroup2/123456" }).employerGroup, undefined);
  assert.equal(workdayBoard("https://elekta.wd3.myworkdayjobs.com.other.example/jobs"), undefined);
});

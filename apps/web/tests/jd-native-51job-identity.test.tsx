import assert from "node:assert/strict";
import test from "node:test";
import { detailIdentity, extractPublicJobHtml, matchesJobUrl } from "../server/jd-extractor.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const original = "https://jobs.51job.com/shanghai/166509900.html";
const description = "负责应用服务开发、系统测试、异常处理和维护，参与需求分析、代码审查、持续集成、部署交付与完整技术文档编写。";
const mismatch = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "job_mismatch";

test("the exact observed desktop 51job route identifies its numeric job without widening hosts or route depth", () => {
  assert.equal(detailIdentity(new URL(original), "51JOB"), "166509900");
  assert.equal(detailIdentity(new URL(`${original}?tracking=fixture`), "51JOB"), "166509900");
  for (const bad of [
    "https://msearch.51job.com/shanghai/166509900.html",
    "https://jobs.51job.com.example.org/shanghai/166509900.html",
    "http://jobs.51job.com/shanghai/166509900.html",
    "https://user@jobs.51job.com/shanghai/166509900.html",
    "https://jobs.51job.com:444/shanghai/166509900.html",
    "https://jobs.51job.com/shanghai/nested/166509900.html",
    "https://jobs.51job.com/shanghai/item-166509900.html",
  ]) assert.equal(detailIdentity(new URL(bad), "51JOB"), undefined, bad);
});

test("desktop numeric identity rejects another job and preserves the existing mobile navigation boundary", () => {
  assert.equal(matchesJobUrl(`${original}?tracking=fixture`, new URL(original), "51JOB"), true);
  assert.equal(matchesJobUrl(original.replace("166509900", "166509901"), new URL(original), "51JOB"), false);
  assert.equal(matchesJobUrl(original.replace("166509900", "1166509900"), new URL(original), "51JOB"), false);
  const mobile = "https://msearch.51job.com/jobs/all/166509900.html";
  assert.equal(matchesJobUrl(mobile, new URL(original), "51JOB"), false);
  assert.equal(matchesJobUrl(original, new URL(mobile), "51JOB"), false);
  assert.equal(matchesJobUrl("https://jobs.51job.com/jobs/166509900.html", new URL(mobile), "51JOB"), true, "the established /jobs/... identity family keeps its prior behavior");
});

test("native desktop projection can use visible 51job description and refuses wrong canonical or metadata job IDs", () => {
  const body = `<title>设备研发工程师</title><h1>设备研发工程师</h1><div class="job_msg">${description}</div>`;
  const result = extractPublicJobHtml(body, "51JOB", original, { requireVisibleDescription: true });
  assert.equal(result.title, "设备研发工程师"); assert.ok(result.text.includes(description));
  for (const bad of [original.replace("166509900", "166509901"), original.replace("166509900", "1166509900")]) {
    assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${bad}">${body}`, "51JOB", original, { requireVisibleDescription: true }), mismatch);
    const posting = { "@type": "JobPosting", title: "设备研发工程师", url: bad, description };
    assert.throws(() => extractPublicJobHtml(`<script type="application/ld+json">${JSON.stringify(posting)}</script>${body}`, "51JOB", original, { requireVisibleDescription: true }), mismatch);
  }
});

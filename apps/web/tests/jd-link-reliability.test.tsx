import assert from "node:assert/strict";
import test from "node:test";
import { allowedJobUrl, normalizeJobShare } from "../src/lib/jd-source.ts";
import { JdExtractionError, jdFailureGuidance, readJdFailure } from "../src/lib/jd-errors.ts";

test("中文分享消息的句尾说明不污染岗位URL，同时保持编码标点", () => {
  const url = "https://msearch.51job.com/jobs/all/166761768.html";
  for (const punctuation of ["。", "，", "；", "！", "？", "】", "》"]) {
    assert.equal(normalizeJobShare(`看看 ${url}${punctuation}请查看岗位详情`).url, url);
  }
  const encoded = `${url}?label=${encodeURIComponent("中文。含义")}&from=share`;
  assert.equal(normalizeJobShare(encoded).url, encoded);
  assert.equal(normalizeJobShare(`${url}）。`).url, url);
});

test("只给精确官方裸域补协议，保留单岗位和域名边界", () => {
  for (const input of ["liepin.com/job/123.shtml", "zhipin.com/job_detail/abc.html", "MSEARCH.51JOB.COM/jobs/all/123.html", "www.liepin.com/job/123.shtml?from=share"]) {
    assert.equal(normalizeJobShare(input).url, allowedJobUrl(`https://${input}`).url);
  }
  for (const input of ["zhipin.com.evil.test/job_detail/1.html", "evil.zhipin.com/job_detail/1.html", "zhipin.com@127.0.0.1/", "zhipin.com:8080/job_detail/1.html", "linkedin.com.evil/jobs/1"]) assert.throws(() => normalizeJobShare(input));
  assert.throws(() => normalizeJobShare("https://www.liepin.com/job/1.shtml。另一个https://www.liepin.com/job/2.shtml"), /多个/);
  assert.equal(normalizeJobShare("https://www.zhipin.com/job_detail/abc.html?city=上海").url, "https://www.zhipin.com/job_detail/abc.html?city=%E4%B8%8A%E6%B5%B7");
});

test("错误详情仅保留白名单字段，忽略外部操作和未知错误码", () => {
  const failure = readJdFailure({ code: "rate_limited", stage: "http", message: "HTTP 429", status: 429, retryAfterSeconds: 20.1, url: "https://evil.test", action: "upload" });
  assert.deepEqual(failure, { code: "rate_limited", stage: "http", message: "HTTP 429", status: 429, retryAfterSeconds: 21 });
  for (const value of [null, [], { code: "other", stage: "http", message: "unknown" }, { code: "network", stage: "run", message: "wrong" }, { code: "network", stage: "connect", message: "" }]) assert.equal(readJdFailure(value), null);
  assert.equal(readJdFailure({ code: "network", stage: "connect", message: "reset", status: 999 })?.status, undefined);
});

test("不同失败阶段指导不同操作，页面访问限制不引导重复改网络", () => {
  for (const code of ["network", "timeout"] as const) assert.equal(jdFailureGuidance({ code, stage: "connect", message: "failed" }).network, true);
  for (const code of ["login_required", "verification_required", "access_denied", "rate_limited", "unavailable", "ambiguous_jobs", "job_mismatch", "unsupported_page", "invalid_link", "service_unavailable", "browser_required", "browser_unavailable"] as const) {
    assert.equal(jdFailureGuidance({ code, stage: "page", message: "failed" }).network, false);
  }
  assert.match(jdFailureGuidance({ code: "network", stage: "connect", message: "reset" }).guidance, /TUN/);
  assert.match(jdFailureGuidance({ code: "network", stage: "page", message: "stream interrupted", status: 200 }).title, /读取中断/);
  assert.match(jdFailureGuidance({ code: "access_denied", stage: "http", message: "403", status: 403 }).guidance, /不能确定/);
  assert.match(jdFailureGuidance({ code: "rate_limited", stage: "http", message: "429", retryAfterSeconds: 35 }).guidance, /35/);
  const error = new JdExtractionError({ code: "unavailable", stage: "http", message: "原岗位已失效", status: 410 });
  assert.equal(error.message, "原岗位已失效");
  assert.equal(error.failure.status, 410);
});

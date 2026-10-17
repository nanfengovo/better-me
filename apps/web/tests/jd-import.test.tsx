import assert from "node:assert/strict";
import test from "node:test";
import { allowedJobUrl, normalizeJobShare } from "../src/lib/jd-source.ts";
import { cleanJobHtml, extractPublicJobHtml, fetchPublicJd, readLimitedJobPage } from "../server/jd-extractor.ts";
import { parseJdOcrResponse, recognizeJdScreenshots, validateScreenshotFiles, readJdDraft, saveJdDraft, reserveScreenshotBatch, completeScreenshotBatch, extractJdLink } from "../src/lib/jd-import.ts";

const description = "岗位职责：负责 .NET 平台研发与设备通信。任职要求：三年以上 C# 经验，熟悉 SQL Server、异步编程、单元测试，英语可阅读技术文档。";
const html = `<html><title>高级软件工程师</title><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": ["JobPosting"], title: "高级 C# 工程师", hiringOrganization: { name: "示例公司" }, description: `<p>${description}</p><p>C# &amp; .NET</p>` }] })}</script></html>`;

test("岗位分享消息识别四个平台及历史 HTTP 链接", () => {
  const cases = [
    ["来看看 https://www.linkedin.com/jobs/view/123/ 。", "LinkedIn"],
    ["【猎聘】职位 https://www.liepin.com/job/123.shtml。", "猎聘"],
    ["http://jobs.51job.com/shanghai/123.html", "51JOB"],
    ["www.zhipin.com/job_detail/abc.html", "BOSS直聘"],
    ["https://sg.linkedin.com/jobs/view/123", "LinkedIn"],
    ["https://lnkd.in/abc", "LinkedIn"],
  ];
  for (const [input, platform] of cases) {
    const result = normalizeJobShare(input!);
    assert.equal(result.platform, platform);
    assert.ok(result.url.startsWith("https://"));
    assert.ok(!result.url.endsWith("。"));
  }
});

test("分享包装链接中提取嵌套岗位 URL 而非包装页", () => {
  const target = "https://www.zhipin.com/job_detail/abc.html?lid=123";
  assert.equal(normalizeJobShare(`分享： https://www.zhipin.com/share?url=${encodeURIComponent(target)}`).url, target);
  assert.equal(normalizeJobShare(`https://example.com/share?redirect_url=${encodeURIComponent(target)}`).url, target);
  assert.equal(normalizeJobShare(`https://example.com/share?jumpUrl=${encodeURIComponent(target)}`).url, target);
  assert.equal(normalizeJobShare(encodeURIComponent(target)).url, target);
});

test("混合直接与嵌套的多个岗位仍明确拒绝，重复链接和坏编码不误选", () => {
  const one = "https://www.liepin.com/job/1.shtml";
  const two = "https://www.liepin.com/job/2.shtml";
  const wrapper = `https://www.liepin.com/share?url=${encodeURIComponent(one)}`;
  assert.equal(normalizeJobShare(`${one} ${wrapper}`).url, one);
  assert.throws(() => normalizeJobShare(`${two} ${wrapper}`), /多个/);
  assert.throws(() => normalizeJobShare("https%3A%2F%2Fwww.zhipin.com%2Fjob%2F1%ZZ"), /未找到/);
  assert.throws(() => normalizeJobShare("https%3A%2F%2F127.0.0.1%2Fprivate"), /未找到/);
});

test("拒绝冒充域名、私有地址、凭据、非 HTTPS 及特殊端口", () => {
  for (const url of ["https://www.zhipin.com.evil.test/job/1", "https://evil.zhipin.com/job/1", "https://127.0.0.1/", "https://[::1]/", "https://constructor/job", "https://__proto__/job", "https://user:secret@www.liepin.com/job/1", "https://www.liepin.com:8080/job/1", "file:///etc/passwd", "http://www.linkedin.com/jobs/1"]) {
    assert.throws(() => allowedJobUrl(url));
  }
  assert.throws(() => normalizeJobShare("https://www.liepin.com/job/1 https://www.liepin.com/job/2"), /多个/);
});

test("JobPosting graph 保留标题公司正文并解码实体", () => {
  const result = extractPublicJobHtml(html, "LinkedIn");
  assert.equal(result.title, "高级 C# 工程师");
  assert.match(result.text, /示例公司/);
  assert.match(result.text, /C# & \.NET/);
  assert.match(result.text, /三年以上 C# 经验/);
  assert.equal(result.method, "JobPosting 结构化正文");
  assert.equal(cleanJobHtml("<p>A&#x4e2d;&#25991;</p><script>discard</script><li>B&nbsp;&amp; C</li>"), "A中文\n• B & C");
});

test("平台正文支持嵌套标签且不把登录页误识别为 JD", () => {
  for (const [platform, className] of [["BOSS直聘", "job-sec-text"], ["猎聘", "job-intro-content"], ["51JOB", "job_msg"], ["LinkedIn", "show-more-less-html__markup"]] as const) {
    const result = extractPublicJobHtml(`<title>职位详情</title><div class="a ${className} b"><div>岗位职责</div><p>${description}</p><p>末尾完整段落</p></div><footer>无关内容</footer>`, platform);
    assert.match(result.text, /末尾完整段落/);
    assert.doesNotMatch(result.text, /无关内容/);
    assert.throws(() => extractPublicJobHtml(`<title>安全验证</title>${html}`, platform), /验证码/);
    assert.throws(() => extractPublicJobHtml("<title>招聘平台</title><main>请登录后查看全部岗位信息</main>", platform), /截图/);
    assert.throws(() => extractPublicJobHtml(`<title>Sign In | LinkedIn</title>${html}`, platform), /截图/);
    assert.throws(() => extractPublicJobHtml(`<title>招聘平台首页</title><main>${"更多优质岗位，欢迎来到招聘平台。".repeat(30)}</main>`, platform), /截图/);
    assert.throws(() => extractPublicJobHtml(`<div class="${className}">登录后查看${description}</div>`, platform), /截图/);
  }
});

test("多岗位列表不自动选择第一份 JD", () => {
  const postings = ["岗位一", "岗位二"].map((title) => ({ "@type": "JobPosting", title, description }));
  assert.throws(() => extractPublicJobHtml(`<script type="application/ld+json">${JSON.stringify(postings)}</script>`, "LinkedIn"), /多个岗位/);
});

test("公开抓取跟随平台内重定向、保留最终来源、拒绝跨域重定向", async () => {
  const visited: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    visited.push(url);
    assert.equal(init?.redirect, "manual");
    return visited.length === 1 ? new Response(null, { status: 302, headers: { location: "/job_detail/final.html" } }) : new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  const result = await fetchPublicJd("https://www.zhipin.com/share", fetcher);
  assert.equal(result.provenance.url, "https://www.zhipin.com/job_detail/final.html");
  assert.equal(result.provenance.platform, "BOSS直聘");
  assert.ok(Number.isFinite(Date.parse(result.provenance.observedAt)));
  let calls = 0;
  await assert.rejects(() => fetchPublicJd("https://www.zhipin.com/share", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  }), /官方 HTTPS/);
  assert.equal(calls, 1);
});

test("抓取大小、响应类型、状态和跳转均受约束", async () => {
  await assert.rejects(() => fetchPublicJd("https://www.liepin.com/job/123.shtml", async () => new Response(html, { headers: { "Content-Type": "application/json" } })), /不是/);
  await assert.rejects(() => fetchPublicJd("https://www.liepin.com/job/123.shtml", async () => new Response("blocked", { status: 403 })), /403/);
  await assert.rejects(() => fetchPublicJd("https://www.liepin.com/job/123.shtml", async () => new Response(html, { headers: { "Content-Type": "text/html", "Content-Length": "3000000" } })), /过大/);
  await assert.rejects(() => fetchPublicJd("https://www.liepin.com/job/123.shtml", async () => new Response(null, { status: 302, headers: { location: "/again" } })), /跳转过多/);
});

test("岗位正文流读取同样受取消与解压后大小限制", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const controller = new AbortController();
  const pending = readLimitedJobPage(response, controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(cancelled, true);
  const huge = new Response(new Uint8Array(2 * 1024 * 1024 + 1));
  await assert.rejects(() => readLimitedJobPage(huge, new AbortController().signal), /2 MB/);
});

test("旧岗位网页可按 meta charset 解码", async () => {
  const contents = `<meta charset="iso-8859-1"><p>${"Responsibilities: write clear code and tests. ".repeat(3)}Café</p>`;
  const bytes = Uint8Array.from(contents, (letter) => letter.charCodeAt(0));
  assert.match(await readLimitedJobPage(new Response(bytes), new AbortController().signal), /Café/);
});

test("OCR 拒绝空结果及错误 JSON，接受完整可编辑的原文", () => {
  assert.equal(parseJdOcrResponse(`\`\`\`json\n${JSON.stringify({ text: description })}\n\`\`\``), description);
  for (const output of ["没有岗位", '{"text":""}', '{"text":42}', '{"title":"职位"}']) assert.throws(() => parseJdOcrResponse(output));
});

test("截图校验限制格式、数量与总大小", () => {
  const png = { name: "job.png", type: "image/png", size: 1024 } as File;
  validateScreenshotFiles([png], []);
  assert.throws(() => validateScreenshotFiles([{ ...png, type: "image/svg+xml" } as File], []), /格式/);
  assert.throws(() => validateScreenshotFiles([{ ...png, size: 0 } as File], []), /为空/);
  assert.throws(() => validateScreenshotFiles(Array.from({ length: 7 }, () => png), []), /6 张/);
  assert.throws(() => validateScreenshotFiles([{ ...png, size: 11 * 1024 * 1024 } as File], []), /10 MB/);
  assert.throws(() => validateScreenshotFiles(Array.from({ length: 3 }, () => ({ ...png, size: 9 * 1024 * 1024 } as File)), []), /24 MB/);
});

test("并发截图追加按选择顺序保留，晚完成与删除不重新插入图片", () => {
  const file = (name: string) => ({ name, type: "image/png", size: 100 } as File);
  const batchOne = reserveScreenshotBatch([file("1.png"), file("2.png")], []);
  const batchTwo = reserveScreenshotBatch([file("3.png")], batchOne);
  const loaded = (batch: typeof batchOne) => batch.map((image) => ({ ...image, dataUrl: `data:image/png;base64,${image.name}` }));
  const secondFinished = completeScreenshotBatch([...batchOne, ...batchTwo], batchTwo, loaded(batchTwo));
  const allFinished = completeScreenshotBatch(secondFinished, batchOne, loaded(batchOne));
  assert.deepEqual(allFinished.map((image) => image.name), ["1.png", "2.png", "3.png"]);
  assert.ok(allFinished.every((image) => image.dataUrl));
  const removed = allFinished.filter((image) => image.id !== batchOne[0]!.id);
  assert.deepEqual(completeScreenshotBatch(removed, batchOne, loaded(batchOne)).map((image) => image.name), ["2.png", "3.png"]);
  const reservedSix = reserveScreenshotBatch(Array.from({ length: 6 }, (_, index) => file(`${index}.png`)), []);
  assert.throws(() => reserveScreenshotBatch([file("7.png")], reservedSix), /6 张/);
});

test("读取中的截图不触发 OCR 请求或只发送已完成部分", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("OCR must not send pending screenshots"); };
  try {
    const images = [{ id: "ready", name: "1.png", size: 100, dataUrl: "data:image/png;base64,ready" }, { id: "pending", name: "2.png", size: 100, dataUrl: "" }];
    await assert.rejects(() => recognizeJdScreenshots({ provider: "openai-compatible", baseUrl: "https://model.example/v1", apiKey: "", model: "vision", temperature: 0 }, images), /仍在读取/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("坏 JD 来源保留可读文字，损坏原文在替换前备份且失败不覆盖", () => {
  const original = globalThis.localStorage;
  const key = "betterme.jd-draft.v1";
  const records = new Map<string, string>();
  globalThis.localStorage = { getItem: (name: string) => records.get(name) ?? null, setItem: (name: string, value: string) => { records.set(name, value); } } as Storage;
  try {
    const raw = JSON.stringify({ text: description, shareInput: "", provenance: { kind: "link", observedAt: "2026-10-17T00:00:00Z", url: "https://private.example/job" } });
    records.set(key, raw);
    const recovered = readJdDraft();
    assert.equal(recovered.text, description);
    assert.equal(recovered.recoveryRaw, raw);
    assert.equal(recovered.provenance?.url, undefined);
    assert.equal(records.get(key), raw);
    saveJdDraft({ ...recovered, text: `${description}\n已核对` });
    assert.equal(records.get("betterme.jd-draft-recovery.v1"), raw);
    assert.equal(readJdDraft().text, `${description}\n已核对`);
    records.set(key, "broken raw JSON");
    const broken = readJdDraft();
    assert.equal(broken.recoveryRaw, "broken raw JSON");
    globalThis.localStorage.setItem = () => { throw new Error("quota"); };
    assert.throws(() => saveJdDraft({ ...broken, text: description }), /quota/);
    assert.equal(records.get(key), "broken raw JSON");
  } finally { globalThis.localStorage = original; }
});

test("缺少服务和错误 JSON 响应能明确恢复到文字与截图流程", async () => {
  const original = globalThis.fetch;
  try {
    for (const content of ["null", "[]", "not JSON"]) {
      globalThis.fetch = async () => new Response(content);
      await assert.rejects(() => extractJdLink("https://www.liepin.com/job/1.shtml", new AbortController().signal), /截图识别/);
    }
  } finally { globalThis.fetch = original; }
});

test("OCR 使用所有截图且不包含简历与 API Key 于草稿", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const screenshots = [1, 2].map((n) => ({ id: String(n), name: `${n}.png`, size: 100, dataUrl: `data:image/png;base64,${n}` }));
  const records = new Map<string, string>();
  globalThis.localStorage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } } as Storage;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[1].content.filter((part: { type: string }) => part.type === "image_url").length, 2);
    assert.match(body.messages[1].content[0].text, /不推测/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: description }) } }] }));
  };
  try {
    const result = await recognizeJdScreenshots({ provider: "openai-compatible", baseUrl: "https://model.example/v1", apiKey: "private-key", model: "vision" }, screenshots);
    assert.deepEqual(result.provenance.imageNames, ["1.png", "2.png"]);
    saveJdDraft({ text: result.text, shareInput: "", provenance: result.provenance });
    assert.equal(readJdDraft().text, description);
    assert.doesNotMatch([...records.values()].join(""), /private-key|data:image/);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

import assert from "node:assert/strict";
import test from "node:test";
import { extractPublicJobHtml, fetchPublicJd, matchesJobUrl, readLimitedJobPage } from "../server/jd-extractor.ts";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors.ts";
import { allowedJobUrl } from "../src/lib/jd-source.ts";

const description = "岗位职责：研发设备通信服务并交付回归测试用例。任职要求：熟悉 C#、SQL Server、异步编程、单元测试，并能阅读技术文档。";
const source = "https://www.zhipin.com/job_detail/target.html";
function posting(title: string, url?: string) { return { "@type": "JobPosting", title, description, ...(url ? { url } : {}) }; }
function structured(value: unknown, title = "职位详情") { return `<title>${title}</title><script type="application/ld+json">${JSON.stringify(value)}</script>`; }
function isFailure(code: JdFailureCode) { return (error: unknown) => error instanceof JdExtractionError && error.failure.code === code; }

const detailFixtures = [
  { platform: "BOSS直聘", url: source, className: "job-sec-text" },
  { platform: "猎聘", url: "https://www.liepin.com/job/123456.shtml", className: "job-intro-content" },
  { platform: "51JOB", url: "https://msearch.51job.com/jobs/all/123456.html", className: "job_msg" },
] as const;

const sectionDuties = "负责软件平台的设计开发、接口集成、交付验收与自动化测试，维护技术文档并与产品团队协作按期完成项目。";
const sectionRequirements = "熟悉 C#、SQL Server、异步编程与单元测试，具有独立排查问题能力。REQUIREMENTS_TAIL_SENTINEL";
const splitSource = "https://m.liepin.com/job/7654321.shtml";
const splitNative = { requireVisibleDescription: true, allowValidatedLiepinDescription: true } as const;
function splitParagraph(label: string, text: string) { return `<dl class="paragraph"><dt>${label}</dt><dd>${text}</dd></dl>`; }
function splitSection(content: string) { return `<section class="job-intro-container">${content}</section>`; }

test("[46] liepin split duties and requirements combine as one complete description in DOM order", () => {
  for (const requirementsFirst of [false, true]) for (const label of ["任职要求", "职位要求"]) {
    const duties = splitParagraph("岗位职责", `<p>${sectionDuties}</p><p>DUTIES_SECOND_PARAGRAPH</p>`);
    const requirements = splitParagraph(label, `<p>${sectionRequirements}</p><p>REQUIREMENTS_SECOND_PARAGRAPH</p>`);
    const body = splitSection((requirementsFirst ? requirements + duties : duties + requirements) + splitParagraph("工作地址", "ADDRESS_MUST_NOT_APPEAR"));
    const result = extractPublicJobHtml(`<title>原岗位</title>${body}`, "猎聘", splitSource, splitNative);
    assert.equal(result.text, `原岗位\n\n${requirementsFirst ? `${label}\n${sectionRequirements}\nREQUIREMENTS_SECOND_PARAGRAPH\n岗位职责\n${sectionDuties}\nDUTIES_SECOND_PARAGRAPH` : `岗位职责\n${sectionDuties}\nDUTIES_SECOND_PARAGRAPH\n${label}\n${sectionRequirements}\nREQUIREMENTS_SECOND_PARAGRAPH`}`);
  }
});

test("[46] liepin full structured description and summary both retain split requirements", () => {
  const body = splitSection(splitParagraph("岗位职责", sectionDuties) + splitParagraph("任职要求", sectionRequirements));
  for (const metadataDescription of [sectionDuties, `<p>岗位职责</p><p>${sectionDuties}</p><p>任职要求</p><p>${sectionRequirements}</p>`]) {
    const metadata = structured({ "@type": "JobPosting", title: "原岗位", url: splitSource, description: metadataDescription });
    const result = extractPublicJobHtml(metadata + body, "猎聘", splitSource, splitNative);
    assert.ok(result.text.includes(sectionDuties)); assert.ok(result.text.includes(sectionRequirements));
    assert.equal(result.text.split(sectionRequirements).length - 1, 1);
  }
});

test("[46] liepin section composition preserves every DD and excludes unrelated or recommendation paragraphs", () => {
  const duties = splitParagraph("岗位职责", sectionDuties).replace("</dl>", `<dd>${"额外交付职责与完整尾段。".repeat(8)}</dd></dl>`);
  const requirements = splitParagraph("任职要求", sectionRequirements).replace("</dl>", `<dd>REQUIREMENTS_SECOND_DD</dd></dl>`);
  const excluded = splitParagraph("工作地址", "ADDRESS_MUST_NOT_APPEAR") + `<div class="recommend">${splitParagraph("任职要求", "RECOMMENDATION_MUST_NOT_APPEAR")}</div>` + splitParagraph("其他说明", "UNRELATED_MUST_NOT_APPEAR");
  const result = extractPublicJobHtml(splitSection(duties + requirements + excluded), "猎聘", splitSource, splitNative);
  assert.ok(result.text.includes("额外交付职责与完整尾段。".repeat(8))); assert.match(result.text, /REQUIREMENTS_SECOND_DD/);
  assert.doesNotMatch(result.text, /MUST_NOT_APPEAR/);
});

test("[46] liepin explicit requirements cannot join two duties or different original-job sections", () => {
  const duties = splitParagraph("岗位职责", sectionDuties), requirements = splitParagraph("任职要求", sectionRequirements);
  const otherDuties = splitParagraph("工作职责", "另一独立岗位负责财务核算和风险控制。".repeat(6));
  for (const body of [splitSection(duties + requirements + otherDuties), splitSection(duties + requirements) + splitSection(otherDuties + requirements)]) {
    assert.throws(() => extractPublicJobHtml(body, "猎聘", splitSource, splitNative), isFailure("ambiguous_jobs"));
  }
  const crossSection = extractPublicJobHtml(splitSection(duties) + splitSection(requirements), "猎聘", splitSource, splitNative);
  assert.equal(crossSection.text, sectionDuties);
});

test("[46] liepin split sections keep native/source gates and cannot supply requirements alone", () => {
  const body = splitSection(splitParagraph("岗位职责", sectionDuties) + splitParagraph("任职要求", sectionRequirements));
  for (const options of [{}, { requireVisibleDescription: true }, { allowValidatedLiepinDescription: true }]) assert.throws(() => extractPublicJobHtml(body, "猎聘", splitSource, options), isFailure("unsupported_page"));
  for (const url of [undefined, splitSource.replace("https:", "http:"), splitSource.replace("m.liepin.com", "m.liepin.com.invalid")]) assert.throws(() => extractPublicJobHtml(body, "猎聘", url, splitNative), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(splitSection(splitParagraph("任职要求", sectionRequirements)), "猎聘", splitSource, splitNative), isFailure("unsupported_page"));
});

test("[46] short requirements stay complete while an existing single DL keeps its original output", () => {
  const short = "需熟悉 C#。";
  const split = splitSection(splitParagraph("岗位职责", sectionDuties) + splitParagraph("任职要求", short));
  assert.equal(extractPublicJobHtml(split, "猎聘", splitSource, splitNative).text, `岗位职责\n${sectionDuties}\n任职要求\n${short}`);
  const original = splitSection(`<dl class="paragraph"><dt>岗位职责</dt><dt>任职要求</dt><dd>${description}</dd></dl>`);
  assert.equal(extractPublicJobHtml(original, "猎聘", splitSource, splitNative).text, description);
  const multiple = original.replace("</dl>", `<dd>${"另一独立职责不同内容。".repeat(8)}</dd></dl>`);
  assert.throws(() => extractPublicJobHtml(multiple, "猎聘", splitSource, splitNative), isFailure("ambiguous_jobs"));
});

test("[46] split requirements cannot bypass original canonical, metadata or verification gates", () => {
  const body = splitSection(splitParagraph("岗位职责", sectionDuties) + splitParagraph("任职要求", sectionRequirements));
  const other = splitSource.replace("7654321", "7654322");
  for (const html of [`<link rel="canonical" href="${other}">${body}`, structured({ "@type": "JobPosting", title: "原岗位", url: other, description: sectionDuties }) + body]) assert.throws(() => extractPublicJobHtml(html, "猎聘", splitSource, splitNative), isFailure("job_mismatch"));
  assert.throws(() => extractPublicJobHtml(`<title>安全验证</title>${body}`, "猎聘", splitSource, splitNative), isFailure("verification_required"));
});

test("[46] a legacy wrapper around exactly one split description cannot manufacture a second job", () => {
  const body = splitSection(splitParagraph("岗位职责", sectionDuties) + splitParagraph("任职要求", sectionRequirements));
  for (const wrapped of [body.replace('class="job-intro-container"', 'class="job-intro-container job-description"'), `<article class="job-intro-content">${body}</article>`]) {
    for (const metadata of ["", structured({ "@type": "JobPosting", title: "原岗位", url: splitSource, description: sectionDuties })]) {
      const actual = extractPublicJobHtml(metadata + wrapped, "猎聘", splitSource, splitNative);
      assert.ok(actual.text.includes(`岗位职责\n${sectionDuties}\n任职要求\n${sectionRequirements}`));
      assert.equal(actual.text.split(sectionRequirements).length - 1, 1);
    }
  }
  const extra = `<article class="job-intro-content">${body}<p>${"另一独立岗位的额外职责不同。".repeat(8)}</p></article>`;
  assert.throws(() => extractPublicJobHtml(extra, "猎聘", splitSource, splitNative), isFailure("ambiguous_jobs"));
});

test("[46] deduplicating a legacy wrapper preserves its original full-text gate evidence", () => {
  const body = `<article class="job-intro-content">${splitSection(splitParagraph("岗位职责", sectionDuties) + '<dl class="paragraph"><dt>任职要求</dt><dd>请先登</dd><dd>录后查看完整要求</dd></dl>')}</article>`;
  for (const metadata of ["", structured({ "@type": "JobPosting", title: "原岗位", url: splitSource, description: sectionDuties })]) assert.throws(() => extractPublicJobHtml(metadata + body, "猎聘", splitSource, splitNative), isFailure("login_required"));
});

test("三平台结构化职责摘要不截断可见岗位容器中的完整要求和末尾段落", () => {
  const summary = "负责设备通信服务开发、异常处理、系统维护、测试用例设计与技术文档编写，并与团队协作按期交付项目成果。";
  const qualifications = "本科以上学历，三年以上研发经验，熟悉异步编程与数据库，具备良好的沟通能力。";
  for (const fixture of detailFixtures) {
    const json = { "@type": "JobPosting", title: "设备研发工程师", url: fixture.url, hiringOrganization: { name: "目标企业" }, description: summary };
    const body = `<h1>设备研发工程师</h1><div class="${fixture.className}"><h2>工作内容</h2><p>${summary}</p><h2>我们期待</h2><p>${qualifications}</p><p>末尾原文：本岗位参与海外项目协作。</p></div>`;
    for (const requireVisibleDescription of [false, true]) {
      const result = extractPublicJobHtml(structured(json) + body, fixture.platform, fixture.url, { requireVisibleDescription });
      assert.equal(result.title, "设备研发工程师", fixture.platform);
      assert.match(result.text, /目标企业/);
      assert.ok(result.text.includes(qualifications), fixture.platform);
      assert.match(result.text, /末尾原文：本岗位参与海外项目协作。/);
      assert.equal(result.text.split(summary).length - 1, 1, "保留完整容器，不把摘要重复拼入正文");
    }
  }
});

test("三平台已知详情路径不采纳与真实主标题冲突的无URL推荐JobPosting", () => {
  const recommendedDescription = `${description}推荐岗位专属内容。`;
  for (const fixture of detailFixtures) {
    const recommended = { "@type": "JobPosting", title: "推荐财务经理", hiringOrganization: { name: "推荐企业" }, description: recommendedDescription };
    const page = structured(recommended, "设备研发工程师 - 目标企业") + `<h1>设备研发工程师</h1><section>${recommendedDescription}</section>`;
    for (const requireVisibleDescription of [false, true]) {
      assert.throws(() => extractPublicJobHtml(page, fixture.platform, fixture.url, { requireVisibleDescription }), isFailure("unsupported_page"), fixture.platform);
      const result = extractPublicJobHtml(`${page}<div class="${fixture.className}">${description}目标岗位专属内容。</div>`, fixture.platform, fixture.url, { requireVisibleDescription });
      assert.match(result.text, /目标岗位专属内容/);
      assert.doesNotMatch(result.text, /推荐财务经理|推荐企业|推荐岗位专属内容/);
    }
  }
});

test("主标题普通后缀、明确同岗URL和通用标题保持兼容，不补公司或人为要求章节名", () => {
  const original = "负责通信服务开发、系统维护、自动化测试与技术文档交付，能够与跨职能团队协作分析现场问题并完成项目验收。";
  for (const fixture of detailFixtures) {
    for (const [title, heading, explicitUrl] of [
      ["设备研发工程师", "设备研发工程师 - 上海研发中心", false],
      ["设备研发工程师 | 上海研发中心", "设备研发工程师", false],
      ["设备研发工程师", "职位详情", false],
      ["设备研发工程师", "通信研发岗位", true],
    ] as const) {
      const json = { "@type": "JobPosting", title, description: original, ...(explicitUrl ? { url: fixture.url } : {}) };
      const result = extractPublicJobHtml(`${structured(json)}<h1>${heading}</h1><main>${original}</main>`, fixture.platform, fixture.url, { requireVisibleDescription: true });
      assert.equal(result.title, title, `${fixture.platform}: ${heading}`);
      assert.equal(result.text, `${title}\n\n${original}`);
      assert.doesNotMatch(result.text, /公司|任职要求|待补/);
    }
  }
});

test("三平台静态正文排除nav、aside、footer及推荐祖先和候选自身", () => {
  const regions = [
    ["nav", ""], ["aside", ""], ["footer", ""], ["section", "recommend"],
    ["section", "recommendation"], ["section", "recommendations"], ["section", "job-recommend"],
    ["section", "job-recommend-list"], ["section", "related-jobs"],
  ];
  for (const fixture of detailFixtures) {
    for (const [tag, className] of regions) {
      const excluded = `<${tag} class="${className}"><div class="${fixture.className}">${description}推荐岗位专属内容。</div></${tag}>`;
      assert.throws(() => extractPublicJobHtml(`<h1>目标岗位</h1>${excluded}`, fixture.platform, fixture.url), isFailure("unsupported_page"), `${fixture.platform}: ${tag}.${className}`);
      const result = extractPublicJobHtml(`<h1>目标岗位</h1><div class="${fixture.className}">${description}目标岗位专属内容。</div>${excluded}`, fixture.platform, fixture.url);
      assert.match(result.text, /目标岗位专属内容/);
      assert.doesNotMatch(result.text, /推荐岗位专属内容/);
    }
    assert.throws(() => extractPublicJobHtml(`<div class="${fixture.className} recommend">${description}</div>`, fixture.platform, fixture.url), isFailure("unsupported_page"));
  }
});

test("真正 DOM 属性与可见节点决定正文，脚本、注释、模板和 data-class 不构成 JD", () => {
  for (const fragment of [
    `<div data-class="job-sec-text">${description}</div>`,
    `<script>const example='<div class="job-sec-text">${description}</div>';</script>`,
    `<!-- <div class="job-sec-text">${description}</div> -->`,
    `<template><div class="job-sec-text">${description}</div></template>`,
    `<div hidden class="job-sec-text">${description}</div>`,
  ]) assert.throws(() => extractPublicJobHtml(`<title>职位详情</title>${fragment}`, "BOSS直聘", source), isFailure("unsupported_page"));
  const good = extractPublicJobHtml(`<title>职位详情</title><div class='a job-sec-text b'><p>${description}</p></div>`, "BOSS直聘", source);
  assert.match(good.text, /设备通信/);
});

test("51job宽外壳推荐列表不能仅凭字数成为职责，正文旁推荐区被排除", () => {
  const recommendation = `<ul>${"<li>同城推荐职位：软件开发，薪资面议，点击了解</li>".repeat(4)}</ul>`;
  assert.throws(() => extractPublicJobHtml(`<title>职位详情</title><div class="job-detail">推荐岗位${recommendation}</div>`, "51JOB", "https://msearch.51job.com/jobs/all/166761768.html"), isFailure("unsupported_page"));
  const result = extractPublicJobHtml(`<title>职位详情</title><div class="job-detail"><p>${description}</p><aside>${recommendation}</aside><div class="job-recommend">${recommendation}</div></div>`, "51JOB", "https://msearch.51job.com/jobs/all/166761768.html");
  assert.match(result.text, /岗位职责/);
  assert.doesNotMatch(result.text, /同城推荐/);
});

test("登录研发岗位名称不会误作登录页面，真正登录与验证页面不能使用残留结构化JD", () => {
  const sso = extractPublicJobHtml(`<title>单点登录研发工程师</title><div class="job-sec-text">${description}</div>`, "BOSS直聘", source);
  assert.equal(sso.title, "单点登录研发工程师");
  assert.throws(() => extractPublicJobHtml(structured(posting("职位"), "登录 - BOSS直聘"), "BOSS直聘", source), isFailure("login_required"));
  assert.throws(() => extractPublicJobHtml(structured(posting("职位"), "安全验证") + "<main>请完成安全验证</main>", "BOSS直聘", source), isFailure("verification_required"));
  assert.throws(() => extractPublicJobHtml(structured(posting("职位")) + "<h1>请完成安全验证</h1>", "BOSS直聘", source), isFailure("verification_required"));
});

test("观察到的Aliyun WAF meta标记明确分类为访问验证，岗位正文提及WAF不误判", () => {
  const anonymousChallenge = `<meta name="aliyun_waf_example" content="anonymous-fixture"><script>/* inert anonymous placeholder */</script>${structured(posting("残留职位"))}`;
  assert.throws(() => extractPublicJobHtml(anonymousChallenge, "51JOB", "https://msearch.51job.com/jobs/all/166761768.html"), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "verification_required");
    assert.equal(error.failure.stage, "page");
    assert.match(error.message, /WAF.*访问验证/);
    return true;
  });
  const ordinaryJob = `<title>安全研发工程师</title><div class="job_msg">${description} 熟悉 aliyun_waf 服务的配置与维护。</div>`;
  assert.match(extractPublicJobHtml(ordinaryJob, "51JOB", "https://msearch.51job.com/jobs/all/166761768.html").text, /aliyun_waf 服务/);
});

test("搜索页面中即使只有一条JobPosting，也不当成目标详情", () => {
  assert.throws(() => extractPublicJobHtml(structured(posting("推荐职位", source), "职位搜索"), "BOSS直聘", "https://www.zhipin.com/web/geek/job"), isFailure("unsupported_page"));
});

test("结构化岗位、canonical及具体目标ID需一致，多岗位中只选择明确匹配的一条", () => {
  const other = "https://www.zhipin.com/job_detail/other.html";
  assert.throws(() => extractPublicJobHtml(structured(posting("推荐职位", other)), "BOSS直聘", source), isFailure("job_mismatch"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${other}">${structured(posting("职位", source))}`, "BOSS直聘", source), isFailure("job_mismatch"));
  const result = extractPublicJobHtml(structured([posting("推荐职位", other), posting("目标职位", source)]), "BOSS直聘", source);
  assert.equal(result.title, "目标职位");
  assert.doesNotMatch(result.text, /推荐职位/);
  assert.throws(() => extractPublicJobHtml(structured([posting("一"), posting("二")]), "BOSS直聘", source), isFailure("ambiguous_jobs"));
  const alias = extractPublicJobHtml(structured(posting("移动版职位", "https://m.zhipin.com/job_detail/target.html?tracking=1")), "BOSS直聘", source);
  assert.equal(alias.title, "移动版职位");
});

test("用户提供的BOSS移动分享详情按token识别，同岗tracking差异兼容而不同token拒绝", () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/02d03c8563d57f3b0nN-09i7E1BZ?date8=20261017&sid=tosee_jd_2f369260e93318930nJy3t69EltV&openWeapp=1&fromSource=2";
  const sameJob = "https://m.zhipin.com/mpa/html/weijd/weijd-job/02d03c8563d57f3b0nN-09i7E1BZ/?fromSource=3";
  const result = extractPublicJobHtml(structured(posting("移动分享职位", sameJob)), "BOSS直聘", mobile);
  assert.equal(result.title, "移动分享职位");
  const mismatch = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anotherJobToken?fromSource=2";
  assert.throws(() => extractPublicJobHtml(structured(posting("其他职位", mismatch)), "BOSS直聘", mobile), isFailure("job_mismatch"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${mismatch}">${structured(posting("移动分享职位", sameJob))}`, "BOSS直聘", mobile), isFailure("job_mismatch"));
});

test("BOSS移动分享正文仅从经浏览器核对的岗位区域读取，不把地址或原始折叠HTML当全文", () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anonymousJob?fromSource=2";
  const body = `<title>移动岗位</title><div class="share-position"><div class="rec-detail"><div class="detail-text show-switch">${description}</div></div><div class="content"><p class="detail-text address">${"地址信息不应作为职位描述。".repeat(8)}</p></div></div>`;
  assert.throws(() => extractPublicJobHtml(body, "BOSS直聘", mobile), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(body, "BOSS直聘", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  const folded = body.replace('class="detail-text show-switch"', 'class="detail-text show-switch four-lines" style="overflow:hidden;-webkit-line-clamp:4"');
  assert.throws(() => extractPublicJobHtml(folded, "BOSS直聘", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(body, "BOSS直聘", mobile, { allowValidatedBossShareDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(body, "BOSS直聘", "https://www.zhipin.com/job_detail/anonymousJob.html", { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), isFailure("unsupported_page"));
  const result = extractPublicJobHtml(body, "BOSS直聘", mobile, { requireVisibleDescription: true, allowValidatedBossShareDescription: true });
  assert.ok(result.text.includes(description));
  assert.ok(!result.text.includes("地址信息"));
  for (const invalid of [
    body.replace('class="share-position"', 'class="share-position-other"'),
    body.replace('class="rec-detail"', 'class="rec-detail-other"'),
    body.replace('class="detail-text show-switch"', 'class="detail-text-other"'),
    body.replace('class="share-position"', 'class="share-position job-recommend"'),
  ]) assert.throws(() => extractPublicJobHtml(invalid, "BOSS直聘", mobile, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), isFailure("unsupported_page"));
});

test("BOSS移动与桌面正文候选同时存在时仍核对歧义及canonical", () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anonymousJob";
  const body = `<title>移动岗位</title><div class="share-position"><div class="rec-detail"><div class="detail-text">${description}</div></div></div>`;
  const different = "岗位职责：负责另一个团队的完全不同系统、销售业务和运营维护流程。任职要求：具备市场分析、客户服务与团队管理经验，可以独立完成业务交付。";
  assert.throws(() => extractPublicJobHtml(`${body}<div class="job-sec-text">${different}</div>`, "BOSS直聘", mobile, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), isFailure("ambiguous_jobs"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${mobile.replace("anonymousJob", "differentJob")}">${body}`, "BOSS直聘", mobile, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), isFailure("job_mismatch"));
});

const liepinSource = "https://m.liepin.com/job/1984701079.shtml?share=fixture";
const validatedLiepin = { requireVisibleDescription: true, allowValidatedLiepinDescription: true };
const liepinNativeBody = (text = description, label = "职位描述") => `<section class="job-intro-container"><dl class="paragraph"><dt>${label}</dt><dd>${text}</dd></dl></section>`;

test("猎聘新DD正文必须由native双开关和官方HTTPS原岗位来源共同启用", () => {
  const body = `<title>原岗位</title>${liepinNativeBody()}`;
  for (const options of [{}, { requireVisibleDescription: true }, { allowValidatedLiepinDescription: true }, { ...validatedLiepin, requireVisibleDescription: false }, { ...validatedLiepin, allowValidatedLiepinDescription: false }]) {
    assert.throws(() => extractPublicJobHtml(body, "猎聘", liepinSource, options), isFailure("unsupported_page"));
  }
  for (const original of [undefined, liepinSource.replace("https:", "http:"), liepinSource.replace("m.liepin.com", "user@m.liepin.com"),
    liepinSource.replace("m.liepin.com", "m.liepin.com:8443"), liepinSource.replace("m.liepin.com", "m.liepin.com.example.invalid"),
    liepinSource.replace("/job/", "/jobs/"), liepinSource.replace(".shtml", ".html")]) {
    assert.throws(() => extractPublicJobHtml(body, "猎聘", original, validatedLiepin), isFailure("unsupported_page"), original);
  }
  for (const host of ["liepin.com", "m.liepin.com", "www.liepin.com"]) {
    const result = extractPublicJobHtml(body, "猎聘", liepinSource.replace("m.liepin.com", host), validatedLiepin);
    assert.equal(result.text, `原岗位\n\n${description}`);
  }
  assert.throws(() => extractPublicJobHtml(body, "BOSS直聘", source, validatedLiepin), isFailure("unsupported_page"));
});

test("猎聘新职责段只接受明确直属DT标签和已观测父tag链，地址段不参与候选", () => {
  for (const label of ["职位描述", "职责描述：", "岗 位 职 责 : ", "<span>工作</span>职责", "职位介绍", " 职 位\n介 绍： "]) {
    const body = `<title>原岗位</title>${liepinNativeBody(description, label).replace("</section>", `<dl class="paragraph ellipsis"><dt>工作地址</dt><dd>${"地址原文不能当作职责。".repeat(8)}</dd></dl></section>`)}`;
    const result = extractPublicJobHtml(body, "猎聘", liepinSource, validatedLiepin);
    assert.equal(result.text, `原岗位\n\n${description}`); assert.doesNotMatch(result.text, /地址原文|工作地址/);
  }
  for (const body of [
    liepinNativeBody(description, "工作地址"), liepinNativeBody(description, "职位介绍详情"), liepinNativeBody(description, "推荐职位描述"),
    ...["推荐职位介绍", "职位介绍::", "岗位介绍", "工作内容", "职位内容", "岗位描述"].map(label => liepinNativeBody(description, label)),
    liepinNativeBody(description, "职位描述::"), liepinNativeBody().replace("<dt>", "<dt hidden>"),
    liepinNativeBody(description, "<aside>职位描述</aside>"),
    liepinNativeBody().replaceAll("section", "div"), liepinNativeBody().replaceAll("<dl", "<div").replaceAll("</dl>", "</div>"),
    liepinNativeBody().replace("job-intro-container", "job-intro-container-other"), liepinNativeBody().replace('class="paragraph"', 'class="paragraph-other"'),
    liepinNativeBody().replace("<dl", "<div><dl").replace("</dl>", "</dl></div>"),
    liepinNativeBody().replace("<dd>", "<div><dd>").replace("</dd>", "</dd></div>"),
    liepinNativeBody().replace("<dt>职位描述</dt>", "<dd><span>职位描述</span></dd>"),
    liepinNativeBody().replaceAll("<dd>", "<p>").replaceAll("</dd>", "</p>"),
  ]) assert.throws(() => extractPublicJobHtml(body, "猎聘", liepinSource, validatedLiepin), isFailure("unsupported_page"), body);
});

test("猎聘实测职位介绍标签仍需native双开关及原岗位来源，不作为静态正文后门", () => {
  const body = `<title>原岗位</title>${liepinNativeBody(description, "职位介绍")}`;
  for (const options of [{}, { requireVisibleDescription: true }, { allowValidatedLiepinDescription: true }, { ...validatedLiepin, requireVisibleDescription: false }, { ...validatedLiepin, allowValidatedLiepinDescription: false }]) {
    assert.throws(() => extractPublicJobHtml(body, "猎聘", liepinSource, options), isFailure("unsupported_page"));
  }
  assert.equal(extractPublicJobHtml(body, "猎聘", liepinSource, validatedLiepin).text, `原岗位\n\n${description}`);
  assert.throws(() => extractPublicJobHtml(body, "猎聘", undefined, validatedLiepin), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(body, "猎聘", liepinSource.replace("https:", "http:"), validatedLiepin), isFailure("unsupported_page"));
});

test("猎聘静态fetch不会为原始新DD页面打开native可见性专属开关", async () => {
  let requests = 0;
  await assert.rejects(fetchPublicJd(liepinSource, async () => {
    requests++; return new Response(`<title>原岗位</title>${liepinNativeBody()}`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }), isFailure("unsupported_page"));
  assert.equal(requests, 1);
});

test("猎聘native新职责候选排除推荐和隐藏区域，全部匹配DD与旧三类仍参与歧义检查", () => {
  const different = "岗位职责：负责市场活动、客户关系维护、销售报价和业务培训，独立分析渠道数据并组织团队完成季度经营目标与服务质量复盘。";
  for (const outer of ["nav", "aside", "footer", "section class='recommend'", "section class='job-recommend-list'"]) {
    const tag = outer.split(" ")[0]!;
    assert.throws(() => extractPublicJobHtml(`<${outer}>${liepinNativeBody()}</${tag}>`, "猎聘", liepinSource, validatedLiepin), isFailure("unsupported_page"));
  }
  for (const fragment of [liepinNativeBody().replace("<dd>", "<dd hidden>"), liepinNativeBody().replace("<dd>", "<dd class='recommend'>"), liepinNativeBody().replace("<section", "<section hidden")]) {
    assert.throws(() => extractPublicJobHtml(fragment, "猎聘", liepinSource, validatedLiepin), isFailure("unsupported_page"));
  }
  const clean = extractPublicJobHtml(`${liepinNativeBody()}<aside>${liepinNativeBody(different)}</aside>`, "猎聘", liepinSource, validatedLiepin);
  assert.equal(clean.text, description);
  for (const className of ["job-intro-content", "job-description", "job-desc-content"]) {
    const legacy = `<div class="${className}">${different}</div>`;
    assert.equal(extractPublicJobHtml(legacy, "猎聘", liepinSource).text, different);
    assert.throws(() => extractPublicJobHtml(liepinNativeBody() + legacy, "猎聘", liepinSource, validatedLiepin), isFailure("ambiguous_jobs"));
  }
  assert.throws(() => extractPublicJobHtml(liepinNativeBody() + liepinNativeBody(different), "猎聘", liepinSource, validatedLiepin), isFailure("ambiguous_jobs"));
  assert.throws(() => extractPublicJobHtml(liepinNativeBody().replace("</dd>", `</dd><dd class="second-description">${different}</dd>`), "猎聘", liepinSource, validatedLiepin), isFailure("ambiguous_jobs"));
  const withClass = liepinNativeBody().replace("<dd>", "<dd class='description-body'>");
  assert.equal(extractPublicJobHtml(withClass, "猎聘", liepinSource, validatedLiepin).text, description);
});

test("猎聘native新正文保持canonical和全部metadata来源冲突拒绝，不截断摘要以外完整尾段", () => {
  const summary = "负责设备通信服务开发、异常处理、系统维护、测试用例设计与技术文档编写，并与团队协作按期交付项目成果。";
  const tail = "末尾全文要求：参与海外项目协作，独立完成现场部署与交付复盘，持续改进系统的可靠性。";
  const full = `${summary}<p>${description}</p><p>${tail}</p>`;
  const json = { "@type": "JobPosting", title: "设备研发工程师", url: liepinSource, hiringOrganization: { name: "目标企业" }, description: summary };
  const body = structured(json) + liepinNativeBody(full);
  const result = extractPublicJobHtml(body, "猎聘", liepinSource, validatedLiepin);
  assert.equal(result.title, "设备研发工程师"); assert.equal(result.method, "结构化信息 + 公开岗位详情正文");
  assert.ok(result.text.startsWith("设备研发工程师\n\n目标企业\n\n")); assert.match(result.text, /末尾全文要求/); assert.ok(result.text.endsWith(tail));
  const other = liepinSource.replace("1984701079", "1984701080");
  for (const fragment of [
    `<link rel="canonical" href="${other}">${body}`,
    structured({ ...json, url: other }) + liepinNativeBody(full),
    structured({ ...json, mainEntityOfPage: { "@id": other } }) + liepinNativeBody(full),
  ]) assert.throws(() => extractPublicJobHtml(fragment, "猎聘", liepinSource, validatedLiepin), isFailure("job_mismatch"));
  const alternative = liepinNativeBody(`${summary}<p>${"另一岗位职责与完整尾段不同。".repeat(8)}</p>`);
  assert.throws(() => extractPublicJobHtml(body + alternative, "猎聘", liepinSource, validatedLiepin), isFailure("ambiguous_jobs"));
});

test("51job原移动详情接受同ID单目录canonical和结构化来源，实际导航识别保持原范围", () => {
  const mobile = "https://msearch.51job.com/jobs/all/166761768.html";
  // Anonymous fixture models the observed path shape; no live host/path is inferred.
  const alias = "https://jobs.51job.com/example-region/166761768.html?tracking=fixture";
  const body = `<h1>设备研发工程师</h1><div class="job_msg">${description}</div>`;
  for (const fields of [
    { url: alias },
    { mainEntityOfPage: alias },
    { mainEntityOfPage: { "@id": alias } },
    { url: alias, mainEntityOfPage: { url: alias } },
  ]) {
    const html = `<link rel="canonical" href="${alias}">${structured({ ...posting("设备研发工程师"), ...fields })}${body}`;
    const result = extractPublicJobHtml(html, "51JOB", mobile, { requireVisibleDescription: true });
    assert.equal(result.title, "设备研发工程师");
    assert.ok(result.text.includes(description));
  }
  assert.equal(matchesJobUrl(alias, new URL(mobile), "51JOB"), false, "元数据兼容不扩大真实导航或请求的身份规则");
});

test("51job元数据别名仍拒绝错ID、伪域、HTTP、凭据、端口和非观察路径，不采纳推荐或隐藏正文", () => {
  const mobile = "https://msearch.51job.com/jobs/all/166761768.html";
  const alias = "https://jobs.51job.com/example-region/166761768.html";
  const body = `<h1>设备研发工程师</h1><div class="job_msg">${description}</div>`;
  for (const bad of [
    "https://jobs.51job.com/example-region/166761769.html",
    "https://jobs.51job.com/example-region/1166761768.html",
    "https://jobs.51job.com.example.org/example-region/166761768.html",
    "http://jobs.51job.com/example-region/166761768.html",
    "https://user@jobs.51job.com/example-region/166761768.html",
    "https://jobs.51job.com:444/example-region/166761768.html",
    "https://jobs.51job.com/unobserved/deep/166761768.html",
    "https://jobs.51job.com/example-region/item-166761768.html",
  ]) {
    assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${bad}">${structured(posting("设备研发工程师", alias))}${body}`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("job_mismatch"), bad);
    assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${structured({ ...posting("设备研发工程师", alias), mainEntityOfPage: bad })}${body}`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("job_mismatch"), bad);
  }
  const job = structured(posting("设备研发工程师", alias));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${job}<div hidden class="job_msg">${description}</div>`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${job}<aside><div class="job_msg">${description}</div></aside>`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${job}<body class="recommend">${body}</body>`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${job}<div class="job_msg"><aside>${description}</aside></div>`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`<link rel="canonical" href="${alias}">${job}${body}`, "51JOB", "https://msearch.51job.com/unknown-detail?id=166761768", { requireVisibleDescription: true }), isFailure("job_mismatch"));
});

test("51job新增元数据别名需成对来源，保留旧路径单来源、多岗筛选和歧义保护", () => {
  const mobile = "https://msearch.51job.com/jobs/all/166761768.html";
  const alias = "https://jobs.51job.com/example-region/166761768.html";
  const other = "https://jobs.51job.com/example-region/166761769.html";
  const body = `<h1>设备研发工程师</h1><div class="job_msg">${description}</div>`;
  const canonical = `<link rel="canonical" href="${alias}">`;
  for (const unpaired of [
    `${canonical}${body}`,
    `${canonical}${structured(posting("设备研发工程师"))}${body}`,
    `${structured(posting("设备研发工程师", alias))}${body}`,
    `${canonical}${structured({ ...posting("设备研发工程师", alias), mainEntityOfPage: { "@id": alias, url: other } })}${body}`,
  ]) assert.throws(() => extractPublicJobHtml(unpaired, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("job_mismatch"));

  // Existing single-source matches do not acquire a new pairing requirement.
  for (const existing of [
    `<link rel="canonical" href="${mobile}">${body}`,
    `${structured(posting("设备研发工程师", mobile))}${body}`,
  ]) assert.ok(extractPublicJobHtml(existing, "51JOB", mobile, { requireVisibleDescription: true }).text.includes(description));

  for (const [canonicalUrl, postingUrl] of [[alias, mobile], [mobile, alias]]) {
    const html = `<link rel="canonical" href="${canonicalUrl}">${structured(posting("设备研发工程师", postingUrl))}${body}`;
    assert.ok(extractPublicJobHtml(html, "51JOB", mobile, { requireVisibleDescription: true }).text.includes(description));
  }
  const selected = extractPublicJobHtml(`${canonical}${structured([posting("推荐财务经理", other), posting("设备研发工程师", alias)])}${body}`, "51JOB", mobile, { requireVisibleDescription: true });
  assert.equal(selected.title, "设备研发工程师");
  assert.doesNotMatch(selected.text, /推荐财务经理/);
  assert.throws(() => extractPublicJobHtml(`${canonical}${structured([posting("设备研发工程师", alias), posting("另一个匹配标题", mobile)])}${body}`, "51JOB", mobile, { requireVisibleDescription: true }), isFailure("ambiguous_jobs"));
});

test("用户移动BOSS和猎聘链接保留原URL发请求，不改写桌面地址或调用额外API", async () => {
  const mobile = "https://m.zhipin.com/mpa/html/weijd/weijd-job/02d03c8563d57f3b0nN-09i7E1BZ?date8=20261017&sid=tosee_jd_2f369260e93318930nJy3t69EltV&openWeapp=1&fromSource=2";
  const liepin = "https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001";
  for (const [url, sameJob, title] of [
    [mobile, mobile.split("?")[0]!, "BOSS移动岗位"],
    [liepin, "https://m.liepin.com/job/1984701079.shtml?mscid=other", "猎聘移动岗位"],
  ]) {
    const visited: string[] = [];
    const result = await fetchPublicJd(url!, async (input) => { visited.push(String(input)); return new Response(structured(posting(title!, sameJob!)), { headers: { "Content-Type": "text/html" } }); });
    assert.deepEqual(visited, [url]);
    assert.equal(result.provenance.url, url);
    assert.equal(result.text.split("\n")[0], title);
  }
});

test("未知官方详情路径需同页结构化来源加主职位标题，自证充分时不被path白名单误拒", () => {
  const unknownSource = "https://www.liepin.com/new-detail?id=1&region=cn";
  const json = { ...posting("研发工程师"), mainEntityOfPage: { "@id": "https://www.liepin.com/new-detail?region=cn&id=1" } };
  const result = extractPublicJobHtml(`${structured(json)}<h1>研发工程师</h1>`, "猎聘", unknownSource);
  assert.equal(result.title, "研发工程师");
  assert.throws(() => extractPublicJobHtml(structured(json), "猎聘", unknownSource), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`${structured(posting("研发工程师"))}<h1>研发工程师</h1>`, "猎聘", unknownSource), isFailure("unsupported_page"));
  assert.throws(() => extractPublicJobHtml(`${structured({ ...json, mainEntityOfPage: { "@id": "https://www.liepin.com/new-detail?id=2&region=cn" } })}<h1>研发工程师</h1>`, "猎聘", unknownSource), isFailure("job_mismatch"));
});

test("未知详情URL保留查询身份，排序可规范但不同ID或其他参数不能被忽略", () => {
  const unknownSource = "https://www.liepin.com/new-detail?id=1&region=cn";
  for (const target of ["https://www.liepin.com/new-detail?id=2&region=cn", "https://www.liepin.com/new-detail?id=1&region=us", "https://www.liepin.com/new-detail?id=1"]) {
    assert.throws(() => extractPublicJobHtml(`${structured(posting("研发工程师", target))}<h1>研发工程师</h1>`, "猎聘", unknownSource), isFailure("job_mismatch"));
  }
  const homepage = "https://www.liepin.com/";
  assert.throws(() => extractPublicJobHtml(`${structured(posting("研发工程师", homepage))}<h1>研发工程师</h1>`, "猎聘", homepage), isFailure("unsupported_page"));
});

test("同标题同正文但不同岗位URL不会按字符串合并成一条，冲突mainEntity也拒绝", () => {
  const same = [posting("相同标题", source), posting("相同标题", "https://www.zhipin.com/job_detail/other.html")];
  assert.throws(() => extractPublicJobHtml(structured(same), "BOSS直聘"), isFailure("ambiguous_jobs"));
  assert.throws(() => extractPublicJobHtml(structured({ ...posting("职位", source), mainEntityOfPage: { "@id": "https://www.zhipin.com/job_detail/other.html" } }), "BOSS直聘", source), isFailure("job_mismatch"));
});

test("编码解码无效header继续meta，BOM优先，真正坏字节不会静默替换", async () => {
  const text = "<meta charset='iso-8859-1'><p>Café</p>";
  const bytes = Uint8Array.from(text, (letter) => letter.charCodeAt(0));
  const result = await readLimitedJobPage(new Response(bytes, { headers: { "Content-Type": "text/html; charset=not-real" } }), new AbortController().signal);
  assert.match(result, /Café/);
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>中文岗位</p>", "utf16le")]);
  assert.match(await readLimitedJobPage(new Response(bom, { headers: { "Content-Type": "text/html; charset=utf-8" } }), new AbortController().signal), /中文岗位/);
  await assert.rejects(readLimitedJobPage(new Response(new Uint8Array([0xc3, 0x28])), new AbortController().signal), isFailure("unsupported_page"));
});

test("HTTP登录、验证、频率和下线分类精确，429遵守Retry-After且不自动重试", async () => {
  for (const [status, code] of [[401, "login_required"], [403, "access_denied"], [429, "rate_limited"], [404, "unavailable"], [410, "unavailable"], [503, "unavailable"]] as const) {
    let calls = 0;
    await assert.rejects(fetchPublicJd(source, async () => { calls += 1; return new Response("restricted", { status, headers: { "Retry-After": "30" } }); }), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error.failure.code, code);
      assert.equal(error.failure.stage, "http");
      assert.equal(error.failure.status, status);
      assert.equal(error.failure.retryAfterSeconds, status === 429 ? 30 : undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("猎聘已观察到的脚本中转跳转说明正文未取得，不请求中转子域或猜测验证码", async () => {
  let calls = 0;
  await assert.rejects(fetchPublicJd("https://m.liepin.com/job/1984701079.shtml?mscid=anonymous", async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: calls === 1 ? "https://www.liepin.com/job/1984701079.shtml?mscid=anonymous" : "https://wow.liepin.com/t123456/transit.html" } });
  }), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "unsupported_page");
    assert.equal(error.failure.stage, "http");
    assert.equal(error.failure.status, 302);
    assert.match(error.message, /脚本中转页.*未取得岗位正文/);
    assert.doesNotMatch(error.message, /验证码|需要登录/);
    return true;
  });
  assert.equal(calls, 2);
  assert.throws(() => allowedJobUrl("https://wow.liepin.com/t123456/transit.html"));
});

test("猎聘中转识别不扩大允许域，冒充host、不同路径、凭据及非HTTPS仍拒绝", async () => {
  for (const location of [
    "https://wow.liepin.com.evil.test/t123456/transit.html",
    "https://wow.liepin.com/t123456/other.html",
    "https://wow.liepin.com/t123456/transit.html/",
    "https://wow.liepin.com/other/transit.html",
    "https://user:anonymous@wow.liepin.com/t123456/transit.html",
    "http://wow.liepin.com/t123456/transit.html",
    "https://wow.liepin.com:8080/t123456/transit.html",
  ]) {
    let calls = 0;
    await assert.rejects(fetchPublicJd("https://m.liepin.com/job/1984701079.shtml", async () => { calls += 1; return new Response(null, { status: 302, headers: { location } }); }), isFailure("invalid_link"));
    assert.equal(calls, 1);
  }
});

test("失败阶段区分链接和传输，不把未收到HTTP的网络错误猜作验证码", async () => {
  await assert.rejects(fetchPublicJd("https://evil.example/job", async () => { throw new Error("must not call"); }), isFailure("invalid_link"));
  await assert.rejects(fetchPublicJd(source, async () => { throw new TypeError("fetch failed"); }), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "network");
    assert.equal(error.failure.stage, "connect");
    assert.doesNotMatch(error.failure.message, /需要登录|验证码/);
    return true;
  });
  await assert.rejects(fetchPublicJd(source, async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); }), isFailure("timeout"));
});

test("正文流连接中断保留网络错误分类，不误报登录或未适配页面", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("terminated", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) })); } });
  await assert.rejects(fetchPublicJd(source, async () => new Response(stream, { headers: { "Content-Type": "text/html" } })), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "network");
    assert.equal(error.failure.stage, "page");
    assert.equal(error.failure.status, 200);
    assert.match(error.message, /正文读取中断/);
    return true;
  });
});

test("fetch将最终URL传给解析器，错配或搜索推荐页不能通过传输成功变成JD", async () => {
  await assert.rejects(fetchPublicJd(source, async () => new Response(structured(posting("其他岗位", "https://www.zhipin.com/job_detail/other.html")), { headers: { "Content-Type": "text/html" } })), isFailure("job_mismatch"));
  await assert.rejects(fetchPublicJd("https://www.zhipin.com/web/geek/job", async () => new Response(structured(posting("推荐岗位", source)), { headers: { "Content-Type": "text/html" } })), isFailure("unsupported_page"));
});

test("重定向不能把原目标岗位替换为另一条岗位，同ID移动与桌面跳转继续允许", async () => {
  let calls = 0;
  await assert.rejects(fetchPublicJd(source, async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://www.zhipin.com/job_detail/other.html" } })
      : new Response(structured(posting("其他岗位", "https://www.zhipin.com/job_detail/other.html")), { headers: { "Content-Type": "text/html" } });
  }), isFailure("job_mismatch"));
  calls = 0;
  const target = "https://www.liepin.com/job/123456.shtml";
  const result = await fetchPublicJd("https://m.liepin.com/job/123456.shtml?share=1", async () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 302, headers: { location: target } })
      : new Response(structured(posting("同一研发岗位", target)), { headers: { "Content-Type": "text/html" } });
  });
  assert.match(result.text, /同一研发岗位/);
});

test("取消向实际传输与正文流传播，不将主动取消误报为超时", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  await assert.rejects(fetchPublicJd(source, async () => { calls += 1; throw new Error("not reached"); }, preAborted.signal), { name: "AbortError" });
  assert.equal(calls, 0);

  const controller = new AbortController();
  let transferSignal: AbortSignal | undefined;
  const pending = fetchPublicJd(source, async (_input, init) => {
    transferSignal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => transferSignal!.addEventListener("abort", () => reject(transferSignal!.reason), { once: true }));
  }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(transferSignal?.aborted, true);

  const bodyController = new AbortController();
  let bodyCancelled = false;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const bodyPending = fetchPublicJd(source, async () => new Response(new ReadableStream<Uint8Array>({ pull() { markStarted(); }, cancel() { bodyCancelled = true; } }), { headers: { "Content-Type": "text/html" } }), bodyController.signal);
  await started;
  bodyController.abort();
  await assert.rejects(bodyPending, { name: "AbortError" });
  assert.equal(bodyCancelled, true);
});

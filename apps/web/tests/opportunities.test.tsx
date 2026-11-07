import assert from "node:assert/strict";
import test from "node:test";
import {
  OPPORTUNITY_STORAGE_KEY, OPPORTUNITY_RECOVERY_KEY,
  emptyOpportunityLibrary, createOpportunity, addOpportunity, updateOpportunity, updateApplication,
  readOpportunityLibrary, saveOpportunityLibrary, replaceCorruptOpportunityLibrary,
  normalizeOpportunityUrl, queryOpportunities, summarizeOpportunities,
  exportOpportunityJson, importOpportunityJson, mergeOpportunityLibraries, exportOpportunitiesCsv,
  recordOpportunityMaterial, deleteOpportunityMaterial, MAX_OPPORTUNITY_MATERIALS,
  type OpportunityLibrary,
} from "../src/lib/opportunities.ts";

const AT = "2026-10-17T02:00:00.000Z";
const LATER = "2026-10-18T03:00:00.000Z";

class MemoryStorage {
  data = new Map<string, string>();
  failSet = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failSet) throw new Error("quota"); this.data.set(key, value); }
}

function storage() {
  const value = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true });
  return value;
}

function fixture(): OpportunityLibrary {
  return addOpportunity(emptyOpportunityLibrary(), { company: "示例公司", title: "后端工程师", sourceUrl: "https://careers.example.com/jobs/42" }, AT).library;
}

test("手动收藏不推断工作地点、远程资格、原始发布时间或已提交", () => {
  const job = createOpportunity({ company: " Remote Company ", title: " Remote Engineer ", workMode: "remote" }, AT);
  assert.equal(job.company, "Remote Company");
  assert.equal(job.title, "Remote Engineer");
  assert.equal(job.market, "unknown");
  assert.deepEqual(job.remoteEligibleRegions, []);
  assert.deepEqual(job.location, { country: "", region: "", city: "" });
  assert.equal(job.status, "unknown");
  assert.equal(job.publisherType, "unknown");
  assert.equal(job.firstDiscoveredAt, AT);
  assert.equal(job.collectedAt, AT);
  assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(job.sourceUpdatedAt, undefined);
  assert.equal(job.lastVerifiedAt, undefined);
  assert.equal(job.lastVerificationMethod, "unknown");
  assert.equal(job.application.stage, "saved");
  assert.equal(job.application.submittedAt, undefined);
});

test("来源归一化只清理追踪参数，岗位身份保留，凭据和可执行链接拒绝", () => {
  assert.equal(normalizeOpportunityUrl("https://JOBS.example.com/apply?jobId=42&utm_source=mail&lang=zh#intro"), "https://jobs.example.com/apply?jobId=42&lang=zh");
  assert.equal(normalizeOpportunityUrl("https://jobs.example.com/?jobId=43"), "https://jobs.example.com/?jobId=43");
  assert.equal(normalizeOpportunityUrl(""), "");
  for (const url of ["javascript:alert(1)", "file:///private", "data:text/html,hello", "https://user:secret@example.com/"]) {
    assert.throws(() => normalizeOpportunityUrl(url));
  }
});

test("相同来源链接明确去重且保留现有信息，同名职位及无链接机会不会静默合并", () => {
  const first = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "工程师", description: "最初原文", sourceUrl: "https://jobs.example.com/job?id=42&utm_source=one" }, AT);
  const duplicate = addOpportunity(first.library, { company: "被修改公司", title: "不同职位", description: "不同原文", sourceUrl: "https://jobs.example.com/job?utm_source=two&id=42#detail" }, LATER);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.library, first.library);
  assert.equal(duplicate.job.description, "最初原文");
  const other = addOpportunity(first.library, { company: "A", title: "工程师", sourceUrl: "https://jobs.example.com/job?id=43" }, AT);
  assert.equal(other.duplicate, false);
  assert.equal(other.library.jobs.length, 2);
  const withoutLink = addOpportunity(other.library, { company: "A", title: "工程师" }, AT);
  assert.equal(addOpportunity(withoutLink.library, { company: "A", title: "工程师" }, AT).library.jobs.length, 4);
});

test("编辑来源产生重复时拒绝，未通过的编辑不污染原对象", () => {
  const library = addOpportunity(fixture(), { company: "B", title: "另一岗位", sourceUrl: "https://careers.example.com/jobs/43" }, AT).library;
  const secondId = library.jobs[0]!.id;
  assert.throws(() => updateOpportunity(library, secondId, { sourceUrl: "https://careers.example.com/jobs/42#anchor" }, LATER), /相同来源/);
  assert.equal(library.jobs[0]!.sourceUrl, "https://careers.example.com/jobs/43");
  assert.equal(library.jobs[0]!.updatedAt, AT);
});

test("明确确认已提交才记录提交时间，阶段历史和原始来源时间独立保留", () => {
  const library = fixture();
  const id = library.jobs[0]!.id;
  assert.throws(() => updateApplication(library, id, { stage: "applied" }, { now: AT }), /确认已/);
  assert.equal(library.jobs[0]!.application.stage, "saved");
  const submitted = updateApplication(library, id, { stage: "applied", notes: "本人在官网提交" }, { submittedConfirmed: true, now: LATER });
  assert.equal(submitted.jobs[0]!.application.submittedAt, LATER);
  assert.equal(submitted.jobs[0]!.application.history.length, 2);
  const interviewed = updateApplication(submitted, id, { stage: "interview", nextAction: "准备技术面", nextActionAt: "2026-10-20T08:00:00.000Z" }, { now: LATER });
  assert.equal(interviewed.jobs[0]!.application.submittedAt, LATER);
  assert.deepEqual(interviewed.jobs[0]!.application.history.map((item) => item.stage), ["saved", "applied", "interview"]);
  assert.equal(interviewed.jobs[0]!.sourcePublishedAt, undefined);
  assert.equal(interviewed.jobs[0]!.firstDiscoveredAt, AT);
  const edited = updateApplication(interviewed, id, { stage: "interview", notes: "更新笔记" }, { now: LATER });
  assert.equal(edited.jobs[0]!.application.history.length, 3);
});

test("可以补录面试/Offer阶段，但不反推历史投递日期", () => {
  const library = fixture();
  const id = library.jobs[0]!.id;
  const result = updateApplication(library, id, { stage: "offer" }, { now: LATER });
  assert.equal(result.jobs[0]!.application.stage, "offer");
  assert.equal(result.jobs[0]!.application.submittedAt, undefined);
});

test("原始发布时间、刷新、采集和核验各自保存，相对时间原文不伪装成绝对时间", () => {
  const job = createOpportunity({ company: "A", title: "工程师", sourcePublishedText: "3天前", sourceUpdatedAt: "2026-10-16T00:00:00.000Z", lastVerifiedAt: AT, sourceJobId: "R123" }, AT);
  assert.equal(job.sourcePublishedAt, undefined);
  assert.equal(job.sourcePublishedText, "3天前");
  assert.equal(job.sourceUpdatedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(job.lastVerifiedAt, AT);
  assert.equal(job.sourceJobId, "R123");
  assert.throws(() => createOpportunity({ company: "A", title: "工程师", sourcePublishedAt: "2026-02-31" }, AT), /日期/);
});

test("核验方式在来源读取、人工核验及旧数据未知间明确区分并随备份/CSV保存", () => {
  const imported = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "工程师", lastVerifiedAt: AT, lastVerificationMethod: "source-read" }, AT).library;
  const id = imported.jobs[0]!.id;
  assert.equal(importOpportunityJson(exportOpportunityJson(imported)).jobs[0]!.lastVerificationMethod, "source-read");
  assert.ok(exportOpportunitiesCsv(imported.jobs).includes(`"${AT}","source-read"`));
  const manual = updateOpportunity(imported, id, { lastVerifiedAt: LATER, lastVerificationMethod: "manual" }, LATER);
  assert.equal(manual.jobs[0]!.lastVerificationMethod, "manual");
  assert.equal(manual.jobs[0]!.lastVerifiedAt, LATER);
  assert.equal(importOpportunityJson(exportOpportunityJson(manual)).jobs[0]!.lastVerificationMethod, "manual");
  const legacy = JSON.parse(exportOpportunityJson(imported));
  delete legacy.jobs[0].lastVerificationMethod;
  const restored = importOpportunityJson(JSON.stringify(legacy));
  assert.equal(restored.jobs[0]!.lastVerificationMethod, "unknown");
  assert.equal(restored.jobs[0]!.lastVerifiedAt, AT);
  assert.ok(exportOpportunitiesCsv(restored.jobs).includes(`"${AT}","unknown"`));
  for (const invalid of ["automatic", "verified", null, 1]) {
    legacy.jobs[0].lastVerificationMethod = invalid;
    assert.throws(() => importOpportunityJson(JSON.stringify(legacy)), /核验方式/);
  }
});

test("同一筛选结果驱动数量，国内海外未知、开放关闭未知分别可核对", () => {
  let library = emptyOpportunityLibrary();
  for (const input of [
    { company: " A ", title: ".NET", market: "domestic", status: "open", location: { country: "中国", region: "上海", city: "上海" } },
    { company: "a", title: "Java", market: "domestic", status: "closed", location: { country: "中国", region: "北京", city: "北京" } },
    { company: "B", title: "C#", market: "overseas", status: "unknown", location: { country: "德国", region: "", city: "柏林" } },
    { company: "C", title: "Remote", market: "unknown", status: "unknown", workMode: "remote" },
  ] as const) library = addOpportunity(library, input, AT).library;
  const domestic = queryOpportunities(library, { market: "domestic" });
  assert.equal(domestic.length, 2);
  assert.deepEqual(summarizeOpportunities(domestic), { total: 2, companies: 1, markets: { domestic: 2, overseas: 0, unknown: 0 }, statuses: { open: 1, closed: 1, unknown: 0 }, stages: { saved: 2, evaluating: 0, preparing: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 } });
  assert.equal(queryOpportunities(library, { market: "overseas", search: "柏林" }).length, 1);
  assert.equal(queryOpportunities(library, { market: "domestic", status: "open", city: "上海" }).length, 1);
  assert.equal(queryOpportunities(library, { market: "overseas", workMode: "remote" }).length, 0);
  assert.equal(summarizeOpportunities(library.jobs).markets.unknown, 1);
});

test("正常保存要求接纳新修订号，旧窗口覆盖被阻止", () => {
  storage();
  const library = fixture();
  const saved = saveOpportunityLibrary(library);
  assert.equal(saved.revision, 1);
  assert.throws(() => saveOpportunityLibrary(library), /另一个窗口/);
  const updated = updateOpportunity(saved, saved.jobs[0]!.id, { salaryText: "20-30k" }, LATER);
  const savedAgain = saveOpportunityLibrary(updated);
  assert.equal(savedAgain.revision, 2);
  assert.equal(readOpportunityLibrary().library.jobs[0]!.salaryText, "20-30k");
});

test("损坏/未知版本数据保留原文并阻止正常保存", () => {
  const local = storage();
  for (const raw of ["{unfinished", "", JSON.stringify({ schemaVersion: 99, jobs: [] })]) {
    local.data.set(OPPORTUNITY_STORAGE_KEY, raw);
    const result = readOpportunityLibrary();
    assert.ok(result.error);
    assert.equal(result.recoveryRaw, raw);
    assert.throws(() => saveOpportunityLibrary(emptyOpportunityLibrary()), /阻止覆盖/);
    assert.equal(local.data.get(OPPORTUNITY_STORAGE_KEY), raw);
  }
});

test("损坏恢复需明确确认，保护原文失败不覆盖", () => {
  const local = storage();
  const raw = "{corrupt original";
  local.data.set(OPPORTUNITY_STORAGE_KEY, raw);
  assert.throws(() => replaceCorruptOpportunityLibrary(fixture(), false), /确认/);
  local.failSet = true;
  assert.throws(() => replaceCorruptOpportunityLibrary(fixture(), true), /无法保护/);
  assert.equal(local.data.get(OPPORTUNITY_STORAGE_KEY), raw);
  local.failSet = false;
  const recovered = replaceCorruptOpportunityLibrary(fixture(), true);
  assert.equal(recovered.jobs.length, 1);
  assert.equal(local.data.get(OPPORTUNITY_RECOVERY_KEY), raw);
  assert.throws(() => replaceCorruptOpportunityLibrary(fixture(), true), /正常保存或合并/);
});

test("配额失败不报告成功，不破坏上次已存记录", () => {
  const local = storage();
  const saved = saveOpportunityLibrary(fixture());
  const original = local.data.get(OPPORTUNITY_STORAGE_KEY);
  local.failSet = true;
  assert.throws(() => saveOpportunityLibrary(updateOpportunity(saved, saved.jobs[0]!.id, { salaryText: "新薪资" }, LATER)), /保存失败/);
  assert.equal(local.data.get(OPPORTUNITY_STORAGE_KEY), original);
});

test("备份往返保存投递历史，合并不覆盖现有备注和阶段", () => {
  const original = fixture();
  const id = original.jobs[0]!.id;
  const current = updateApplication(original, id, { stage: "preparing", notes: "正在准备" }, { now: LATER });
  const incoming = importOpportunityJson(exportOpportunityJson(addOpportunity(original, { company: "新增", title: "另一个机会" }, AT).library));
  const merged = mergeOpportunityLibraries(current, incoming, LATER);
  assert.equal(merged.added, 1);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.library.revision, current.revision);
  assert.equal(merged.library.jobs.find((job) => job.id === id)!.application.notes, "正在准备");
  assert.equal(merged.library.jobs.find((job) => job.id === id)!.application.stage, "preparing");
  assert.deepEqual(importOpportunityJson(exportOpportunityJson(merged.library)), merged.library);
});

test("导入强制校验整个文档，不部分导入坏数据且导出仅允许字段", () => {
  const original = fixture();
  const data = JSON.parse(exportOpportunityJson(original));
  data.apiKey = "secret";
  data.jobs[0].screenshots = ["data:image/png;base64,secret"];
  data.jobs[0].apiKey = "another-secret";
  assert.doesNotMatch(exportOpportunityJson(importOpportunityJson(JSON.stringify(data))), /secret|screenshots|apiKey/);
  data.jobs[0].market = "international";
  assert.throws(() => importOpportunityJson(JSON.stringify(data)), /市场归属/);
  assert.throws(() => importOpportunityJson(JSON.stringify({ ...original, jobs: [original.jobs[0], { ...original.jobs[0], id: "other" }] })), /相同来源/);
  assert.throws(() => importOpportunityJson(JSON.stringify({ ...original, jobs: [original.jobs[0], { ...original.jobs[0], sourceUrl: "" }] })), /编号重复/);
});

test("CSV使用引号保护多行正文并防电子表格公式注入，缺失日期保持空", () => {
  const job = createOpportunity({ company: '=HYPERLINK("https://evil.test")', title: " +1", description: '第一行,有逗号\n第二行有"引号"', sourcePublishedText: "3天前" }, AT);
  const library = updateApplication({ ...emptyOpportunityLibrary(), jobs: [job] }, job.id, { stage: "saved", notes: "\t@SUM(1)" }, { now: AT });
  const csv = exportOpportunitiesCsv(library.jobs);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil.test""\)"/);
  assert.match(csv, /"'\+1"/);
  assert.ok(csv.includes('"\'\t@SUM(1)"'));
  assert.ok(csv.includes('"第一行,有逗号\n第二行有""引号"""'));
  assert.ok(csv.includes('"3天前","",""'));
});

test("投递材料是用户手动记录的独立快照，后续修改来源对象不影响正文且不改变投递状态", () => {
  const library = fixture();
  const id = library.jobs[0]!.id;
  const source = { resumeViewId: "resume-1", resumeName: "后端简历", resumeUpdatedAt: AT, locale: "zh" as const, markdown: "# 原始姓名\n当时的项目经历" };
  const recorded = recordOpportunityMaterial(library, id, source, LATER);
  source.markdown = "后来修改的简历";
  source.resumeName = "后来名称";
  assert.equal(library.jobs[0]!.materials.length, 0);
  assert.equal(recorded.jobs[0]!.materials[0]!.markdown, "# 原始姓名\n当时的项目经历");
  assert.equal(recorded.jobs[0]!.materials[0]!.resumeName, "后端简历");
  assert.equal(recorded.jobs[0]!.materials[0]!.resumeUpdatedAt, AT);
  assert.equal(recorded.jobs[0]!.materials[0]!.createdAt, LATER);
  assert.equal(recorded.jobs[0]!.application.stage, "saved");
  assert.equal(recorded.jobs[0]!.application.submittedAt, undefined);
  assert.deepEqual(importOpportunityJson(exportOpportunityJson(recorded)), recorded);
  const csv = exportOpportunitiesCsv(recorded.jobs);
  assert.match(csv, /后端简历 \(zh, 2026-10-18/);
  assert.doesNotMatch(csv, /原始姓名/);
});

test("旧机会库没有材料字段时兼容为空，快照导入仅保留已知字段", () => {
  const library = fixture();
  const legacy = JSON.parse(exportOpportunityJson(library));
  delete legacy.jobs[0].materials;
  assert.deepEqual(importOpportunityJson(JSON.stringify(legacy)).jobs[0]!.materials, []);
  const withMaterial = recordOpportunityMaterial(library, library.jobs[0]!.id, { resumeViewId: "view", resumeName: "Resume", resumeUpdatedAt: AT, locale: "en", markdown: "My resume" }, AT);
  const input = JSON.parse(exportOpportunityJson(withMaterial));
  input.jobs[0].materials[0].apiKey = "private-key";
  input.jobs[0].materials[0].fullDocument = { factBase: "private-facts" };
  assert.doesNotMatch(exportOpportunityJson(importOpportunityJson(JSON.stringify(input))), /private-key|private-facts|apiKey|fullDocument/);
});

test("Atlas结构化来源与多地点证据可完整备份往返，旧机会库缺少新增字段时默认兼容", () => {
  const library = addOpportunity(emptyOpportunityLibrary(), {
    company: "合成企业", title: "合成工程师", sourcePlatform: "招聘来源 A", sourceUrl: "https://jobs.example.test/role-a",
    sourceReferences: [
      { sourceId: "source-a", listingId: "listing-a", sourcePlatform: "招聘来源 A", sourceUrl: "https://jobs.example.test/role-a",
        sourceJobId: "ROLE-A", observedAt: AT, sourcePublishedAt: "2026-10-10T08:00:00.000Z", sourcePublishedText: "10月10日发布",
        sourceUpdatedAt: "2026-10-11T08:00:00.000Z", salaryTexts: ["月薪 30-40K"] },
      { sourceId: "source-b", listingId: "listing-b", sourcePlatform: "招聘来源 B", sourceUrl: "https://careers.example.test/role-b",
        observedAt: LATER, sourcePublishedText: "3 days ago", salaryTexts: ["Negotiable"] },
    ],
    workLocations: [
      { id: "office-sh", raw: "上海市浦东新区合成路 10 号", kind: "office", countryCode: "CN", region: "上海市", city: "上海市", district: "浦东新区",
        streetAddress: "合成路 10 号", precision: "address", verification: "unverified",
        coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" }, provider: "synthetic-source", resolvedAt: AT,
        evidence: [{ sourceId: "source-a", listingId: "listing-a", observationId: "observation-a", sourceUrl: "https://jobs.example.test/role-a", observedAt: AT, quote: "工作地点：上海市浦东新区合成路 10 号" }] },
      { id: "office-seattle", raw: "Seattle, Washington, US", kind: "office", countryCode: "US", region: "Washington", city: "Seattle",
        precision: "city", verification: "unknown", evidence: [{ sourceId: "source-b", listingId: "listing-b", observationId: "observation-b", observedAt: LATER }] },
    ],
  }, AT).library;
  const job = library.jobs[0]!;
  assert.deepEqual(importOpportunityJson(exportOpportunityJson(library)), library);
  assert.equal(job.sourceReferences[0]!.sourcePublishedText, "10月10日发布");
  assert.equal(job.workLocations[0]!.coordinates?.coordinateSystem, "WGS84");
  assert.equal(job.workLocations[1]!.evidence[0]!.sourceUrl, undefined);

  const legacy = JSON.parse(exportOpportunityJson(library));
  delete legacy.jobs[0].sourceReferences;
  delete legacy.jobs[0].workLocations;
  const restored = importOpportunityJson(JSON.stringify(legacy)).jobs[0]!;
  assert.deepEqual(restored.sourceReferences, []);
  assert.deepEqual(restored.workLocations, []);
  for (const invalid of [
    { ...job, sourceReferences: [{ ...job.sourceReferences[0]!, sourceUrl: "javascript:alert(1)" }] },
    { ...job, sourceReferences: [job.sourceReferences[0], job.sourceReferences[0]] },
    { ...job, workLocations: [{ ...job.workLocations[0]!, coordinates: { latitude: 91, longitude: 121, coordinateSystem: "WGS84" } }] },
    { ...job, workLocations: [job.workLocations[0], job.workLocations[0]] },
  ]) assert.throws(() => importOpportunityJson(JSON.stringify({ ...library, jobs: [invalid] })));
});

test("材料超限明确报错且不删除旧快照，手动清理后可以继续记录", () => {
  let library = fixture();
  const id = library.jobs[0]!.id;
  const material = { resumeViewId: "view", resumeName: "Resume", resumeUpdatedAt: AT, locale: "en" as const, markdown: "My resume" };
  for (let index = 0; index < MAX_OPPORTUNITY_MATERIALS; index += 1) library = recordOpportunityMaterial(library, id, material, AT);
  const firstId = library.jobs[0]!.materials[0]!.id;
  assert.throws(() => recordOpportunityMaterial(library, id, material, AT), /最多保留 30/);
  assert.equal(library.jobs[0]!.materials.length, 30);
  assert.equal(library.jobs[0]!.materials[0]!.id, firstId);
  library = deleteOpportunityMaterial(library, id, firstId, LATER);
  assert.equal(library.jobs[0]!.materials.length, 29);
  assert.equal(recordOpportunityMaterial(library, id, material, LATER).jobs[0]!.materials.length, 30);
  assert.throws(() => recordOpportunityMaterial(fixture(), "missing", material, AT), /不存在/);
  const empty = fixture();
  assert.throws(() => recordOpportunityMaterial(empty, empty.jobs[0]!.id, { ...material, markdown: "" }, AT), /简历材料正文/);
  assert.throws(() => recordOpportunityMaterial(empty, empty.jobs[0]!.id, { ...material, markdown: "x".repeat(120_001) }, AT), /简历材料正文/);
});

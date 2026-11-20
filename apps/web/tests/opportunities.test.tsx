import assert from "node:assert/strict";
import test from "node:test";
import {
  OPPORTUNITY_STORAGE_KEY, OPPORTUNITY_RECOVERY_KEY,
  emptyOpportunityLibrary, createOpportunity, addOpportunity, updateOpportunity, updateApplication,
  readOpportunityLibrary, saveOpportunityLibrary, replaceCorruptOpportunityLibrary,
  normalizeOpportunityUrl, queryOpportunities, summarizeOpportunities,
  exportOpportunityJson, importOpportunityJson, mergeOpportunityLibraries, exportOpportunitiesCsv,
  recordOpportunityMaterial, deleteOpportunityMaterial, reviewOpportunityEvent, recordApplicationCommunication, deleteApplicationCommunication, MAX_OPPORTUNITY_MATERIALS,
  captureOpportunityDecision, recommendOpportunityAction, opportunityDecisionCareerJob, opportunityDecisionSnapshotJob, recordOpportunityDecisionAction, recordOpportunityEvaluation, exportOpportunityEvaluations, consentedOpportunityEvaluations,
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

test("reopens the original JD, chosen resume material, rationale and feedback type after later edits", () => {
  const { library: first, job } = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "Engineer", description: "Original requirement" }, AT);
  let library = recordOpportunityMaterial(first, job.id, { resumeViewId: "v1", resumeName: "Design work", locale: "en", markdown: "Original resume", resumeUpdatedAt: AT }, AT);
  const materialId = library.jobs[0]!.materials[0]!.id;
  library = updateApplication(library, job.id, { stage: "evaluating" }, { now: AT });
  const event = library.jobs[0]!.application.history.at(-1)!;
  const decision = { action: "collect-evidence", reason: "Review design authorship", materialId, feedback: "interpretation", observation: "My inference" } as const;
  library = reviewOpportunityEvent(library, job.id, "stage", event.id, decision, AT);
  library = updateOpportunity(library, job.id, { title: "Changed role", description: "New requirement" }, LATER);
  library = updateApplication(library, job.id, { stage: "preparing" }, { now: LATER });
  library = updateApplication(library, job.id, { stage: "interview" }, { now: LATER });
  const reopened = importOpportunityJson(exportOpportunityJson(library)).jobs[0]!;
  assert.equal(reopened.jdSnapshots?.length, 2);
  assert.equal(reopened.jdSnapshots?.find(row => row.id === event.jdSnapshotId)?.description, "Original requirement");
  const persisted = reopened.application.history.find(row => row.id === event.id)!.review!;
  assert.deepEqual(persisted, { ...decision, reviewedAt: AT });
  assert.equal(reopened.materials.find(item => item.id === persisted.materialId)?.markdown, "Original resume");
  assert.equal(reopened.application.submittedAt, undefined);
  assert.equal(library.schemaVersion, 3);
  assert.throws(() => reviewOpportunityEvent(library, job.id, "stage", event.id, { ...decision, materialId: "foreign" }), /此岗位/);
  const removed = deleteOpportunityMaterial(library, job.id, materialId);
  assert.equal(removed.jobs[0]!.application.history.find(row => row.id === event.id)!.review!.materialId, undefined);
  assert.equal(removed.jobs[0]!.application.history.find(row => row.id === event.id)!.review!.reason, decision.reason);
});

test("backfilled and legacy events keep unknown JD versions; silence and interpretation stay distinct from reported feedback", () => {
  const base = fixture(), id = base.jobs[0]!.id;
  const legacy = importOpportunityJson(exportOpportunityJson(base));
  const saved = legacy.jobs[0]!.application.history[0]!;
  assert.equal(saved.jdSnapshotId, undefined);
  const modified = updateOpportunity(legacy, id, { description: "Revised before backfill" }, LATER);
  let library = recordApplicationCommunication(modified, id, { direction: "inbound", method: "email", occurredAt: AT, contact: "", summary: "Receipt" }, { occurredConfirmed: true, now: LATER });
  const comm = library.jobs[0]!.application.communications[0]!;
  assert.equal(comm.jdSnapshotId, undefined);
  const reason = { action: "apply", reason: "Close alignment", observation: "Guessed reason", feedback: "unobserved" } as const;
  library = reviewOpportunityEvent(library, id, "stage", saved.id, reason, LATER);
  assert.equal(library.jobs[0]!.application.history[0]!.review!.observation, "");
  assert.throws(() => reviewOpportunityEvent(library, id, "stage", saved.id, { ...reason, feedback: "reported", observation: " " }), /反馈/);
  library = reviewOpportunityEvent(library, id, "communication", comm.id, { ...reason, feedback: "reported", observation: "Please show a design decision" }, LATER);
  assert.equal(library.jobs[0]!.application.communications[0]!.review!.feedback, "reported");
  assert.equal(library.jobs[0]!.application.stage, "saved");
  const forged = JSON.parse(exportOpportunityJson(library));
  forged.jobs[0].application.communications[0].jdSnapshotId = "other-job";
  assert.throws(() => importOpportunityJson(JSON.stringify(forged)), /不属于/);
});

test("decision receipts replay an exact earlier JD, adopted resume, actual stage and reported feedback", () => {
  const { library: initial, job } = addOpportunity(emptyOpportunityLibrary(), {
    company: "Synthetic company", title: "Engineer", description: "Design dependable services",
    sourceJobId: "canonical-job-id", sourcePlatform: "Test", sourceUrl: "https://example.invalid/jobs/1", status: "open",
  }, AT);
  const officialVersion = { documentId: "synthetic-doc", versionId: "synthetic-adoption", contentHash: "a".repeat(64) };
  const before = { total: 2, supported: 2, partial: 0, independentRetests: [] };
  let library = captureOpportunityDecision(initial, job.id, before, officialVersion, AT);
  const receipt = library.jobs[0]!.decisions![0]!;
  assert.deepEqual({ action: receipt.action, reason: receipt.reasonCode }, { action: "apply", reason: "verified-requirements" });
  assert.equal(library.schemaVersion, 4);
  assert.notEqual(job.id, job.sourceJobId);
  assert.equal(opportunityDecisionCareerJob(job).id, "canonical-job-id");
  library = recordOpportunityMaterial(library, job.id, { resumeViewId: "view", resumeName: "Synthetic resume", resumeUpdatedAt: AT, markdown: "# old resume", locale: "en", officialVersion }, AT);
  const materialId = library.jobs[0]!.materials[0]!.id;
  library = updateApplication(library, job.id, { stage: "preparing" }, { now: AT });
  const stage = library.jobs[0]!.application.history.at(-1)!;
  const input = { action: "practice", reason: "Validate before applying", feedback: "unobserved", observation: "", materialId } as const;
  assert.throws(() => recordOpportunityDecisionAction(library, job.id, receipt.id, input), /确认/);
  assert.throws(() => recordOpportunityDecisionAction(library, job.id, "another-job-decision", input, { occurredConfirmed: true, now: AT }), /不属于/);
  library = recordOpportunityDecisionAction(library, job.id, receipt.id, input, { occurredConfirmed: true, now: AT, sourceEvent: { kind: "stage", id: stage.id } });
  const actionId = library.jobs[0]!.application.actions![0]!.id;
  assert.throws(() => recordOpportunityDecisionAction(library, job.id, receipt.id, input, { occurredConfirmed: true, now: AT, sourceEvent: { kind: "stage", id: stage.id } }), /重复关联/);
  const actual = library.jobs[0]!.application.actions![0]!;
  assert.deepEqual(actual.review.officialVersion, officialVersion);
  assert.equal(actual.review.outcome, "unknown");
  assert.equal(library.jobs[0]!.application.submittedAt, undefined);

  library = recordApplicationCommunication(library, job.id, { direction: "inbound", method: "email", occurredAt: LATER, contact: "Private contact", summary: "Please explain resilience tradeoffs" }, { occurredConfirmed: true, now: LATER });
  const feedbackCommunicationId = library.jobs[0]!.application.communications[0]!.id;
  const retest = { kitId: "private-training-identifier", questionVersion: "b".repeat(64), capabilityId: "c".repeat(64), sourceVersion: "d".repeat(64), completedAt: LATER, result: "met" as const };
  library = reviewOpportunityEvent(library, job.id, "action", actionId,
    { ...input, feedback: "reported", observation: "Please explain resilience tradeoffs", outcome: "positive", feedbackCommunicationId, afterEvidence: { ...before, independentRetests: [retest] } }, LATER);
  library = recordOpportunityEvaluation(library, job.id, actionId, true, LATER);
  assert.deepEqual(consentedOpportunityEvaluations(library), [{ schemaVersion: 1, recommendedAction: "apply", actualAction: "practice", outcome: "positive", corrected: true, independentRetest: "met" }]);
  const exported = exportOpportunityEvaluations(library);
  for (const privateValue of [job.id, job.company, job.title, job.description, job.sourceUrl, job.sourceJobId!, actionId, feedbackCommunicationId, materialId, officialVersion.documentId, retest.kitId, retest.sourceVersion, LATER, "Private contact", "tradeoffs"]) assert.ok(!exported.includes(privateValue), privateValue);
  library = updateOpportunity(library, job.id, { description: "Different JD", status: "closed", sourceJobId: "new-id" }, LATER);
  library = captureOpportunityDecision(library, job.id, { total: 0, supported: 0, partial: 0, independentRetests: [] }, undefined, LATER);
  const replay = importOpportunityJson(exportOpportunityJson(library));
  const revised = replay.jobs[0]!;
  assert.deepEqual(revised.decisions![0], receipt);
  assert.equal(opportunityDecisionSnapshotJob(revised, receipt).description, job.description);
  assert.equal(opportunityDecisionSnapshotJob(revised, receipt).sourceJobId, "canonical-job-id");
  assert.equal(revised.decisions!.at(-1)!.reasonCode, "closed-opportunity");
  assert.equal(revised.application.actions![0]!.previousReviews![0]!.outcome, "unknown");
  assert.equal(revised.application.actions![0]!.review.feedbackCommunicationId, feedbackCommunicationId);
  const removedMaterial = deleteOpportunityMaterial(replay, job.id, materialId, LATER);
  assert.deepEqual(removedMaterial.jobs[0]!.application.actions![0]!.review.officialVersion, officialVersion);
  const removedCommunication = deleteApplicationCommunication(removedMaterial, job.id, feedbackCommunicationId, LATER);
  assert.equal(removedCommunication.jobs[0]!.application.actions![0]!.review.feedbackCommunicationId, undefined);
  assert.equal(removedCommunication.jobs[0]!.application.actions![0]!.review.observation, "Please explain resilience tradeoffs");
  library = recordOpportunityEvaluation(removedCommunication, job.id, actionId, false, LATER);
  assert.equal(exportOpportunityEvaluations(library), "[]");
});

test("recommendation reacts to the latest independent retest, missing evidence and unknown job status", () => {
  const missed = { kitId: "first-attempt", questionVersion: "a".repeat(64), capabilityId: "b".repeat(64), sourceVersion: "c".repeat(64), completedAt: AT, result: "missed" as const };
  const base = { total: 1, supported: 0, partial: 1, independentRetests: [missed] };
  assert.equal(recommendOpportunityAction(base, "open").action, "practice");
  assert.equal(recommendOpportunityAction(base, "unknown").reasonCode, "unverified-opportunity");
  assert.equal(recommendOpportunityAction(base, "closed").reasonCode, "closed-opportunity");
  const latest = { ...missed, kitId: "new-attempt", sourceVersion: "d".repeat(64), completedAt: LATER, result: "met" as const };
  assert.equal(recommendOpportunityAction({ ...base, supported: 1, partial: 0, independentRetests: [missed, latest] }, "open").action, "apply");
  assert.equal(recommendOpportunityAction({ ...base, independentRetests: [missed, { ...latest, result: "recorded" }] }, "open").reasonCode, "unreviewed-retest");
  assert.equal(recommendOpportunityAction({ ...base, independentRetests: [] }, "open").reasonCode, "missing-evidence");
});

test("anonymous aggregate counts new independent results once, distinguishes unknown feedback and resets consent after correction", () => {
  let { library, job } = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "Role", description: "Test workflow", status: "open" }, AT);
  const base = { total: 2, supported: 0, partial: 0, independentRetests: [] };
  const newRetest = { kitId: "same-independent-attempt", questionVersion: "a".repeat(64), capabilityId: "b".repeat(64), sourceVersion: "c".repeat(64), completedAt: LATER, result: "met" as const };
  const action = { action: "practice", reason: "I chose to practise", feedback: "interpretation", observation: "My guess", outcome: "positive", afterEvidence: { ...base, independentRetests: [newRetest] } } as const;
  for (let i = 0; i < 2; i++) {
    library = captureOpportunityDecision(library, job.id, base, undefined, AT);
    const decision = library.jobs[0]!.decisions!.at(-1)!;
    library = recordOpportunityDecisionAction(library, job.id, decision.id,
      { ...action, afterEvidence: { ...base, independentRetests: [] } }, { occurredConfirmed: true, now: AT });
    const event = library.jobs[0]!.application.actions!.at(-1)!;
    library = reviewOpportunityEvent(library, job.id, "action", event.id, action, LATER);
    library = recordOpportunityEvaluation(library, job.id, event.id, true, LATER);
  }
  const samples = consentedOpportunityEvaluations(library);
  assert.equal(samples.length, 2);
  assert.equal(samples.filter(row => row.independentRetest === "met").length, 1);
  assert.equal(samples.filter(row => row.independentRetest === "unknown").length, 1);
  assert.ok(samples.every(row => row.outcome === "unknown"));
  const originalAction = library.jobs[0]!.application.actions![0]!;
  const decisionId = originalAction.decisionId;
  library = recordOpportunityDecisionAction(library, job.id, decisionId, { ...action, afterEvidence: undefined }, { occurredConfirmed: true, now: AT });
  assert.throws(() => recordOpportunityEvaluation(library, job.id, library.jobs[0]!.application.actions!.at(-1)!.id, true, LATER), /同一建议/);
  library = reviewOpportunityEvent(library, job.id, "action", originalAction.id, { ...action, action: "collect-evidence" }, LATER);
  assert.equal(consentedOpportunityEvaluations(library).length, 1);
  const altered = JSON.parse(exportOpportunityJson(library));
  altered.jobs[0].application.actions[1].evaluationSample.corrected = false;
  assert.throws(() => importOpportunityJson(JSON.stringify(altered)), /样本.*不一致/);
});

test("a manually saved JD keeps its no-ID/no-platform scope, while a canonical source keeps its identity", () => {
  const { library, job } = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "Role", description: "A requirement", status: "open" }, AT);
  const { id, sourcePlatform } = opportunityDecisionCareerJob(job);
  assert.equal(id, undefined);
  assert.equal(sourcePlatform, undefined);
  const withDecision = captureOpportunityDecision(library, job.id, { total: 1, supported: 0, partial: 0, independentRetests: [] }, undefined, AT);
  const replay = importOpportunityJson(exportOpportunityJson(withDecision)).jobs[0]!;
  assert.deepEqual(opportunityDecisionCareerJob(opportunityDecisionSnapshotJob(replay, replay.decisions![0]!)), opportunityDecisionCareerJob(job));
});

test("career identity retains the exact Agent URL while opportunity dedup uses its normalized URL", () => {
  const originalUrl = "https://example.invalid/job?z=1&a=2&utm_source=fixture#position";
  const { library, job } = addOpportunity(emptyOpportunityLibrary(), { company: "A", title: "Role", description: "Requirements", sourceJobId: "canonical", sourcePlatform: "Fixture", sourceUrl: originalUrl }, AT);
  const normalized = normalizeOpportunityUrl(originalUrl);
  assert.equal(job.sourceUrl, normalized);
  assert.equal(opportunityDecisionCareerJob(job).sourceUrl, originalUrl);
  let next = captureOpportunityDecision(library, job.id, { total: 1, supported: 0, partial: 0, independentRetests: [] }, undefined, AT);
  const receipt = next.jobs[0]!.decisions![0]!;
  next = updateOpportunity(next, job.id, { sourceUrl: normalized, salaryText: "Updated" }, LATER);
  assert.equal(opportunityDecisionCareerJob(next.jobs[0]!).sourceUrl, originalUrl);
  next = updateOpportunity(next, job.id, { sourceUrl: "https://example.invalid/job?z=3" }, LATER);
  assert.equal(opportunityDecisionCareerJob(next.jobs[0]!).sourceUrl, "https://example.invalid/job?z=3");
  const replay = importOpportunityJson(exportOpportunityJson(next));
  assert.equal(opportunityDecisionCareerJob(opportunityDecisionSnapshotJob(replay.jobs[0]!, receipt)).sourceUrl, originalUrl);
  const corrupted = JSON.parse(exportOpportunityJson(replay));
  corrupted.jobs[0].careerSourceUrl = "https://other.invalid/unrelated";
  assert.throws(() => importOpportunityJson(JSON.stringify(corrupted)), /来源.*不一致/);
});

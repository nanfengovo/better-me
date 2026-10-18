import assert from "node:assert/strict";
import test from "node:test";
import {
  addOpportunity, applicationFollowupQueues, createOpportunity, deleteApplicationCommunication,
  emptyOpportunityLibrary, exportOpportunitiesCsv, exportOpportunityJson, importOpportunityJson,
  MAX_APPLICATION_COMMUNICATIONS, opportunityDateTimeInput, parseOpportunityDateTimeInput,
  queryOpportunities, recordApplicationCommunication, updateApplication, updateOpportunity,
  type ApplicationStage, type OpportunityLibrary,
} from "../src/lib/opportunities.ts";

const AT = "2026-10-17T02:00:00.000Z"; // 10:00 Asia/Shanghai
const LATER = "2026-10-18T03:00:00.000Z";
const COMMUNICATION = { direction: "outbound" as const, method: "email" as const, occurredAt: "2026-10-17T01:00:00.000Z", contact: "招聘负责人", summary: "已发送项目说明，对方约定下周反馈。" };
function fixture() { return addOpportunity(emptyOpportunityLibrary(), { company: "示例公司", title: "工程师", sourceUrl: "https://example.com/jobs/1" }, AT).library; }

test("旧机会备份补充新字段默认值，阶段历史和原时间不改变", () => {
  const initial = fixture();
  const library = updateApplication(initial, initial.jobs[0]!.id, { stage: "interview", nextActionAt: LATER, notes: "已有面试笔记" }, { now: AT });
  const raw = JSON.parse(exportOpportunityJson(library));
  for (const key of ["channel", "contactName", "contactDetails", "communications"]) delete raw.jobs[0].application[key];
  delete raw.jobs[0].applicationDeadlineText;
  const restored = importOpportunityJson(JSON.stringify(raw));
  assert.deepEqual(restored.jobs[0]!.application, library.jobs[0]!.application);
  assert.equal(restored.jobs[0]!.firstDiscoveredAt, AT);
  assert.equal(restored.jobs[0]!.application.nextActionAt, LATER);
  assert.equal(restored.jobs[0]!.applicationDeadlineText, "");
});

test("截止日只接受明确日期；相对原文不会推导日期或关闭岗位", () => {
  const job = createOpportunity({ company: "A", title: "工程师", applicationDeadlineText: "招满即止，月底前优先" }, AT);
  assert.equal(job.applicationDeadlineText, "招满即止，月底前优先");
  assert.equal(job.applicationDeadlineDate, undefined);
  assert.equal(job.status, "unknown");
  for (const invalid of ["明天", "2026-02-29", "2026-10-32", "2026-10-17T12:00:00Z"]) {
    assert.throws(() => createOpportunity({ company: "A", title: "工程师", applicationDeadlineDate: invalid }, AT), /截止日期/);
  }
  const library = fixture();
  const changed = updateOpportunity(library, library.jobs[0]!.id, { applicationDeadlineDate: "2026-11-01", applicationDeadlineText: "2026年11月1日截止" }, AT);
  assert.equal(importOpportunityJson(exportOpportunityJson(changed)).jobs[0]!.applicationDeadlineDate, "2026-11-01");
  assert.equal(changed.jobs[0]!.application.stage, "saved");
});

test("联系人和申请渠道由手工更新，既不发起联系也不推断投递", () => {
  const library = fixture();
  const result = updateApplication(library, library.jobs[0]!.id, { stage: "saved", channel: "同事内推", contactName: "示例招聘经理", contactDetails: "用户自己填写的沟通方式", nextAction: "准备邮件草稿" }, { now: AT });
  const job = result.jobs[0]!;
  assert.equal(job.application.channel, "同事内推");
  assert.equal(job.application.contactName, "示例招聘经理");
  assert.deepEqual(job.application.communications, []);
  assert.equal(job.application.history.length, 1);
  assert.equal(job.application.submittedAt, undefined);
  assert.equal(queryOpportunities(result, { search: "招聘经理" }).length, 1);
  assert.equal(queryOpportunities(result, { search: "同事内推" }).length, 1);
  const restored = importOpportunityJson(exportOpportunityJson(result));
  assert.deepEqual(restored.jobs[0]!.application, job.application);
});

test("旧备份已投递但缺提交时间时仍能保存联系人，不补造日期；重新进入已投仍需确认", () => {
  const raw = JSON.parse(exportOpportunityJson(fixture()));
  raw.jobs[0].application.stage = "applied";
  raw.jobs[0].application.history[0].stage = "applied";
  const library = importOpportunityJson(JSON.stringify(raw));
  const id = library.jobs[0]!.id;
  const edited = updateApplication(library, id, { stage: "applied", contactName: "招聘负责人", notes: "旧记录补充联系人" }, { now: AT });
  assert.equal(edited.jobs[0]!.application.contactName, "招聘负责人");
  assert.equal(edited.jobs[0]!.application.submittedAt, undefined);
  assert.equal(edited.jobs[0]!.application.history.length, 1);
  const preparing = updateApplication(edited, id, { stage: "preparing" }, { now: AT });
  assert.throws(() => updateApplication(preparing, id, { stage: "applied" }, { now: AT }), /确认/);
});

test("沟通记录需要确认实际发生且不能填未来，不污染原库或阶段", () => {
  const library = fixture();
  const id = library.jobs[0]!.id;
  assert.throws(() => recordApplicationCommunication(library, id, COMMUNICATION, { now: AT }), /已实际发生/);
  assert.throws(() => recordApplicationCommunication(library, id, { ...COMMUNICATION, occurredAt: LATER }, { occurredConfirmed: true, now: AT }), /未来计划/);
  assert.throws(() => recordApplicationCommunication(library, id, { ...COMMUNICATION, occurredAt: "2026-10-17T09:00" }, { occurredConfirmed: true, now: AT }), /时区/);
  const result = recordApplicationCommunication(library, id, COMMUNICATION, { occurredConfirmed: true, now: AT });
  const entry = result.jobs[0]!.application.communications[0]!;
  assert.equal(entry.occurredAt, COMMUNICATION.occurredAt);
  assert.equal(entry.recordedAt, AT);
  assert.equal(result.jobs[0]!.application.stage, "saved");
  assert.equal(result.jobs[0]!.application.history.length, 1);
  assert.equal(result.jobs[0]!.application.submittedAt, undefined);
  assert.deepEqual(library.jobs[0]!.application.communications, []);
  assert.equal(queryOpportunities(result, { search: "下周反馈" }).length, 1);
});

test("实际沟通白名单和旧库兼容，未知字段不随JSON恢复，时间倒置被拒绝", () => {
  const library = fixture();
  const id = library.jobs[0]!.id;
  const recorded = recordApplicationCommunication(library, id, COMMUNICATION, { occurredConfirmed: true, now: AT });
  const raw = JSON.parse(exportOpportunityJson(recorded));
  raw.jobs[0].application.communications[0].apiKey = "should-drop";
  raw.jobs[0].application.secret = "should-drop";
  const imported = importOpportunityJson(JSON.stringify(raw));
  assert.equal(exportOpportunityJson(imported).includes("should-drop"), false);
  assert.deepEqual(imported.jobs[0]!.application.communications, recorded.jobs[0]!.application.communications);
  raw.jobs[0].application.communications[0].occurredAt = LATER;
  assert.throws(() => importOpportunityJson(JSON.stringify(raw)), /不能晚于/);
  const legacy = JSON.parse(exportOpportunityJson(recorded));
  for (const key of ["channel", "contactName", "contactDetails", "communications"]) delete legacy.jobs[0].application[key];
  delete legacy.jobs[0].applicationDeadlineText;
  delete legacy.jobs[0].applicationDeadlineDate;
  const old = importOpportunityJson(JSON.stringify(legacy)).jobs[0]!;
  assert.equal(old.application.channel, "");
  assert.equal(old.application.contactName, "");
  assert.equal(old.application.contactDetails, "");
  assert.deepEqual(old.application.communications, []);
  assert.deepEqual(old.application.history, library.jobs[0]!.application.history);
  assert.equal(old.firstDiscoveredAt, AT);
});

test("沟通删除只移除指定实际事件；超过200条明确拒绝，不截断旧历史", () => {
  let library = fixture();
  const id = library.jobs[0]!.id;
  library = recordApplicationCommunication(library, id, COMMUNICATION, { occurredConfirmed: true, now: AT });
  library = recordApplicationCommunication(library, id, { ...COMMUNICATION, direction: "inbound", summary: "已收到面试安排。" }, { occurredConfirmed: true, now: AT });
  const removed = deleteApplicationCommunication(library, id, library.jobs[0]!.application.communications[0]!.id, AT);
  assert.equal(removed.jobs[0]!.application.communications.length, 1);
  assert.equal(removed.jobs[0]!.application.communications[0]!.direction, "inbound");
  assert.equal(library.jobs[0]!.application.communications.length, 2);
  assert.throws(() => deleteApplicationCommunication(removed, id, "absent", AT), /不存在/);
  const raw = JSON.parse(exportOpportunityJson(library));
  raw.jobs[0].application.communications = Array.from({ length: MAX_APPLICATION_COMMUNICATIONS }, (_, index) => ({ ...raw.jobs[0].application.communications[0], id: `event-${index}` }));
  const full = importOpportunityJson(JSON.stringify(raw));
  assert.throws(() => recordApplicationCommunication(full, id, COMMUNICATION, { occurredConfirmed: true, now: AT }), /200/);
  assert.equal(full.jobs[0]!.application.communications.length, 200);
});

test("北京时间输入在UTC跨日前后往返一致，非法日期不会自动归一到另一日", () => {
  assert.equal(opportunityDateTimeInput("2026-10-16T16:30:00.000Z"), "2026-10-17T00:30");
  assert.equal(opportunityDateTimeInput("2026-10-17T15:59:00.000Z"), "2026-10-17T23:59");
  assert.equal(opportunityDateTimeInput("2026-10-17T00:30"), "2026-10-17T00:30");
  assert.equal(parseOpportunityDateTimeInput("2026-10-17T00:30"), "2026-10-16T16:30:00.000Z");
  assert.equal(parseOpportunityDateTimeInput(""), undefined);
  assert.equal(parseOpportunityDateTimeInput("2024-02-29T23:59"), "2024-02-29T15:59:00.000Z");
  for (const invalid of ["2026-02-29T10:00", "2026-10-17T24:00", "2026-10-17T12:60", "2026-10-17"]) assert.throws(() => parseOpportunityDateTimeInput(invalid));
});

test("只保存其他字段时保留原始时间秒数和时区表示，不让队列静默提前", () => {
  for (const original of ["2026-10-17T01:00:59.123Z", "2026-10-17T09:00:59+08:00", "2026-10-17T09:00:59", "2026-10-17"]) {
    assert.equal(parseOpportunityDateTimeInput(opportunityDateTimeInput(original), original), original);
  }
  assert.equal(parseOpportunityDateTimeInput("2026-10-17T09:01", "2026-10-17T01:00:59.123Z"), "2026-10-17T01:01:00.000Z");
  assert.equal(parseOpportunityDateTimeInput("", "2026-10-17T01:00:59.123Z"), undefined);
});

function queuesFixture(): OpportunityLibrary {
  let library = emptyOpportunityLibrary();
  for (const [title, stage, nextActionAt] of [
    ["昨天", "applied", "2026-10-16T15:30:00Z"],
    ["今天已过", "interview", "2026-10-17T01:30:00Z"],
    ["恰好到期", "offer", AT],
    ["今天稍后", "saved", "2026-10-17T15:59:00Z"],
    ["明天", "preparing", "2026-10-17T16:00:00Z"],
    ["失败不列入", "rejected", "2026-10-16T15:30:00Z"],
    ["撤回不列入", "withdrawn", "2026-10-16T15:30:00Z"],
    ["无时间", "interview", undefined],
  ] as const) {
    const added = addOpportunity(library, { company: "A", title }, AT);
    library = updateApplication(added.library, added.job.id, { stage: stage as ApplicationStage, nextAction: "跟进", nextActionAt }, { submittedConfirmed: true, now: AT });
  }
  return library;
}

test("队列按实际过期/北京时间今日/未来分组，Offer可跟进，终止阶段保留但排除", () => {
  const library = queuesFixture();
  const queues = applicationFollowupQueues(library.jobs, AT);
  assert.deepEqual(queues.overdue.map((job) => job.title), ["昨天", "今天已过"]);
  assert.deepEqual(queues.today.map((job) => job.title), ["恰好到期", "今天稍后"]);
  assert.deepEqual(queues.upcoming.map((job) => job.title), ["明天"]);
  assert.equal(library.jobs.length, 8);
  const tomorrow = applicationFollowupQueues(library.jobs, "2026-10-17T16:00:00Z");
  assert.deepEqual(tomorrow.today.map((job) => job.title), ["明天"]);
  assert.equal(tomorrow.overdue.length, 4);
});

test("队列使用传入筛选结果，旧无时区时间按北京时间，截止日不冒充跟进提醒", () => {
  let library = fixture();
  const id = library.jobs[0]!.id;
  library = updateOpportunity(library, id, { applicationDeadlineDate: "2026-10-17" }, AT);
  assert.deepEqual(applicationFollowupQueues(library.jobs, AT), { overdue: [], today: [], upcoming: [] });
  library = updateApplication(library, id, { stage: "saved", nextActionAt: "2026-10-17T11:00" }, { now: AT });
  assert.equal(applicationFollowupQueues(library.jobs, AT).today.length, 1);
  assert.deepEqual(applicationFollowupQueues(queryOpportunities(library, { market: "overseas" }), AT), { overdue: [], today: [], upcoming: [] });
});

test("CSV保留截止原文/联系人/实际事件，用户字段公式前缀继续转义", () => {
  let library = fixture();
  const id = library.jobs[0]!.id;
  library = updateOpportunity(library, id, { applicationDeadlineText: "招满即止", applicationDeadlineDate: "2026-11-01" }, AT);
  library = updateApplication(library, id, { stage: "saved", channel: "官网", contactName: "=HYPERLINK(1)", contactDetails: "+123" }, { now: AT });
  library = recordApplicationCommunication(library, id, COMMUNICATION, { occurredConfirmed: true, now: AT });
  const csv = exportOpportunitiesCsv(library.jobs);
  assert.ok(csv.includes('"申请截止原文"'));
  assert.ok(csv.includes('"实际沟通记录JSON"'));
  assert.ok(csv.includes('"招满即止","2026-11-01","官网","\'=HYPERLINK(1)","\'+123"'));
  assert.ok(csv.includes("已发送项目说明"));
  assert.ok(csv.includes('""occurredAt""'));
});

import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryPlan, deliveryAttention, deliveryIsCurrent, deliveryPlatform, parseDeliveryPlans, transitionDelivery, type DeliveryInput } from "../src/lib/domestic-delivery.ts";
import { addOpportunity, commandOpportunityDelivery, deleteOpportunityMaterial, emptyOpportunityLibrary, exportOpportunityJson, importOpportunityJson, prepareOpportunityDelivery, recordOpportunityMaterial, saveOpportunityLibrary, updateOpportunity } from "../src/lib/opportunities.ts";

const AT = "2026-11-05T01:00:00.000Z";
const LATER = "2026-11-05T02:00:00.000Z";
const INPUT: DeliveryInput = { platform: "boss", action: "greeting", account: "本人测试号", recipient: "示例招聘负责人", materialId: "", onlineResume: "", attachments: "", message: "希望进一步了解岗位。" };
function fixture() {
  const library = addOpportunity(emptyOpportunityLibrary(), { company: "合成企业", title: "合成工程师", description: "虚构岗位，仅用于回归。", sourceUrl: "https://www.zhipin.com/job_detail/synthetic.html", sourcePlatform: "BOSS" }, AT).library;
  return { library, job: library.jobs[0]! };
}
function drafted(input = INPUT) { const { job } = fixture(); const plans = createDeliveryPlan(job, input, [], AT); return { job, plans, id: plans[0]!.id }; }
function reviewed() { const data = drafted(); return { ...data, plans: transitionDelivery(data.plans, data.id, data.job, { kind: "review", confirmed: true }, LATER) }; }
function receipt(outcome: "confirmed" | "not_sent" | "outcome_unknown" = "confirmed") { return { kind: "receipt" as const, confirmed: true, receipt: { outcome, basis: "personal_confirmation" as const, note: "合成回执：本人核实", occurredAt: LATER } }; }

test("只接受三家官方 HTTPS 域名，拒绝仿冒、明文、凭据和非标准端口", () => {
  for (const [url, expected] of [["https://www.zhipin.com/job_detail/1", "boss"], ["https://jobs.51job.com/a", "51job"], ["https://www.liepin.com/job/1", "liepin"]]) assert.equal(deliveryPlatform(url!), expected);
  for (const url of ["https://zhipin.com.evil.example/a", "https://evilzhipin.com/a", "http://zhipin.com/a", "https://user:pass@zhipin.com/a", "https://zhipin.com:444/a", "javascript:alert(1)", "https://zhipin.co/api.htm"]) assert.equal(deliveryPlatform(url), undefined);
});
test("保存只生成草稿，不推断已发送、已投递或自动化授权", () => {
  const { library, job } = fixture();
  const next = prepareOpportunityDelivery(library, job.id, INPUT, AT);
  assert.equal(next.jobs[0]!.deliveryPlans![0]!.status, "draft");
  assert.equal(next.jobs[0]!.application.stage, "saved");
  assert.equal(next.jobs[0]!.application.submittedAt, undefined);
  assert.equal(library.jobs[0]!.deliveryPlans, undefined);
});
test("平台必须与实际申请 URL 一致，不按来源标签猜测", () => {
  const { job } = fixture();
  assert.throws(() => createDeliveryPlan(job, { ...INPUT, platform: "51job" }, [], AT), /平台一致/);
  assert.throws(() => createDeliveryPlan({ ...job, applicationUrl: "https://evil.example/apply" }, INPUT, [], AT), /平台一致/);
});
test("共享简历和申请要求不可变材料、在线版本及附件范围", () => {
  const { job } = fixture();
  assert.throws(() => createDeliveryPlan(job, { ...INPUT, action: "share_resume" }, [], AT), /材料快照/);
  const snapshot = { id: "material-1", resumeName: "合成简历", resumeUpdatedAt: AT, markdown: "# 合成内容" };
  const input = { ...INPUT, action: "application" as const, materialId: snapshot.id, onlineResume: "在线版本A", attachments: "无" };
  const result = createDeliveryPlan({ ...job, materials: [snapshot] }, input, [], AT);
  snapshot.markdown = "后来修改";
  assert.equal(result[0]!.materialSnapshot!.markdown, "# 合成内容");
  assert.throws(() => createDeliveryPlan({ ...job, materials: [snapshot] }, { ...input, onlineResume: "" }, [], AT), /在线简历/);
  assert.throws(() => createDeliveryPlan({ ...job, materials: [snapshot] }, { ...input, attachments: "" }, [], AT), /分享范围/);
});
test("核对要求独立确认；未经核对不能跳到发送结果", () => {
  const { job, plans, id } = drafted();
  assert.throws(() => transitionDelivery(plans, id, job, { kind: "review", confirmed: false }, LATER), /重新核对/);
  assert.throws(() => transitionDelivery(plans, id, job, receipt(), LATER), /未核对/);
  assert.throws(() => transitionDelivery(plans, id, job, { kind: "handoff" }, LATER), /未准备/);
});
test("岗位或链接变化使原核对失效，同名但正文变化也拒绝", () => {
  const { job, plans, id } = reviewed();
  for (const patch of [{ company: "另一企业" }, { description: "不同职责" }, { sourceUrl: "https://zhipin.com/job_detail/2" }, { id: "other-job" }]) {
    const changed = { ...job, ...patch };
    assert.equal(deliveryIsCurrent(plans[0]!, changed), false);
    assert.throws(() => transitionDelivery(plans, id, changed, { kind: "handoff" }, LATER));
  }
});
test("材料删除使旧行动失效，但行动中的原材料快照保留", () => {
  const { library, job } = fixture();
  let next = recordOpportunityMaterial(library, job.id, { resumeViewId: "view", resumeName: "合成简历", resumeUpdatedAt: AT, markdown: "合成快照", locale: "zh" }, AT);
  const materialId = next.jobs[0]!.materials[0]!.id;
  next = prepareOpportunityDelivery(next, job.id, { ...INPUT, action: "share_resume", materialId, onlineResume: "无", attachments: "合成.pdf v1" }, AT);
  next = deleteOpportunityMaterial(next, job.id, materialId, LATER);
  assert.equal(deliveryIsCurrent(next.jobs[0]!.deliveryPlans![0]!, next.jobs[0]!), false);
  assert.equal(next.jobs[0]!.deliveryPlans![0]!.materialSnapshot!.markdown, "合成快照");
});
test("打开平台只进入待核实，不推断沟通或已申请", () => {
  const { library, job } = fixture();
  let next = prepareOpportunityDelivery(library, job.id, INPUT, AT);
  const id = next.jobs[0]!.deliveryPlans![0]!.id;
  next = commandOpportunityDelivery(next, job.id, id, { kind: "review", confirmed: true }, LATER);
  next = commandOpportunityDelivery(next, job.id, id, { kind: "handoff" }, LATER);
  assert.equal(next.jobs[0]!.deliveryPlans![0]!.status, "handed_off");
  assert.equal(next.jobs[0]!.application.stage, "saved");
  assert.deepEqual(next.jobs[0]!.application.communications, []);
});
test("同账号同对象同动作待处理时拒绝重复排队，换材料不能绕过", () => {
  const { job, plans } = drafted();
  assert.throws(() => createDeliveryPlan(job, { ...INPUT, message: "不同文案", materialId: "another" }, plans, LATER), /不要重复排队/);
  assert.equal(createDeliveryPlan(job, { ...INPUT, recipient: "另一招聘者" }, plans, LATER).length, 2);
});
test("结果不明进入站内待办并阻止重发；确认未发后才可重新准备", () => {
  const { job, plans, id } = reviewed();
  const unknown = transitionDelivery(plans, id, job, receipt("outcome_unknown"), LATER);
  assert.equal(deliveryAttention([{ ...job, deliveryPlans: unknown }])[0]!.kind, "unknown");
  assert.throws(() => transitionDelivery(unknown, id, job, { kind: "cancel" }, LATER), /先核实/);
  assert.throws(() => createDeliveryPlan(job, INPUT, unknown, LATER), /不要重复排队/);
  const unsent = transitionDelivery(unknown, id, job, receipt("not_sent"), LATER);
  assert.equal(unsent[0]!.receipts.length, 2);
  assert.equal(createDeliveryPlan(job, INPUT, unsent, LATER).length, 2);
  assert.deepEqual(deliveryAttention([{ ...job, deliveryPlans: unsent }]), []);
});
test("成功的发招呼回执不等于投递，历史未知回执不被覆盖", () => {
  const { job, plans, id } = reviewed();
  const unknown = transitionDelivery(plans, id, job, receipt("outcome_unknown"), LATER);
  const done = transitionDelivery(unknown, id, job, receipt(), LATER);
  assert.equal(done[0]!.action, "greeting");
  assert.equal(done[0]!.status, "confirmed");
  assert.deepEqual(done[0]!.receipts.map(item => item.outcome), ["outcome_unknown", "confirmed"]);
  assert.throws(() => transitionDelivery(done, id, job, receipt(), LATER), /已结束/);
  assert.throws(() => createDeliveryPlan(job, INPUT, done, LATER), /不要重复排队/);
});
test("回执要求当次确认、说明、明确时区且不能使用未来时间", () => {
  const { job, plans, id } = reviewed();
  assert.throws(() => transitionDelivery(plans, id, job, { ...receipt(), confirmed: false }, LATER), /确认实际/);
  for (const patch of [{ note: "" }, { occurredAt: "2026-11-06T00:00:00Z" }, { occurredAt: "2026-11-05T09:00" }, { basis: "model_guess" }]) assert.throws(() => transitionDelivery(plans, id, job, { ...receipt(), receipt: { ...receipt().receipt, ...patch } } as ReturnType<typeof receipt>, LATER));
});
test("导入拒绝状态伪造、串岗位、重复编号和错误顺序", () => {
  const { library, job } = fixture();
  const saved = prepareOpportunityDelivery(library, job.id, INPUT, AT);
  const plan = saved.jobs[0]!.deliveryPlans![0]!;
  for (const invalid of [{ ...plan, status: "confirmed" }, { ...plan, status: "ready" }, { ...plan, status: "handed_off", reviewedAt: LATER }, { ...plan, reviewedAt: "2026-11-04T00:00:00Z" }]) assert.throws(() => parseDeliveryPlans([invalid]));
  assert.throws(() => parseDeliveryPlans([plan, plan]), /编号重复/);
  const wrongJob = structuredClone(saved); wrongJob.jobs[0]!.deliveryPlans![0]!.jobId = "wrong";
  assert.throws(() => importOpportunityJson(JSON.stringify(wrongJob)), /不属于/);
});
test("旧 JSON 不需要迁移，新行动和回执完整往返，原来源和阶段不变", () => {
  const { library, job } = fixture();
  assert.deepEqual(importOpportunityJson(exportOpportunityJson(library)), library);
  assert.equal(library.schemaVersion, 1);
  let next = prepareOpportunityDelivery(library, job.id, INPUT, AT);
  assert.equal(next.schemaVersion, 2, "Old clients must reject v2 instead of dropping action cards");
  next = commandOpportunityDelivery(next, job.id, next.jobs[0]!.deliveryPlans![0]!.id, { kind: "review", confirmed: true }, LATER);
  assert.deepEqual(importOpportunityJson(exportOpportunityJson(next)), next);
  assert.equal(next.jobs[0]!.collectedAt, AT);
  assert.equal(next.jobs[0]!.application.stage, "saved");
  assert.equal(importOpportunityJson(JSON.stringify({ ...next, jobs: [] })).schemaVersion, 2, "Deleting the final job must not downgrade storage");
});
test("站内待办派生自完整库，不触发通知或访问外站", () => {
  const { job, plans, id } = reviewed();
  assert.deepEqual(deliveryAttention([{ ...job, deliveryPlans: plans }]), []);
  assert.equal(deliveryAttention([{ ...job, title: "已变更", deliveryPlans: plans }])[0]!.kind, "stale");
  const handedOff = transitionDelivery(plans, id, job, { kind: "handoff" }, LATER);
  assert.equal(deliveryAttention([{ ...job, deliveryPlans: handedOff }])[0]!.kind, "verify");
});
test("操作被限定在当前岗位，旧对象不能更改另一岗位的行动", () => {
  const { library, job } = fixture();
  const prepared = prepareOpportunityDelivery(library, job.id, INPUT, AT);
  const other = addOpportunity(prepared, { company: "另一合成公司", title: "其他岗位" }, AT).library;
  assert.throws(() => commandOpportunityDelivery(other, other.jobs[0]!.id, prepared.jobs[0]!.deliveryPlans![0]!.id, { kind: "review", confirmed: true }, LATER), /不存在/);
});
test("取消草稿保留历史，准备卡上限是资源限制而不是安全发送配额", () => {
  const { job, plans, id } = drafted();
  const cancelled = transitionDelivery(plans, id, job, { kind: "cancel" }, LATER);
  assert.equal(cancelled[0]!.status, "cancelled");
  let many = cancelled;
  for (let index = 1; index < 20; index++) many = createDeliveryPlan(job, { ...INPUT, recipient: `合成对象${index}` }, many, LATER);
  assert.throws(() => createDeliveryPlan(job, { ...INPUT, recipient: "第21个" }, many, LATER), /上限/);
});
test("仍沿用机会库 CAS，多窗口旧版本不能覆盖新行动", () => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  const { library, job } = fixture();
  const saved = saveOpportunityLibrary(library);
  const branch = prepareOpportunityDelivery(saved, job.id, INPUT, AT);
  const latest = saveOpportunityLibrary(branch);
  assert.throws(() => saveOpportunityLibrary(updateOpportunity(saved, job.id, { title: "旧窗口" }, LATER)), /另一个窗口/);
  assert.equal(latest.jobs[0]!.deliveryPlans!.length, 1);
  assert.equal(saved.jobs[0]!.deliveryPlans, undefined);
});

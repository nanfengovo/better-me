/** Personal preparation and manual receipts only. This module never sends or controls a device. */
export const DELIVERY_PLATFORMS = ["boss", "51job", "liepin"] as const;
export const DELIVERY_ACTIONS = ["greeting", "share_resume", "application"] as const;
export const DELIVERY_STATUSES = ["draft", "ready", "handed_off", "outcome_unknown", "confirmed", "not_sent", "cancelled"] as const;
export type DeliveryPlatform = typeof DELIVERY_PLATFORMS[number];
export type DeliveryAction = typeof DELIVERY_ACTIONS[number];
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
export type DeliveryMaterial = { id: string; resumeName: string; resumeUpdatedAt: string; markdown: string };
export type DeliveryJob = { id: string; company: string; title: string; description: string; sourceUrl: string; applicationUrl: string; materials: DeliveryMaterial[] };
export type DeliveryInput = { platform: DeliveryPlatform; action: DeliveryAction; account: string; recipient: string; materialId: string; onlineResume: string; attachments: string; message: string };
export type DeliveryReceipt = { outcome: "confirmed" | "not_sent" | "outcome_unknown"; basis: "platform_record" | "personal_confirmation"; note: string; occurredAt: string; recordedAt: string };
export type DeliveryPlan = DeliveryInput & {
  id: string; jobId: string; company: string; title: string; url: string; targetSnapshot: string;
  materialSnapshot?: DeliveryMaterial; status: DeliveryStatus; createdAt: string; reviewedAt?: string; handedOffAt?: string;
  receipts: DeliveryReceipt[];
};
export const DELIVERY_LIMIT = 20;
const HOSTS: Record<DeliveryPlatform, string> = { boss: "zhipin.com", "51job": "51job.com", liepin: "liepin.com" };
const REPEATABLE = new Set<DeliveryStatus>(["not_sent", "cancelled"]);
const MAX_TIME = 8.64e15;

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${label}格式不正确或未填写。`);
  return value.trim();
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new Error(`${label}不受支持。`);
  return value as T;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("投递行动卡格式不正确。");
  return value as Record<string, unknown>;
}
function time(value: unknown): string {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Math.abs(Date.parse(value)) > MAX_TIME) throw new Error("投递时间必须有效且包含时区。");
  return new Date(value).toISOString();
}
export function deliveryPlatform(url: string): DeliveryPlatform | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return;
    return DELIVERY_PLATFORMS.find(platform => parsed.hostname === HOSTS[platform] || parsed.hostname.endsWith(`.${HOSTS[platform]}`));
  } catch { return; }
}
function officialUrl(value: unknown, platform: DeliveryPlatform): string {
  const result = text(value, "官方岗位链接", 4000, true);
  if (deliveryPlatform(result) !== platform) throw new Error("请选择与平台一致的 HTTPS 官方岗位链接；不支持短链或仿冒域名。");
  return result;
}
function targetSnapshot(job: DeliveryJob): string {
  return JSON.stringify([job.id, job.company, job.title, job.description, job.sourceUrl, job.applicationUrl]);
}
function material(value: unknown): DeliveryMaterial {
  const item = object(value);
  text(item.markdown, "简历快照", 120_000, true);
  return { id: text(item.id, "材料编号", 150, true), resumeName: text(item.resumeName, "简历名称", 300, true), resumeUpdatedAt: time(item.resumeUpdatedAt), markdown: item.markdown as string };
}
export function parseDeliveryPlans(value: unknown): DeliveryPlan[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DELIVERY_LIMIT) throw new Error(`每个岗位最多保留 ${DELIVERY_LIMIT} 张投递行动卡。`);
  const plans = value.map((entry): DeliveryPlan => {
    const item = object(entry);
    const platform = choice(item.platform, DELIVERY_PLATFORMS, "平台");
    const action = choice(item.action, DELIVERY_ACTIONS, "投递动作");
    const status = choice(item.status, DELIVERY_STATUSES, "投递状态");
    if (!Array.isArray(item.receipts) || item.receipts.length > 20) throw new Error("投递回执数量不正确。");
    const createdAt = time(item.createdAt);
    const reviewedAt = item.reviewedAt === undefined ? undefined : time(item.reviewedAt);
    const handedOffAt = item.handedOffAt === undefined ? undefined : time(item.handedOffAt);
    const receipts = item.receipts.map(value => {
      const receipt = object(value);
      const result: DeliveryReceipt = { outcome: choice(receipt.outcome, ["confirmed", "not_sent", "outcome_unknown"], "回执结果"), basis: choice(receipt.basis, ["platform_record", "personal_confirmation"], "回执依据"), note: text(receipt.note, "回执说明", 2000, true), occurredAt: time(receipt.occurredAt), recordedAt: time(receipt.recordedAt) };
      if (result.occurredAt > result.recordedAt || result.recordedAt < createdAt) throw new Error("投递回执时间顺序不正确。");
      return result;
    });
    if (receipts.some((receipt, index) => (index < receipts.length - 1 && receipt.outcome !== "outcome_unknown") || (index > 0 && receipt.recordedAt < receipts[index - 1]!.recordedAt))) throw new Error("已结束的回执不能继续追加或倒序覆盖。");
    if (status !== "draft" && status !== "cancelled" && !reviewedAt) throw new Error("未核对的行动卡不能成为已准备或已发送记录。");
    if (reviewedAt && reviewedAt < createdAt || handedOffAt && (!reviewedAt || handedOffAt < reviewedAt)) throw new Error("投递核对时间顺序不正确。");
    if (status === "handed_off" && !handedOffAt) throw new Error("待核实行动缺少打开平台的记录。");
    if (["confirmed", "not_sent", "outcome_unknown"].includes(status) && receipts.at(-1)?.outcome !== status) throw new Error("投递状态与最新回执不一致。");
    if ((status === "draft" || status === "ready" || status === "handed_off" || status === "cancelled") && receipts.length) throw new Error("待处理行动不能覆盖已有回执。");
    const materialSnapshot = item.materialSnapshot === undefined ? undefined : material(item.materialSnapshot);
    const materialId = text(item.materialId, "材料编号", 150);
    if (materialId && !materialSnapshot) throw new Error("所选材料快照不存在。");
    if (action !== "greeting" && (!materialSnapshot || materialSnapshot.id !== materialId)) throw new Error("共享简历或申请必须绑定材料快照。");
    if (materialSnapshot && materialSnapshot.id !== materialId) throw new Error("材料与快照不一致。");
    return { id: text(item.id, "行动编号", 150, true), jobId: text(item.jobId, "岗位编号", 150, true), company: text(item.company, "公司", 300, true), title: text(item.title, "岗位", 500, true), platform, action, status, url: officialUrl(item.url, platform), targetSnapshot: text(item.targetSnapshot, "岗位核对快照", 150_000, true), account: text(item.account, "平台账号标记", 200, true), recipient: text(item.recipient, "接收对象", 300, true), materialId, materialSnapshot, onlineResume: text(item.onlineResume, "在线简历版本", 500, action !== "greeting"), attachments: text(item.attachments, "平台附件与分享范围", 1000, action !== "greeting"), message: text(item.message, "待发文案", 5000), createdAt, reviewedAt, handedOffAt, receipts };
  });
  if (new Set(plans.map(plan => plan.id)).size !== plans.length) throw new Error("投递行动编号重复。");
  return plans;
}
export function createDeliveryPlan(job: DeliveryJob, input: DeliveryInput, plans: DeliveryPlan[], now = new Date().toISOString()): DeliveryPlan[] {
  const current = parseDeliveryPlans(plans);
  if (current.length >= DELIVERY_LIMIT) throw new Error(`已达 ${DELIVERY_LIMIT} 张行动卡上限，请先导出备份。`);
  if (current.some(plan => plan.jobId === job.id && plan.platform === input.platform && plan.account.trim() === input.account.trim() && plan.recipient.trim() === input.recipient.trim() && plan.action === input.action && !REPEATABLE.has(plan.status))) throw new Error("已有同对象同动作的已完成或待处理行动。请先核实原结果，不要重复排队。");
  const source = job.materials.find(item => item.id === input.materialId);
  const plan: DeliveryPlan = { ...input, id: crypto.randomUUID(), jobId: job.id, company: job.company, title: job.title, url: officialUrl(job.applicationUrl || job.sourceUrl, input.platform), targetSnapshot: targetSnapshot(job), ...(source ? { materialSnapshot: material(source) } : {}), status: "draft", createdAt: time(now), receipts: [] };
  return parseDeliveryPlans([...current, plan]);
}
export function deliveryIsCurrent(plan: DeliveryPlan, job: DeliveryJob): boolean {
  if (plan.jobId !== job.id || plan.targetSnapshot !== targetSnapshot(job)) return false;
  if (!plan.materialSnapshot) return !plan.materialId;
  const found = job.materials.find(item => item.id === plan.materialId);
  return !!found && JSON.stringify(material(found)) === JSON.stringify(plan.materialSnapshot);
}
export type DeliveryCommand = { kind: "review"; confirmed: boolean } | { kind: "handoff" } | { kind: "cancel" } | { kind: "receipt"; confirmed: boolean; receipt: Omit<DeliveryReceipt, "recordedAt"> };
export function transitionDelivery(plans: DeliveryPlan[], id: string, job: DeliveryJob, command: DeliveryCommand, now = new Date().toISOString()): DeliveryPlan[] {
  const current = parseDeliveryPlans(plans);
  const plan = current.find(item => item.id === id);
  if (!plan || plan.jobId !== job.id) throw new Error("投递行动不存在或不属于当前岗位。");
  const at = time(now);
  if (at < plan.createdAt) throw new Error("操作时间不能早于行动创建时间。");
  let next: DeliveryPlan;
  if (command.kind === "review") {
    if (plan.status !== "draft" || !command.confirmed || !deliveryIsCurrent(plan, job)) throw new Error("请重新核对当前岗位、账号、接收对象和简历；旧核对不能复用。");
    next = { ...plan, status: "ready", reviewedAt: at };
  } else if (command.kind === "handoff") {
    if (plan.status !== "ready" || !deliveryIsCurrent(plan, job)) throw new Error("行动未准备或岗位/材料已变更，请取消旧行动并重新准备。");
    next = { ...plan, status: "handed_off", handedOffAt: at };
  } else if (command.kind === "cancel") {
    if (plan.status !== "draft" && plan.status !== "ready") throw new Error("已打开平台或结果不明的行动必须先核实，不能用取消掩盖可能已发送的结果。");
    next = { ...plan, status: "cancelled" };
  } else {
    if (!command.confirmed || !["ready", "handed_off", "outcome_unknown"].includes(plan.status)) throw new Error("请确认实际结果；未核对或已结束的行动不能补造发送回执。");
    next = { ...plan, status: command.receipt.outcome, receipts: [...plan.receipts, { ...command.receipt, recordedAt: at }] };
  }
  return parseDeliveryPlans(current.map(item => item.id === id ? next : item));
}
export function deliveryAttention(jobs: Array<DeliveryJob & { deliveryPlans?: DeliveryPlan[] }>): Array<{ jobId: string; planId: string; kind: "unknown" | "verify" | "stale"; title: string }> {
  return jobs.flatMap(job => (job.deliveryPlans ?? []).flatMap(plan => {
    const kind = plan.status === "outcome_unknown" ? "unknown" : plan.status === "handed_off" ? "verify" : plan.status === "ready" && !deliveryIsCurrent(plan, job) ? "stale" : undefined;
    return kind ? [{ jobId: job.id, planId: plan.id, kind, title: `${plan.company} · ${plan.title}` }] : [];
  }));
}

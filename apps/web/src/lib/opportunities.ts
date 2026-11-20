import { careerJobSnapshotVersion, type CareerTrainingJob } from "@better-me/agent-contracts";
import { privateStorage as localStorage } from "./private-storage";

import { createDeliveryPlan, parseDeliveryPlans, transitionDelivery, type DeliveryCommand, type DeliveryInput, type DeliveryPlan } from "./domestic-delivery";

/** Local opportunity records. Importing/opening a link never submits an application. */
export const OPPORTUNITY_STORAGE_KEY = "betterme.opportunities.v1";
export const OPPORTUNITY_RECOVERY_KEY = "betterme.opportunities-recovery.v1";
export const OPPORTUNITY_STAGES = ["saved", "evaluating", "preparing", "applied", "interview", "offer", "rejected", "withdrawn"] as const;
export const OPPORTUNITY_MARKETS = ["domestic", "overseas", "unknown"] as const;
export const OPPORTUNITY_STATUSES = ["open", "closed", "unknown"] as const;
export type ApplicationStage = typeof OPPORTUNITY_STAGES[number];
export type OpportunityMarket = typeof OPPORTUNITY_MARKETS[number];
export type OpportunityStatus = typeof OPPORTUNITY_STATUSES[number];
export type WorkMode = "on-site" | "hybrid" | "remote" | "unknown";
export type PublisherType = "company" | "recruiter" | "agency" | "unknown";
export type EmploymentType = "social" | "campus" | "internship" | "unknown";
export type VerificationMethod = "source-read" | "manual" | "unknown";
export const OPPORTUNITY_ACTIONS = ["apply", "collect-evidence", "practice", "other"] as const;
export const FEEDBACK_KINDS = ["unobserved", "reported", "interpretation"] as const;
export type OpportunityRetestRef = { kitId: string; questionVersion: string; capabilityId: string; sourceVersion: string; completedAt?: string; result: "met" | "missed" | "recorded" };
export type OpportunityDecisionEvidence = { supported: number; partial: number; total: number; independentRetests: OpportunityRetestRef[] };
export type OpportunityOfficialVersion = { documentId: string; versionId: string; contentHash: string };
export const OPPORTUNITY_OUTCOMES = ["positive", "negative", "neutral", "unknown"] as const;
export type OpportunityOutcome = typeof OPPORTUNITY_OUTCOMES[number];
const DECISION_ACTIONS = ["apply", "collect-evidence", "practice"] as const;
const DECISION_REASONS = ["verified-requirements", "missing-evidence", "retest-gap", "unreviewed-retest", "closed-opportunity", "unverified-opportunity"] as const;
export type OpportunityDecisionReceipt = {
  id: string; policyVersion: 1; jdSnapshotId: string; jobVersion: string; status: OpportunityStatus; createdAt: string;
  action: typeof DECISION_ACTIONS[number]; reasonCode: typeof DECISION_REASONS[number];
  evidence: OpportunityDecisionEvidence; officialVersion?: OpportunityOfficialVersion;
};
/** A user-authorized detached record, containing only bounded categorical values. */
export type OpportunityEvaluationSample = {
  schemaVersion: 1; recommendedAction: OpportunityDecisionReceipt["action"]; actualAction: typeof OPPORTUNITY_ACTIONS[number];
  outcome: OpportunityOutcome; corrected: boolean; independentRetest: "met" | "missed" | "unreviewed" | "unknown";
};
export type OpportunityEventReview = {
  action: typeof OPPORTUNITY_ACTIONS[number]; reason: string; feedback: typeof FEEDBACK_KINDS[number];
  observation: string; materialId?: string; reviewedAt: string;
  outcome?: OpportunityOutcome; feedbackCommunicationId?: string; afterEvidence?: OpportunityDecisionEvidence; officialVersion?: OpportunityOfficialVersion;
};
type EventContext = { jdSnapshotId?: string; review?: OpportunityEventReview };
type JobDescriptionSnapshot = { id: string; title: string; company: string; description: string; sourceUrl: string; capturedAt: string; sourcePlatform?: string; sourceJobId?: string; careerSourceUrl?: string };
export type OpportunityActionRecord = { id: string; occurredAt: string; jdSnapshotId: string; decisionId: string; sourceEvent?: {kind: "stage" | "communication"; id: string}; review: OpportunityEventReview; previousReviews?: OpportunityEventReview[]; evaluationSample?: OpportunityEvaluationSample };
export type ApplicationHistoryEntry = EventContext & { id: string; stage: ApplicationStage; changedAt: string; notes: string };
export const COMMUNICATION_METHODS = ["email", "phone", "platform", "video", "in-person", "other"] as const;
export type ApplicationCommunication = EventContext & {
  id: string;
  direction: "outbound" | "inbound";
  method: typeof COMMUNICATION_METHODS[number];
  occurredAt: string;
  contact: string;
  summary: string;
  recordedAt: string;
};
export type OpportunityMaterial = {
  id: string;
  resumeViewId: string;
  resumeName: string;
  resumeUpdatedAt: string;
  locale: "zh" | "en";
  markdown: string;
  officialVersion?: OpportunityOfficialVersion;
  createdAt: string;
};
export type OpportunityApplication = {
  stage: ApplicationStage;
  notes: string;
  nextAction: string;
  nextActionAt?: string;
  submittedAt?: string;
  channel: string;
  contactName: string;
  contactDetails: string;
  communications: ApplicationCommunication[];
  history: ApplicationHistoryEntry[];
  actions?: OpportunityActionRecord[];
};
export type Opportunity = {
  id: string;
  company: string;
  title: string;
  description: string;
  sourceUrl: string;
  /** Exact source identity used by the Agent, before opportunity URL normalization. */
  careerSourceUrl?: string;
  applicationUrl: string;
  discoveryUrl: string;
  sourcePlatform: string;
  publisherType: PublisherType;
  market: OpportunityMarket;
  workMode: WorkMode;
  location: { country: string; region: string; city: string };
  remoteEligibleRegions: string[];
  salaryText: string;
  employmentType: EmploymentType;
  sourceJobId?: string;
  sourcePublishedText?: string;
  sourcePublishedAt?: string;
  sourceUpdatedAt?: string;
  applicationDeadlineText: string;
  applicationDeadlineDate?: string;
  firstDiscoveredAt: string;
  collectedAt: string;
  lastVerifiedAt?: string;
  lastVerificationMethod?: VerificationMethod;
  status: OpportunityStatus;
  application: OpportunityApplication;
  materials: OpportunityMaterial[];
  jdSnapshots?: JobDescriptionSnapshot[];
  decisions?: OpportunityDecisionReceipt[];
  deliveryPlans?: DeliveryPlan[];
  createdAt: string;
  updatedAt: string;
};
export type OpportunityLibrary = { schemaVersion: 1 | 2 | 3 | 4; revision: number; updatedAt: string; jobs: Opportunity[] };
export type OpportunityInput = Pick<Opportunity, "company" | "title"> & Partial<Omit<Opportunity, "id" | "company" | "title" | "application" | "materials" | "jdSnapshots" | "decisions" | "careerSourceUrl" | "createdAt" | "updatedAt">>;
export type OpportunityPatch = Partial<Omit<Opportunity, "id" | "application" | "materials" | "jdSnapshots" | "decisions" | "careerSourceUrl" | "createdAt" | "updatedAt">>;
export type OpportunityFilters = {
  search?: string;
  market?: OpportunityMarket | "all";
  stage?: ApplicationStage | "all";
  status?: OpportunityStatus | "all";
  workMode?: WorkMode | "all";
  employmentType?: EmploymentType | "all";
  sourcePlatform?: string;
  country?: string;
  region?: string;
  city?: string;
};

const MAX_JOBS = 2_000;
export const MAX_OPPORTUNITY_MATERIALS = 30;
export const MAX_APPLICATION_COMMUNICATIONS = 200;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const EPOCH = "1970-01-01T00:00:00.000Z";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式不正确。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 1_000, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) throw new Error(`${label}为空、格式错误或超过长度限制。`);
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label}不受支持。`);
  return value as T;
}

function date(value: unknown, label: string, optional = false): string | undefined {
  if (optional && (value === undefined || value === "")) return undefined;
  const result = text(value, label, 40, true);
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(result);
  if (!parts || !Number.isFinite(Date.parse(result))) throw new Error(`${label}不是有效日期。`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error(`${label}不是有效日期。`);
  return result;
}

function currentTime(now?: string): string {
  return date(now ?? new Date().toISOString(), "记录时间")!;
}

function dateOnly(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("申请截止日期必须是明确的年-月-日；相对日期请保留原文。");
  return date(value, "申请截止日期");
}

/** Legacy timezone-less records are interpreted as Asia/Shanghai, never as the host timezone. */
function shanghaiEpoch(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value}+08:00` : value);
}

export function opportunityDateTimeInput(value?: string, precision: "minute" | "second" = "minute"): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(precision === "second" ? { second: "2-digit" as const } : {}), hourCycle: "h23" }).formatToParts(shanghaiEpoch(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}${precision === "second" ? `:${part("second")}` : ""}`;
}

/** Unchanged minute-only UI values retain their original seconds/precision and source representation. */
export function parseOpportunityDateTimeInput(value: string, originalValue?: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) throw new Error("请填写有效的北京时间。");
  date(value, "北京时间");
  const precision = value.length > 16 ? "second" : "minute";
  if (originalValue && value === opportunityDateTimeInput(originalValue, precision)) return originalValue;
  return new Date(`${value}${precision === "minute" ? ":00" : ""}+08:00`).toISOString();
}

export type ApplicationFollowupQueues = { overdue: Opportunity[]; today: Opportunity[]; upcoming: Opportunity[] };
/** The same filtered records feed all queues. Offers may still need negotiation; only rejected/withdrawn are terminal. */
export function applicationFollowupQueues(jobs: Opportunity[], now = new Date().toISOString()): ApplicationFollowupQueues {
  const nowAt = shanghaiEpoch(currentTime(now));
  const today = opportunityDateTimeInput(now).slice(0, 10);
  const queues: ApplicationFollowupQueues = { overdue: [], today: [], upcoming: [] };
  for (const job of jobs) {
    const next = job.application.nextActionAt;
    if (!next || ["rejected", "withdrawn"].includes(job.application.stage)) continue;
    const key = shanghaiEpoch(next) < nowAt ? "overdue" : opportunityDateTimeInput(next).slice(0, 10) === today ? "today" : "upcoming";
    queues[key].push(job);
  }
  for (const group of Object.values(queues)) group.sort((a, b) => shanghaiEpoch(a.application.nextActionAt!) - shanghaiEpoch(b.application.nextActionAt!) || a.id.localeCompare(b.id));
  return queues;
}

/** Only tracking parameters are removed; job identity query parameters remain. */
export function normalizeOpportunityUrl(value: string): string {
  if (!value.trim()) return "";
  text(value, "岗位链接", 8_000);
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("岗位链接格式不正确，请使用完整 HTTP 或 HTTPS 链接。"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("岗位链接仅支持不含账户密码的 HTTP 或 HTTPS 地址。");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|trk|trackingId|refId)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function url(value: unknown, label: string): string {
  return normalizeOpportunityUrl(text(value, label, 8_000));
}

function exactCareerSourceUrl(value: unknown, normalizedUrl: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const original = text(value, "岗位原始来源链接", 8000, true);
  if (normalizeOpportunityUrl(original) !== normalizedUrl) throw new Error("岗位原始来源与当前链接不一致。");
  return original === normalizedUrl ? undefined : original;
}
function parseDigest(value: unknown, label: string): string {
  const result = text(value, label, 64, true);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}无效。`);
  return result;
}
function parseOfficialVersion(value: unknown): OpportunityOfficialVersion {
  const row = record(value, "正式简历版本");
  return { documentId: text(row.documentId, "文档编号", 400, true), versionId: text(row.versionId, "正式版本编号", 200, true), contentHash: parseDigest(row.contentHash, "正式内容摘要") };
}
function parseEvidence(value: unknown): OpportunityDecisionEvidence {
  const row = record(value, "建议依据");
  function count(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error("岗位要求统计无效。");
    return value;
  }
  const total = count(row.total), supported = count(row.supported), partial = count(row.partial);
  if (supported + partial > total || !Array.isArray(row.independentRetests) || row.independentRetests.length > 200) throw new Error("建议依据的要求或复测统计无效。");
  const independentRetests = row.independentRetests.map(entry => {
    const ref = record(entry, "独立复测");
    return { kitId: text(ref.kitId, "训练编号", 150, true), questionVersion: parseDigest(ref.questionVersion, "题目版本"), capabilityId: parseDigest(ref.capabilityId, "能力编号"), sourceVersion: parseDigest(ref.sourceVersion, "复测版本"), ...(ref.completedAt === undefined ? {} : { completedAt: date(ref.completedAt, "复测完成时间")! }), result: choice(ref.result, ["met", "missed", "recorded"] as const, "复测结果") };
  });
  if (new Set(independentRetests.map(ref => JSON.stringify([ref.kitId, ref.questionVersion, ref.capabilityId, ref.sourceVersion]))).size !== independentRetests.length) throw new Error("独立复测依据重复。");
  return { supported, partial, total, independentRetests };
}

/** A later independent retest supersedes the prior result for the same capability. */
function latestRetests(refs: OpportunityRetestRef[]): OpportunityRetestRef[] {
  const groups = new Map<string, OpportunityRetestRef[]>();
  for (const ref of refs) groups.set(ref.capabilityId, [...groups.get(ref.capabilityId) ?? [], ref]);
  return [...groups.values()].flatMap(group => {
    if (group.some(ref => !ref.completedAt)) return group;
    const latest = Math.max(...group.map(ref => shanghaiEpoch(ref.completedAt!)));
    return group.filter(ref => shanghaiEpoch(ref.completedAt!) === latest);
  });
}
export function recommendOpportunityAction(evidence: OpportunityDecisionEvidence, status: OpportunityStatus = "unknown"): Pick<OpportunityDecisionReceipt, "action" | "reasonCode"> {
  const assessment = parseEvidence(evidence);
  if (status === "closed") return { action: "collect-evidence", reasonCode: "closed-opportunity" };
  if (status === "unknown") return { action: "collect-evidence", reasonCode: "unverified-opportunity" };
  const latest = latestRetests(assessment.independentRetests);
  if (latest.some(ref => ref.result === "missed")) return { action: "practice", reasonCode: "retest-gap" };
  if (latest.some(ref => ref.result === "recorded")) return { action: "collect-evidence", reasonCode: "unreviewed-retest" };
  if (assessment.total > 0 && assessment.supported === assessment.total) return { action: "apply", reasonCode: "verified-requirements" };
  return { action: "collect-evidence", reasonCode: "missing-evidence" };
}

/** Exact career-job identity; manual records have no inferred upstream ID. */
export function opportunityDecisionCareerJob(job: Opportunity): CareerTrainingJob {
  return { id: job.sourceJobId || undefined, title: job.title, company: job.company, description: job.description, sourcePlatform: job.sourcePlatform === "手动录入" ? undefined : job.sourcePlatform, sourceUrl: job.careerSourceUrl || job.sourceUrl || undefined };
}
function snapshotVersion(snapshot: JobDescriptionSnapshot): string {
  // Decision receipts only use snapshots captured with the exact source platform.
  if (snapshot.sourcePlatform === undefined) throw new Error("建议缺少可核验的岗位版本。");
  return careerJobSnapshotVersion({ id: snapshot.sourceJobId || undefined, title: snapshot.title, company: snapshot.company, description: snapshot.description, sourcePlatform: snapshot.sourcePlatform === "手动录入" ? undefined : snapshot.sourcePlatform, sourceUrl: snapshot.careerSourceUrl || snapshot.sourceUrl || undefined });
}
export function opportunityDecisionSnapshotJob(job: Opportunity, decision: OpportunityDecisionReceipt): Opportunity {
  const snapshot = job.jdSnapshots?.find(row => row.id === decision.jdSnapshotId);
  if (!snapshot || !job.decisions?.some(row => row.id === decision.id) || snapshotVersion(snapshot) !== decision.jobVersion) throw new Error("建议与岗位版本不一致。");
  return { ...job, title: snapshot.title, company: snapshot.company, description: snapshot.description, sourcePlatform: snapshot.sourcePlatform!, sourceJobId: snapshot.sourceJobId, sourceUrl: snapshot.sourceUrl, careerSourceUrl: snapshot.careerSourceUrl, status: decision.status };
}
function parseDecision(value: unknown): OpportunityDecisionReceipt {
  const row = record(value, "岗位建议记录");
  if (row.policyVersion !== 1) throw new Error("历史建议规则版本不受支持。");
  const evidence = parseEvidence(row.evidence);
  const status = choice(row.status, OPPORTUNITY_STATUSES, "建议时的岗位状态");
  const createdAt = date(row.createdAt, "建议时间")!;
  if (evidence.independentRetests.some(ref => ref.completedAt && shanghaiEpoch(ref.completedAt) > shanghaiEpoch(createdAt))) throw new Error("历史建议包含尚未发生的独立复测。");
  const recommendation = recommendOpportunityAction(evidence, status);
  if (row.action !== recommendation.action || choice(row.reasonCode, DECISION_REASONS, "建议依据类型") !== recommendation.reasonCode) throw new Error("历史建议与所记录的依据不一致。");
  return { id: text(row.id, "建议号", 150, true), policyVersion: 1, jdSnapshotId: text(row.jdSnapshotId, "岗位版本编号", 150, true), jobVersion: parseDigest(row.jobVersion, "岗位版本摘要"), status, createdAt, evidence, ...recommendation,
    ...(row.officialVersion === undefined ? {} : { officialVersion: parseOfficialVersion(row.officialVersion) }) };
}
function parseEvaluationSample(value: unknown): OpportunityEvaluationSample {
  const row = record(value, "匿名评审样本");
  if (row.schemaVersion !== 1 || typeof row.corrected !== "boolean") throw new Error("匿名评审样本格式不正确。");
  return { schemaVersion: 1, recommendedAction: choice(row.recommendedAction, DECISION_ACTIONS, "建议行动"), actualAction: choice(row.actualAction, OPPORTUNITY_ACTIONS, "实际行动"), outcome: choice(row.outcome, OPPORTUNITY_OUTCOMES, "结果"), corrected: row.corrected, independentRetest: choice(row.independentRetest, ["met", "missed", "unreviewed", "unknown"], "独立复测") };
}
function parseReview(value: unknown): OpportunityEventReview {
  const row = record(value, "机会复盘");
  const feedback = choice(row.feedback, FEEDBACK_KINDS, "反馈来源");
  const reviewedAt = date(row.reviewedAt, "复盘时间")!;
  const afterEvidence = row.afterEvidence === undefined ? undefined : parseEvidence(row.afterEvidence);
  if (afterEvidence?.independentRetests.some(ref => ref.completedAt && shanghaiEpoch(ref.completedAt) > shanghaiEpoch(reviewedAt))) throw new Error("复盘包含尚未发生的独立复测。");
  return {
    action: choice(row.action, OPPORTUNITY_ACTIONS, "行动"), feedback,
    reason: text(row.reason, "行动理由", 2000, true), observation: feedback === "unobserved" ? "" : text(row.observation, "已记录的反馈或推测", 2000, true),
    ...(row.materialId === undefined ? {} : { materialId: text(row.materialId, "材料快照编号", 150, true) }),
    reviewedAt,
    ...(row.outcome === undefined ? {} : { outcome: feedback === "reported" ? choice(row.outcome, OPPORTUNITY_OUTCOMES, "结果类型") : "unknown" as const }),
    ...(row.feedbackCommunicationId === undefined || feedback !== "reported" ? {} : { feedbackCommunicationId: text(row.feedbackCommunicationId, "反馈沟通编号", 150, true) }),
    ...(afterEvidence === undefined ? {} : { afterEvidence }),
    ...(row.officialVersion === undefined ? {} : { officialVersion: parseOfficialVersion(row.officialVersion) }),
  };
}
function eventContext(item: Record<string, unknown>): EventContext {
  return {
    ...(item.jdSnapshotId === undefined ? {} : { jdSnapshotId: text(item.jdSnapshotId, "岗位版本编号", 150, true) }),
    ...(item.review === undefined ? {} : { review: parseReview(item.review) }),
  };
}
function parseJdSnapshots(value: unknown): JobDescriptionSnapshot[] {
  if (!Array.isArray(value) || value.length > 1200) throw new Error("岗位版本列表不受支持。");
  const rows = value.map(entry => {
    const row = record(entry, "岗位版本");
    const sourceUrl = url(row.sourceUrl, "详情来源链接");
    const careerSourceUrl = exactCareerSourceUrl(row.careerSourceUrl, sourceUrl);
    return { id: text(row.id, "版本编号", 150, true), title: text(row.title, "职位", 500, true), company: text(row.company, "公司", 300, true),
      description: text(row.description, "JD 正文", 120000), sourceUrl, ...(careerSourceUrl ? { careerSourceUrl } : {}), capturedAt: date(row.capturedAt, "快照时间")!,
      ...(row.sourcePlatform === undefined ? {} : { sourcePlatform: text(row.sourcePlatform, "版本来源平台", 200, true) }),
      ...(row.sourceJobId === undefined ? {} : { sourceJobId: text(row.sourceJobId, "版本来源编号", 300, true) }) };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("岗位版本编号重复。");
  return rows;
}

/** Save one copy of each observed JD version per opportunity. */
function captureJd(job: Opportunity, at: string): { jdSnapshots: JobDescriptionSnapshot[]; jdSnapshotId: string } {
  const snapshots = job.jdSnapshots ?? [];
  const { title, company, description, sourceUrl, sourcePlatform, careerSourceUrl } = job;
  const sourceJobId = job.sourceJobId || undefined;
  const existing = snapshots.find(row => row.title === title && row.company === company && row.description === description && row.sourceUrl === sourceUrl && row.sourcePlatform === sourcePlatform && row.sourceJobId === sourceJobId && row.careerSourceUrl === careerSourceUrl);
  if (existing) return { jdSnapshots: snapshots, jdSnapshotId: existing.id };
  const next = { id: crypto.randomUUID(), title, company, description, sourceUrl, sourcePlatform, ...(careerSourceUrl ? { careerSourceUrl } : {}), ...(sourceJobId ? { sourceJobId } : {}), capturedAt: at };
  return { jdSnapshots: [...snapshots, next], jdSnapshotId: next.id };
}

function parseApplication(value: unknown): OpportunityApplication {
  const app = record(value, "投递记录");
  if (!Array.isArray(app.history) || app.history.length > 1_000) throw new Error("投递历史格式不正确或超过上限。");
  const history = app.history.map((entry): ApplicationHistoryEntry => {
    const item = record(entry, "投递历史");
    return { ...eventContext(item), id: text(item.id, "历史编号", 150, true), stage: choice(item.stage, OPPORTUNITY_STAGES, "历史阶段"), changedAt: date(item.changedAt, "阶段变更时间")!, notes: text(item.notes, "历史备注", 10_000) };
  });
  if (new Set(history.map((item) => item.id)).size !== history.length) throw new Error("投递历史编号重复。");
  const stage = choice(app.stage, OPPORTUNITY_STAGES, "投递阶段");
  if (history.length && history.at(-1)!.stage !== stage) throw new Error("投递阶段与历史记录不一致。");
  const rawCommunications = app.communications === undefined ? [] : app.communications;
  if (!Array.isArray(rawCommunications) || rawCommunications.length > MAX_APPLICATION_COMMUNICATIONS) throw new Error(`每个岗位最多保留 ${MAX_APPLICATION_COMMUNICATIONS} 条实际沟通记录，请先备份整理。`);
  const communications = rawCommunications.map((entry): ApplicationCommunication => {
    const item = record(entry, "实际沟通记录");
    const occurredAt = date(item.occurredAt, "实际沟通时间")!;
    const recordedAt = date(item.recordedAt, "沟通补录时间")!;
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(recordedAt) || shanghaiEpoch(occurredAt) > shanghaiEpoch(recordedAt)) throw new Error("实际沟通时间必须包含时区，且不能晚于补录时间。");
    return {
      ...eventContext(item), id: text(item.id, "沟通编号", 150, true),
      direction: choice(item.direction, ["outbound", "inbound"], "沟通方向"),
      method: choice(item.method, COMMUNICATION_METHODS, "沟通方式"),
      occurredAt,
      contact: text(item.contact, "沟通对象", 500),
      summary: text(item.summary, "实际沟通摘要", 10_000, true),
      recordedAt,
    };
  });
  if (new Set(communications.map((item) => item.id)).size !== communications.length) throw new Error("沟通记录编号重复。");
  let actions: OpportunityActionRecord[] | undefined;
  if (app.actions !== undefined) {
    if (!Array.isArray(app.actions) || app.actions.length > 1000) throw new Error("实际行动记录格式无效或超过上限。");
    actions = app.actions.map(entry => {
      const row = record(entry, "已确认的实际行动");
      const review = parseReview(row.review);
      const occurredAt = date(row.occurredAt, "实际行动时间")!;
      if (shanghaiEpoch(occurredAt) > shanghaiEpoch(review.reviewedAt)) throw new Error("实际行动晚于复盘时间。");
      if (row.previousReviews !== undefined && (!Array.isArray(row.previousReviews) || row.previousReviews.length > 200)) throw new Error("历史复盘格式不正确或超过上限。");
      let sourceEvent: OpportunityActionRecord["sourceEvent"];
      if (row.sourceEvent !== undefined) {
        const source = record(row.sourceEvent, "已有行动记录");
        sourceEvent = { kind: choice(source.kind, ["stage", "communication"], "行动来源"), id: text(source.id, "已有行动编号", 150, true) };
      }
      const previousReviews = row.previousReviews === undefined ? undefined : (row.previousReviews as unknown[]).map(parseReview);
      return { id: text(row.id, "实际行动编号", 150, true), occurredAt, jdSnapshotId: text(row.jdSnapshotId, "岗位版本编号", 150, true), decisionId: text(row.decisionId, "建议编号", 150, true), review, ...(sourceEvent ? { sourceEvent } : {}),
        ...(previousReviews === undefined ? {} : { previousReviews }), ...(row.evaluationSample === undefined ? {} : { evaluationSample: parseEvaluationSample(row.evaluationSample) }) };
    });
    if (new Set(actions.map(row => row.id)).size !== actions.length) throw new Error("实际行动编号重复。");
  }
  return { ...(actions === undefined ? {} : { actions }), stage, notes: text(app.notes, "投递备注", 20_000), nextAction: text(app.nextAction, "下一步", 2_000), nextActionAt: date(app.nextActionAt, "下一步时间", true), submittedAt: date(app.submittedAt, "确认提交时间", true), channel: text(app.channel === undefined ? "" : app.channel, "申请渠道", 500), contactName: text(app.contactName === undefined ? "" : app.contactName, "联系人", 500), contactDetails: text(app.contactDetails === undefined ? "" : app.contactDetails, "联系方式", 2_000), communications, history };
}

function parseMaterials(value: unknown): OpportunityMaterial[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OPPORTUNITY_MATERIALS) throw new Error(`每个岗位最多保留 ${MAX_OPPORTUNITY_MATERIALS} 份材料快照，请先手动清理不需要的快照。`);
  const materials = value.map((entry): OpportunityMaterial => {
    const item = record(entry, "投递材料快照");
    return {
      id: text(item.id, "材料快照编号", 150, true),
      resumeViewId: text(item.resumeViewId, "简历视图编号", 150, true),
      resumeName: text(item.resumeName, "简历名称", 300, true),
      resumeUpdatedAt: date(item.resumeUpdatedAt, "简历修改时间")!,
      locale: choice(item.locale, ["zh", "en"], "材料语言"),
      markdown: text(item.markdown, "简历材料正文", 120_000, true),
      ...(item.officialVersion === undefined ? {} : { officialVersion: parseOfficialVersion(item.officialVersion) }),
      createdAt: date(item.createdAt, "材料快照时间")!,
    };
  });
  if (new Set(materials.map((item) => item.id)).size !== materials.length) throw new Error("材料快照编号重复。");
  return materials;
}

function parseOpportunity(value: unknown): Opportunity {
  const job = record(value, "岗位");
  const location = record(job.location, "工作地点");
  const sourceUrl = url(job.sourceUrl, "详情来源链接");
  const careerSourceUrl = exactCareerSourceUrl(job.careerSourceUrl, sourceUrl);
  if (!Array.isArray(job.remoteEligibleRegions) || job.remoteEligibleRegions.length > 100) throw new Error("远程允许地区格式不正确。");
  const application = parseApplication(job.application);
  const jdSnapshots = job.jdSnapshots === undefined ? undefined : parseJdSnapshots(job.jdSnapshots);
  const materials = parseMaterials(job.materials);
  let decisions: OpportunityDecisionReceipt[] | undefined;
  if (job.decisions !== undefined) {
    if (!Array.isArray(job.decisions) || job.decisions.length > 1000) throw new Error("建议记录格式不正确或超过上限。");
    decisions = job.decisions.map(parseDecision);
    if (new Set(decisions.map(row => row.id)).size !== decisions.length) throw new Error("建议编号重复。");
    for (const decision of decisions) {
      const snapshot = jdSnapshots?.find(row => row.id === decision.jdSnapshotId);
      if (!snapshot || snapshotVersion(snapshot) !== decision.jobVersion || shanghaiEpoch(snapshot.capturedAt) > shanghaiEpoch(decision.createdAt)) throw new Error("建议关联的岗位版本不属于此机会或发生在建议以后。");
    }
  }
  for (const event of [...application.history, ...application.communications, ...(application.actions ?? [])]) {
    if (event.jdSnapshotId && !jdSnapshots?.some(row => row.id === event.jdSnapshotId)) throw new Error("事件关联的岗位版本不属于此机会。");
    if (event.review?.materialId && !materials.some(row => row.id === event.review!.materialId)) throw new Error("事件关联的简历快照不属于此机会。");
  }
  const linkedEvents = new Set<string>(), evaluatedDecisions = new Set<string>();
  for (const action of application.actions ?? []) {
    const decision = decisions?.find(row => row.id === action.decisionId);
    if (!decision || decision.jdSnapshotId !== action.jdSnapshotId || shanghaiEpoch(action.occurredAt) < shanghaiEpoch(decision.createdAt)) throw new Error("实际行动与历史建议不一致。");
    if (action.sourceEvent) {
      const sourceKey = `${action.sourceEvent.kind}:${action.sourceEvent.id}`;
      if (linkedEvents.has(sourceKey)) throw new Error("同一实际记录不能重复关联。");
      linkedEvents.add(sourceKey);
      const source = action.sourceEvent.kind === "stage" ? application.history.find(row => row.id === action.sourceEvent!.id) : application.communications.find(row => row.id === action.sourceEvent!.id);
      if (!source || source.jdSnapshotId !== action.jdSnapshotId || ("changedAt" in source ? source.changedAt : source.occurredAt) !== action.occurredAt) throw new Error("行动关联的已有记录不一致。");
    }
    let previousTime = shanghaiEpoch(action.occurredAt);
    for (const review of [...action.previousReviews ?? [], action.review]) {
      if (shanghaiEpoch(review.reviewedAt) < previousTime) throw new Error("历史复盘时间顺序不一致。");
      previousTime = shanghaiEpoch(review.reviewedAt);
      const material = materials.find(row => row.id === review.materialId);
      if (review.materialId && (!material || JSON.stringify(material.officialVersion) !== JSON.stringify(review.officialVersion))) throw new Error("行动关联的正式简历版本不一致。");
      if (!review.feedbackCommunicationId) continue;
      const feedback = application.communications.find(row => row.id === review.feedbackCommunicationId);
      if (!feedback || feedback.direction !== "inbound" || shanghaiEpoch(feedback.occurredAt) < shanghaiEpoch(action.occurredAt) || shanghaiEpoch(feedback.occurredAt) > shanghaiEpoch(review.reviewedAt)) throw new Error("引用的反馈沟通记录不属于此机会或发生时间不一致。");
    }
    if (action.evaluationSample) {
      if (evaluatedDecisions.has(action.decisionId)) throw new Error("同一建议只能授权一条评审样本。");
      evaluatedDecisions.add(action.decisionId);
      if (JSON.stringify(action.evaluationSample) !== JSON.stringify(projectOpportunityEvaluation(decision, action))) throw new Error("匿名评审样本与已确认的复盘不一致。");
    }
  }
  return {
    id: text(job.id, "岗位编号", 150, true),
    company: text(job.company, "公司", 300, true),
    title: text(job.title, "职位", 500, true),
    description: text(job.description, "JD 正文", 120_000),
    sourceUrl, ...(careerSourceUrl ? { careerSourceUrl } : {}),
    applicationUrl: url(job.applicationUrl, "原始申请链接"),
    discoveryUrl: url(job.discoveryUrl, "发现渠道链接"),
    sourcePlatform: text(job.sourcePlatform, "来源平台", 200, true),
    publisherType: choice(job.publisherType, ["company", "recruiter", "agency", "unknown"], "发布主体"),
    market: choice(job.market, OPPORTUNITY_MARKETS, "市场归属"),
    workMode: choice(job.workMode, ["on-site", "hybrid", "remote", "unknown"], "工作方式"),
    location: { country: text(location.country, "国家/地区", 200), region: text(location.region, "省/州", 200), city: text(location.city, "城市", 200) },
    remoteEligibleRegions: job.remoteEligibleRegions.map((item) => text(item, "远程允许地区", 300, true)),
    salaryText: text(job.salaryText, "薪资原文", 2_000),
    employmentType: choice(job.employmentType, ["social", "campus", "internship", "unknown"], "招聘类型"),
    sourceJobId: job.sourceJobId === undefined ? undefined : text(job.sourceJobId, "来源岗位编号", 300),
    sourcePublishedText: job.sourcePublishedText === undefined ? undefined : text(job.sourcePublishedText, "来源发布时间原文", 1_000),
    sourcePublishedAt: date(job.sourcePublishedAt, "来源发布时间", true),
    sourceUpdatedAt: date(job.sourceUpdatedAt, "平台更新时间", true),
    applicationDeadlineText: text(job.applicationDeadlineText === undefined ? "" : job.applicationDeadlineText, "截止日期原文", 2_000),
    applicationDeadlineDate: dateOnly(job.applicationDeadlineDate),
    firstDiscoveredAt: date(job.firstDiscoveredAt, "首次发现时间")!,
    collectedAt: date(job.collectedAt, "本次采集时间")!,
    lastVerifiedAt: date(job.lastVerifiedAt, "最近核验时间", true),
    lastVerificationMethod: choice<VerificationMethod>(job.lastVerificationMethod === undefined ? "unknown" : job.lastVerificationMethod, ["source-read", "manual", "unknown"], "最近核验方式"),
    status: choice(job.status, OPPORTUNITY_STATUSES, "岗位状态"),
    application, materials, ...(jdSnapshots ? { jdSnapshots } : {}), ...(decisions ? { decisions } : {}),
    ...(job.deliveryPlans === undefined ? {} : { deliveryPlans: parseDeliveryPlans(job.deliveryPlans).map(plan => {
      if (plan.jobId !== job.id) throw new Error("投递行动不属于当前岗位。");
      return plan;
    }) }),
    createdAt: date(job.createdAt, "创建时间")!,
    updatedAt: date(job.updatedAt, "修改时间")!,
  };
}

function parseLibrary(value: unknown): OpportunityLibrary {
  const library = record(value, "机会库");
  if (library.schemaVersion !== 1 && library.schemaVersion !== 2 && library.schemaVersion !== 3 && library.schemaVersion !== 4) throw new Error("机会库版本不兼容，请保留原文件并使用支持此版本的程序。");
  if (!Number.isSafeInteger(library.revision) || (library.revision as number) < 0) throw new Error("机会库修订号无效。");
  if (!Array.isArray(library.jobs) || library.jobs.length > MAX_JOBS) throw new Error(`机会库格式错误或超过 ${MAX_JOBS} 条上限。`);
  const jobs = library.jobs.map(parseOpportunity);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error("机会库岗位编号重复。");
  const urls = jobs.map((job) => job.sourceUrl).filter(Boolean);
  if (new Set(urls).size !== urls.length) throw new Error("机会库存在相同来源链接，请先核对重复岗位。");
  // Promote only when the extension is used. Old clients reject v2 rather than
  // silently stripping action cards and overwriting the original v1 storage key.
  const needsReviewVersion = jobs.some(job => job.jdSnapshots?.length || [...job.application.history, ...job.application.communications].some(event => event.review));
  const needsDecisionVersion = jobs.some(job => job.careerSourceUrl || job.jdSnapshots?.some(row => row.careerSourceUrl) || job.decisions?.length || job.application.actions?.length || job.materials.some(material => material.officialVersion));
  const schemaVersion = library.schemaVersion === 4 || needsDecisionVersion ? 4 : library.schemaVersion === 3 || needsReviewVersion ? 3 : library.schemaVersion === 2 || jobs.some(job => job.deliveryPlans?.length) ? 2 : 1;
  return { schemaVersion, revision: library.revision as number, updatedAt: date(library.updatedAt, "机会库更新时间")!, jobs };
}

export function emptyOpportunityLibrary(): OpportunityLibrary {
  return { schemaVersion: 1, revision: 0, updatedAt: EPOCH, jobs: [] };
}

export function readOpportunityLibrary(): { library: OpportunityLibrary; error?: string; recoveryRaw?: string } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OPPORTUNITY_STORAGE_KEY);
    if (raw === null) return { library: emptyOpportunityLibrary() };
    return { library: importOpportunityJson(raw) };
  } catch (error) {
    return { library: emptyOpportunityLibrary(), error: `机会库读取失败：${error instanceof Error ? error.message : "浏览器存储不可用。"} 原数据未被覆盖。`, ...(raw !== null ? { recoveryRaw: raw } : {}) };
  }
}

/** The saved revision must be adopted by the caller; stale tabs cannot overwrite it. */
export function saveOpportunityLibrary(library: OpportunityLibrary): OpportunityLibrary {
  const clean = parseLibrary(library);
  let raw: string | null;
  try { raw = localStorage.getItem(OPPORTUNITY_STORAGE_KEY); } catch { throw new Error("浏览器存储不可用，机会尚未保存，请下载备份。"); }
  let stored: OpportunityLibrary;
  try { stored = raw === null ? emptyOpportunityLibrary() : importOpportunityJson(raw); } catch { throw new Error("本地机会库损坏或版本不兼容。请先下载原始数据；为避免丢失，已阻止覆盖。"); }
  if (stored.revision !== clean.revision) throw new Error("机会库已在另一个窗口修改。请先导出当前编辑，再重新载入合并，已阻止覆盖。");
  const saved: OpportunityLibrary = { ...clean, revision: clean.revision + 1, updatedAt: new Date().toISOString() };
  const serialized = exportOpportunityJson(saved);
  try { localStorage.setItem(OPPORTUNITY_STORAGE_KEY, serialized); } catch { throw new Error("机会库保存失败，可能是浏览器存储空间不足。原数据保留，请下载备份。"); }
  return saved;
}

/** Explicit recovery preserves the corrupt original before replacing it. */
export function replaceCorruptOpportunityLibrary(library: OpportunityLibrary, confirmed: boolean): OpportunityLibrary {
  if (!confirmed) throw new Error("请先下载并确认恢复原始机会库。");
  const clean = parseLibrary(library);
  const raw = localStorage.getItem(OPPORTUNITY_STORAGE_KEY);
  if (raw !== null) {
    let valid = false;
    try { importOpportunityJson(raw); valid = true; } catch { /* Preserve exact invalid data below. */ }
    if (valid) throw new Error("当前机会库可正常读取，请使用正常保存或合并，不能走损坏恢复。");
    try { localStorage.setItem(OPPORTUNITY_RECOVERY_KEY, raw); } catch { throw new Error("无法保护原始数据，恢复未执行。请先下载原文并释放空间。"); }
  }
  const saved: OpportunityLibrary = { ...clean, revision: 1, updatedAt: new Date().toISOString() };
  try { localStorage.setItem(OPPORTUNITY_STORAGE_KEY, exportOpportunityJson(saved)); } catch { throw new Error("恢复保存失败，原始数据仍保留。"); }
  return saved;
}

export function createOpportunity(input: OpportunityInput, now?: string): Opportunity {
  const at = currentTime(now);
  const job = {
    description: "",
    sourceUrl: "", applicationUrl: "", discoveryUrl: "", sourcePlatform: "手动录入", publisherType: "unknown",
    market: "unknown", workMode: "unknown", location: { country: "", region: "", city: "" }, remoteEligibleRegions: [],
    salaryText: "", employmentType: "unknown", status: "unknown", firstDiscoveredAt: at, collectedAt: at, lastVerificationMethod: "unknown",
    ...input, careerSourceUrl: input.sourceUrl?.trim() ? input.sourceUrl : undefined, id: crypto.randomUUID(), company: input.company.trim(), title: input.title.trim(),
    application: { stage: "saved", notes: "", nextAction: "", history: [{ id: crypto.randomUUID(), stage: "saved", changedAt: at, notes: "收藏岗位" }] },
    materials: [],
    createdAt: at, updatedAt: at,
  };
  return parseOpportunity(job);
}

export function addOpportunity(library: OpportunityLibrary, input: OpportunityInput, now?: string): { library: OpportunityLibrary; job: Opportunity; duplicate: boolean } {
  const job = createOpportunity(input, now);
  const existing = job.sourceUrl ? library.jobs.find((item) => normalizeOpportunityUrl(item.sourceUrl) === job.sourceUrl) : undefined;
  if (existing) return { library, job: existing, duplicate: true };
  const result = parseLibrary({ ...library, updatedAt: job.updatedAt, jobs: [job, ...library.jobs] });
  return { library: result, job, duplicate: false };
}

export function updateOpportunity(library: OpportunityLibrary, id: string, patch: OpportunityPatch, now?: string): OpportunityLibrary {
  if (!library.jobs.some((job) => job.id === id)) throw new Error("岗位不存在，请重新载入机会库。");
  const at = currentTime(now);
  const jobs = library.jobs.map(job => {
    if (job.id !== id) return job;
    const careerSourceUrl = patch.sourceUrl !== undefined && patch.sourceUrl !== job.sourceUrl ? (patch.sourceUrl.trim() ? patch.sourceUrl : undefined) : job.careerSourceUrl;
    return parseOpportunity({ ...job, ...patch, careerSourceUrl, id: job.id, application: job.application, materials: job.materials, jdSnapshots: job.jdSnapshots, decisions: job.decisions, createdAt: job.createdAt, updatedAt: at });
  });
  return parseLibrary({ ...library, jobs, updatedAt: at });
}

export function prepareOpportunityDelivery(library: OpportunityLibrary, id: string, input: DeliveryInput, now = new Date().toISOString()): OpportunityLibrary {
  const job = library.jobs.find(item => item.id === id);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  const deliveryPlans = createDeliveryPlan(job, input, job.deliveryPlans ?? [], now);
  return parseLibrary({ ...library, updatedAt: now, jobs: library.jobs.map(item => item.id === id ? { ...item, deliveryPlans, updatedAt: now } : item) });
}

export function commandOpportunityDelivery(library: OpportunityLibrary, jobId: string, planId: string, command: DeliveryCommand, now = new Date().toISOString()): OpportunityLibrary {
  const job = library.jobs.find(item => item.id === jobId);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  const deliveryPlans = transitionDelivery(job.deliveryPlans ?? [], planId, job, command, now);
  return parseLibrary({ ...library, updatedAt: now, jobs: library.jobs.map(item => item.id === jobId ? { ...item, deliveryPlans, updatedAt: now } : item) });
}

export function updateApplication(library: OpportunityLibrary, id: string, patch: { stage: ApplicationStage; notes?: string; nextAction?: string; nextActionAt?: string; channel?: string; contactName?: string; contactDetails?: string }, options: { submittedConfirmed?: boolean; now?: string } = {}): OpportunityLibrary {
  const existing = library.jobs.find((job) => job.id === id);
  if (!existing) throw new Error("岗位不存在，请重新载入机会库。");
  const at = currentTime(options.now);
  const old = existing.application;
  if (patch.stage === "applied" && old.stage !== "applied" && !old.submittedAt && !options.submittedConfirmed) throw new Error("请明确确认已在原网站提交申请，打开链接不会记为已投递。");
  const capture = old.stage !== patch.stage ? captureJd(existing, at) : undefined;
  const application: OpportunityApplication = {
    ...old, ...patch,
    submittedAt: old.submittedAt ?? (patch.stage === "applied" && options.submittedConfirmed ? at : undefined),
    history: old.stage === patch.stage ? old.history : [...old.history, { id: crypto.randomUUID(), stage: patch.stage, changedAt: at, notes: patch.notes ?? "", jdSnapshotId: capture?.jdSnapshotId }],
  };
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map((job) => job.id === id ? { ...job, application, ...(capture ? { jdSnapshots: capture.jdSnapshots } : {}), updatedAt: at } : job) });
}

/** A saved draft is never a contact event. This entry point requires explicit confirmation of a real interaction. */
export function recordApplicationCommunication(library: OpportunityLibrary, id: string, input: Omit<ApplicationCommunication, "id" | "recordedAt" | keyof EventContext>, options: { occurredConfirmed?: boolean; now?: string } = {}): OpportunityLibrary {
  if (!options.occurredConfirmed) throw new Error("请确认这次沟通已实际发生，待发送的草稿请写入下一步。");
  const job = library.jobs.find((item) => item.id === id);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  const at = currentTime(options.now);
  const occurredAt = date(input.occurredAt, "实际沟通时间")!;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) || shanghaiEpoch(occurredAt) > shanghaiEpoch(at)) throw new Error("实际沟通时间必须已发生且包含时区；未来计划请写入下一步。");
  // For a backfilled event we only know which JD existed if the saved job
  // already had that version by the interaction time.
  const capture = shanghaiEpoch(job.updatedAt) <= shanghaiEpoch(occurredAt) ? captureJd(job, at) : undefined;
  const communications = [...job.application.communications, { direction: input.direction, method: input.method, contact: input.contact,
    summary: input.summary, occurredAt, id: crypto.randomUUID(), recordedAt: at, jdSnapshotId: capture?.jdSnapshotId }];

  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map((item) => item.id === id ? { ...item, ...(capture ? { jdSnapshots: capture.jdSnapshots } : {}), application: { ...item.application, communications }, updatedAt: at } : item) });
}

/** Saving a recommendation records the actual inputs at that instant; it never performs the proposed action. */
export function captureOpportunityDecision(library: OpportunityLibrary, jobId: string, evidence: OpportunityDecisionEvidence, officialVersion?: OpportunityOfficialVersion, now?: string): OpportunityLibrary {
  const job = library.jobs.find(row => row.id === jobId);
  if (!job || !job.description.trim()) throw new Error("请先保存此机会的岗位正文。");
  const at = currentTime(now);
  const capture = captureJd(job, at);
  const decision = parseDecision({ id: crypto.randomUUID(), policyVersion: 1, jdSnapshotId: capture.jdSnapshotId, jobVersion: careerJobSnapshotVersion(opportunityDecisionCareerJob(job)), status: job.status, createdAt: at, evidence, officialVersion, ...recommendOpportunityAction(evidence, job.status) });
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map(item => item.id === jobId ? { ...job, jdSnapshots: capture.jdSnapshots, decisions: [...job.decisions ?? [], decision], updatedAt: at } : item) });
}
function confirmedActionReview(job: Opportunity, input: Omit<OpportunityEventReview, "reviewedAt">, at: string, previous?: OpportunityEventReview): OpportunityEventReview {
  const material = job.materials.find(row => row.id === input.materialId);
  if (input.materialId && !material) throw new Error("请选择此岗位保存的简历快照。");
  return parseReview({ ...input, officialVersion: material?.officialVersion ?? (!input.materialId && previous && !previous.materialId ? previous.officialVersion : undefined), outcome: input.outcome ?? "unknown", reviewedAt: at });
}
export function recordOpportunityDecisionAction(library: OpportunityLibrary, jobId: string, decisionId: string, input: Omit<OpportunityEventReview, "reviewedAt">, options: { occurredConfirmed?: boolean; occurredAt?: string; sourceEvent?: OpportunityActionRecord["sourceEvent"]; now?: string } = {}): OpportunityLibrary {
  if (!options.occurredConfirmed) throw new Error("请确认这项行动已实际发生。");
  const job = library.jobs.find(row => row.id === jobId);
  const decision = job?.decisions?.find(row => row.id === decisionId);
  if (!job || !decision) throw new Error("建议不属于此机会。");
  const at = currentTime(options.now);
  const review = confirmedActionReview(job, input, at);
  const sourceEvent = options.sourceEvent;
  const source = sourceEvent?.kind === "stage" ? job.application.history.find(row => row.id === sourceEvent.id) : sourceEvent?.kind === "communication" ? job.application.communications.find(row => row.id === sourceEvent.id) : undefined;
  if (sourceEvent && (!source || source.jdSnapshotId !== decision.jdSnapshotId)) throw new Error("请选择相同岗位版本的实际记录。");
  const occurredAt = source ? ("changedAt" in source ? source.changedAt : source.occurredAt) : currentTime(options.occurredAt ?? at);
  const event: OpportunityActionRecord = { id: crypto.randomUUID(), occurredAt, ...(sourceEvent ? { sourceEvent } : {}), jdSnapshotId: decision.jdSnapshotId, decisionId, review };
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map(item => item.id === jobId ? { ...job, application: { ...job.application, actions: [...job.application.actions ?? [], event] }, updatedAt: at } : item) });
}
function evaluationRetests(decision: OpportunityDecisionReceipt, event: OpportunityActionRecord): OpportunityRetestRef[] {
  const before = new Set(decision.evidence.independentRetests.map(ref => JSON.stringify([ref.kitId, ref.questionVersion, ref.capabilityId])));
  return latestRetests(event.review.afterEvidence?.independentRetests.filter(ref => ref.completedAt && shanghaiEpoch(ref.completedAt) >= shanghaiEpoch(event.occurredAt) && shanghaiEpoch(ref.completedAt) <= shanghaiEpoch(event.review.reviewedAt) && !before.has(JSON.stringify([ref.kitId, ref.questionVersion, ref.capabilityId]))) ?? []);
}
function projectOpportunityEvaluation(decision: OpportunityDecisionReceipt, event: OpportunityActionRecord, retests = evaluationRetests(decision, event)): OpportunityEvaluationSample {
  const independentRetest = retests.some(ref => ref.result === "missed") ? "missed" : retests.some(ref => ref.result === "recorded") ? "unreviewed" : retests.some(ref => ref.result === "met") ? "met" : "unknown";
  return { schemaVersion: 1, recommendedAction: decision.action, actualAction: event.review.action, outcome: event.review.feedback === "reported" ? event.review.outcome ?? "unknown" : "unknown", corrected: event.review.action !== decision.action, independentRetest };
}
export function recordOpportunityEvaluation(library: OpportunityLibrary, jobId: string, actionId: string, consent: boolean, now?: string): OpportunityLibrary {
  const job = library.jobs.find(row => row.id === jobId);
  const action = job?.application.actions?.find(row => row.id === actionId);
  const decision = job?.decisions?.find(row => row.id === action?.decisionId);
  if (!job || !action || !decision) throw new Error("评审样本仅适用于已确认的同一岗位行动。");
  const at = currentTime(now);
  const actions = job.application.actions!.map(row => row.id === actionId ? { ...row, evaluationSample: consent ? projectOpportunityEvaluation(decision, row) : undefined } : row);
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map(item => item.id === jobId ? { ...job, application: { ...job.application, actions }, updatedAt: at } : item) });
}
function consentedEvaluationReceipts(library: OpportunityLibrary) {
  const receipts = parseLibrary(library).jobs.flatMap(job => (job.application.actions ?? []).flatMap(action => {
    const decision = job.decisions?.find(row => row.id === action.decisionId);
    return action.evaluationSample && decision ? [{ jobId: job.id, action, decision }] : [];
  })).sort((a, b) => shanghaiEpoch(a.action.review.reviewedAt) - shanghaiEpoch(b.action.review.reviewedAt) || a.action.id.localeCompare(b.action.id));
  const counted = new Set<string>();
  const countedAttempts = new Set<string>();
  const attemptKey = (ref: OpportunityRetestRef) => JSON.stringify([ref.kitId, ref.questionVersion]);
  return receipts.map(({ jobId, action, decision }) => {
    const unique = evaluationRetests(decision, action).filter(ref => !counted.has(ref.sourceVersion) && !countedAttempts.has(attemptKey(ref)));
    for (const ref of unique) { counted.add(ref.sourceVersion); countedAttempts.add(attemptKey(ref)); }
    return { jobId, actionId: action.id, sample: projectOpportunityEvaluation(decision, action, unique) };
  });
}
export function consentedOpportunityEvaluations(library: OpportunityLibrary): OpportunityEvaluationSample[] {
  return consentedEvaluationReceipts(library).map(row => row.sample);
}
export function consentedOpportunityEvaluation(library: OpportunityLibrary, jobId: string, actionId: string): OpportunityEvaluationSample | undefined {
  return consentedEvaluationReceipts(library).find(row => row.jobId === jobId && row.actionId === actionId)?.sample;
}
export function exportOpportunityEvaluations(library: OpportunityLibrary): string {
  return JSON.stringify(consentedOpportunityEvaluations(library), null, 2);
}

export function reviewOpportunityEvent(library: OpportunityLibrary, jobId: string, entryKind: "stage" | "communication" | "action", eventId: string,
  input: Omit<OpportunityEventReview, "reviewedAt">, now?: string): OpportunityLibrary {
  const job = library.jobs.find(item => item.id === jobId);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  const at = currentTime(now);
  if (entryKind === "action") {
    if (!job.application.actions?.some(row => row.id === eventId)) throw new Error("事件不属于此岗位。");
    const actions = job.application.actions.map(row => {
      if (row.id !== eventId) return row;
      const review = confirmedActionReview(job, input, at, row.review);
      // Editing invalidates previously granted consent for the changed sample.
      return { ...row, review, previousReviews: [...row.previousReviews ?? [], row.review], evaluationSample: undefined };
    });
    return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map(item => item.id === jobId ? { ...job, application: { ...job.application, actions }, updatedAt: at } : item) });
  }
  const review = parseReview({ action: input.action, reason: input.reason, feedback: input.feedback, observation: input.observation, materialId: input.materialId, reviewedAt: at });
  if (review.materialId && !job.materials.some(row => row.id === review.materialId)) throw new Error("请选择此岗位保存的简历快照。");
  const key = entryKind === "stage" ? "history" : "communications";
  if (!job.application[key].some(row => row.id === eventId)) throw new Error("事件不属于此岗位。");
  const entries = job.application[key].map(row => row.id === eventId ? { ...row, review } : row);
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map(item => item.id === jobId ?
    { ...job, application: { ...job.application, [key]: entries }, updatedAt: at } : item) });
}

export function deleteApplicationCommunication(library: OpportunityLibrary, id: string, communicationId: string, now?: string): OpportunityLibrary {
  const job = library.jobs.find((item) => item.id === id);
  if (!job?.application.communications.some((item) => item.id === communicationId)) throw new Error("沟通记录不存在，请重新载入机会库。");
  const at = currentTime(now);
  const actions = job.application.actions?.map(action => {
    const unlinkFeedback = (review: OpportunityEventReview) => review.feedbackCommunicationId === communicationId ? { ...review, feedbackCommunicationId: undefined } : review;
    return { ...action, review: unlinkFeedback(action.review), ...(action.previousReviews ? { previousReviews: action.previousReviews.map(unlinkFeedback) } : {}), ...(action.sourceEvent?.kind === "communication" && action.sourceEvent.id === communicationId ? { sourceEvent: undefined } : {}) };
  });
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map((item) => item.id === id ? { ...item, application: { ...item.application, ...(actions ? { actions } : {}), communications: item.application.communications.filter((entry) => entry.id !== communicationId) }, updatedAt: at } : item) });
}

export function deleteOpportunity(library: OpportunityLibrary, id: string, now?: string): OpportunityLibrary {
  return parseLibrary({ ...library, updatedAt: currentTime(now), jobs: library.jobs.filter((job) => job.id !== id) });
}

/** This copies the selected resume text only; the live resume is never referenced. */
export function recordOpportunityMaterial(library: OpportunityLibrary, id: string, input: Omit<OpportunityMaterial, "id" | "createdAt">, now?: string): OpportunityLibrary {
  const job = library.jobs.find((item) => item.id === id);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  const at = currentTime(now);
  const materials = parseMaterials([...(job.materials ?? []), { ...input, id: crypto.randomUUID(), createdAt: at }]);
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map((item) => item.id === id ? { ...item, materials, updatedAt: at } : item) });
}

export function deleteOpportunityMaterial(library: OpportunityLibrary, id: string, materialId: string, now?: string): OpportunityLibrary {
  const job = library.jobs.find((item) => item.id === id);
  if (!job) throw new Error("岗位不存在，请重新载入机会库。");
  if (!job.materials.some((item) => item.id === materialId)) throw new Error("材料快照不存在，请重新载入机会库。");
  const at = currentTime(now);
  // An explicit deletion removes the link as well, keeping the rest of the review.
  function unlink<T extends EventContext>(event: T): T {
    if (event.review?.materialId !== materialId) return event;
    const review = { ...event.review };
    delete review.materialId;
    return { ...event, review };
  }
  const application = { ...job.application, history: job.application.history.map(unlink), communications: job.application.communications.map(unlink),
    ...(job.application.actions ? { actions: job.application.actions.map(row => ({ ...unlink(row), ...(row.previousReviews ? { previousReviews: row.previousReviews.map(review => unlink({ review }).review!) } : {}) })) } : {}) };
  return parseLibrary({ ...library, updatedAt: at, jobs: library.jobs.map((item) => item.id === id ?
    { ...item, application, materials: item.materials.filter((material) => material.id !== materialId), updatedAt: at } : item) });
}

export function queryOpportunities(library: OpportunityLibrary, filters: OpportunityFilters = {}): Opportunity[] {
  const search = filters.search?.trim().toLocaleLowerCase();
  return library.jobs.filter((job) => {
    if (filters.market && filters.market !== "all" && job.market !== filters.market) return false;
    if (filters.stage && filters.stage !== "all" && job.application.stage !== filters.stage) return false;
    if (filters.status && filters.status !== "all" && job.status !== filters.status) return false;
    if (filters.workMode && filters.workMode !== "all" && job.workMode !== filters.workMode) return false;
    if (filters.employmentType && filters.employmentType !== "all" && job.employmentType !== filters.employmentType) return false;
    if (filters.sourcePlatform && job.sourcePlatform !== filters.sourcePlatform) return false;
    if (filters.country && job.location.country !== filters.country) return false;
    if (filters.region && job.location.region !== filters.region) return false;
    if (filters.city && job.location.city !== filters.city) return false;
    return !search || [job.company, job.title, job.description, job.location.country, job.location.region, job.location.city, job.sourcePlatform, job.salaryText, job.application.notes, job.application.nextAction, job.application.channel, job.application.contactName, job.application.contactDetails, ...job.application.communications.flatMap((entry) => [entry.contact, entry.summary])].some((value) => value.toLocaleLowerCase().includes(search));
  });
}

export function summarizeOpportunities(jobs: Opportunity[]): { total: number; companies: number; markets: Record<OpportunityMarket, number>; statuses: Record<OpportunityStatus, number>; stages: Record<ApplicationStage, number> } {
  const markets: Record<OpportunityMarket, number> = { domestic: 0, overseas: 0, unknown: 0 };
  const statuses: Record<OpportunityStatus, number> = { open: 0, closed: 0, unknown: 0 };
  const stages: Record<ApplicationStage, number> = { saved: 0, evaluating: 0, preparing: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 };
  for (const job of jobs) { markets[job.market] += 1; statuses[job.status] += 1; stages[job.application.stage] += 1; }
  return { total: jobs.length, companies: new Set(jobs.map((job) => job.company.trim().toLocaleLowerCase())).size, markets, statuses, stages };
}

export function exportOpportunityJson(library: OpportunityLibrary): string {
  const result = JSON.stringify(parseLibrary(library), null, 2);
  if (new TextEncoder().encode(result).length > MAX_JSON_BYTES) throw new Error("机会库超过 4 MB 备份上限，请减少超长 JD 或分批整理。");
  return result;
}

export function importOpportunityJson(raw: string): OpportunityLibrary {
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) throw new Error("机会库文件超过 4 MB 上限。");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("机会库 JSON 无法解析，请保留原文件检查。"); }
  return parseLibrary(parsed);
}

/** Existing records win; importing a backup never rewrites the application timeline. */
export function mergeOpportunityLibraries(current: OpportunityLibrary, incoming: OpportunityLibrary, now?: string): { library: OpportunityLibrary; added: number; duplicates: number } {
  const clean = parseLibrary(incoming);
  const jobs = [...current.jobs];
  const ids = new Set(jobs.map((job) => job.id));
  const urls = new Set(jobs.map((job) => job.sourceUrl).filter(Boolean));
  let added = 0;
  let duplicates = 0;
  for (const job of clean.jobs) {
    if (ids.has(job.id) || (job.sourceUrl && urls.has(job.sourceUrl))) { duplicates += 1; continue; }
    jobs.push(job); ids.add(job.id); if (job.sourceUrl) urls.add(job.sourceUrl); added += 1;
  }
  return { library: parseLibrary({ ...current, jobs, updatedAt: currentTime(now) }), added, duplicates };
}

function csvCell(value: string): string {
  // Spreadsheet programs interpret formula prefixes after whitespace/control chars.
  let prefix = 0;
  while (prefix < value.length && (value.charCodeAt(prefix) <= 32 || !value[prefix]!.trim())) prefix += 1;
  const safe = "=+@-".includes(value[prefix] ?? "_") || ["\t", "\r", "\n"].some((char) => value.startsWith(char)) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function exportOpportunitiesCsv(jobs: Opportunity[]): string {
  const headers = ["岗位编号", "公司", "职位", "市场", "国家/地区", "省/州", "城市", "工作方式", "远程允许地区", "薪资原文", "招聘类型", "岗位状态", "投递阶段", "来源平台", "发布主体", "详情来源", "申请链接", "发现渠道", "来源岗位编号", "来源发布时间原文", "来源发布时间", "平台更新时间", "首次发现时间", "采集时间", "最近核验时间", "最近核验方式", "确认提交时间", "下一步", "下一步时间", "备注", "JD正文", "材料快照", "申请截止原文", "明确截止日期", "申请渠道", "联系人", "联系方式", "实际沟通记录JSON"];
  const rows = jobs.map((job) => [job.id, job.company, job.title, job.market, job.location.country, job.location.region, job.location.city, job.workMode, job.remoteEligibleRegions.join("；"), job.salaryText, job.employmentType, job.status, job.application.stage, job.sourcePlatform, job.publisherType, job.sourceUrl, job.applicationUrl, job.discoveryUrl, job.sourceJobId ?? "", job.sourcePublishedText ?? "", job.sourcePublishedAt ?? "", job.sourceUpdatedAt ?? "", job.firstDiscoveredAt, job.collectedAt, job.lastVerifiedAt ?? "", job.lastVerificationMethod ?? "unknown", job.application.submittedAt ?? "", job.application.nextAction, job.application.nextActionAt ?? "", job.application.notes, job.description, (job.materials ?? []).map((material) => `${material.resumeName} (${material.locale}, ${material.createdAt})`).join("；"), job.applicationDeadlineText ?? "", job.applicationDeadlineDate ?? "", job.application.channel, job.application.contactName, job.application.contactDetails, JSON.stringify(job.application.communications)]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

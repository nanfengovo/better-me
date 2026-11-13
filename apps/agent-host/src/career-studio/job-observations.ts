import { z } from "zod";
import { IntelligenceIdSchema, IntelligenceSourceSchema, IntelligenceSalarySchema, SimulationJobSchema, JobForensicsObservationSchema,
  type IntelligenceSource, type JobForensicsObservation } from "@better-me/core/career-intelligence";
import { StudioJobSchema } from "./contracts.js";
import { StudioError, studioHash } from "./storage.js";

/** One shared wire schema, not a second job model or a second opportunity store. */
export const StudioJobObservationInputSchema = StudioJobSchema;
export type StudioJobObservationInput = z.infer<typeof StudioJobObservationInputSchema>;
export type StudioSimulationJob = z.infer<typeof SimulationJobSchema>;
export type ConvertedStudioJobObservation = { source: IntelligenceSource; simulationJob: StudioSimulationJob;
  forensicsObservation: JobForensicsObservation; limitations: string[] };

/** Pure conversion of one explicitly selected, frozen observation. Text parsing,
 * platform crawling, availability verification and business reconciliation do
 * not belong here. The source hash covers the complete original wire object. */
export function convertStudioJobObservation(raw: unknown): ConvertedStudioJobObservation {
  const job = StudioJobObservationInputSchema.parse(raw), sourceId = `job-${job.id}`;
  if (!IntelligenceIdSchema.safeParse(sourceId).success) throw new StudioError("studio_job_source_id_too_long", 400);
  const hash = studioHash(raw), source = IntelligenceSourceSchema.parse({ id: sourceId, hash, capturedAt: job.capturedAt, ...(job.sourceUrl ? { url: job.sourceUrl } : {}) });
  const limitations = ["岗位快照与人工填写是有来源版本的观察，不是独立平台核验、当前在招保证或录用概率。",
    "薪资口径只保留明确披露的同币种税前年基本工资；不推断合法性、工时、福利或币种换算。"];
  const salary = IntelligenceSalarySchema.parse(job.comparableSalary
    ? { status: "comparable", ...job.comparableSalary, sourceId }
    : { status: "unknown", reason: "未明确核对可比较的同币种、税前年基本工资；不从salaryText猜测或折算。" });
  const requirements = job.requirements === undefined
    ? [...new Set(job.skillIds)].map((skillId, index) => ({ id: `req-${index + 1}`, skillId, weight: 1, hard: false, knowledge: "known" as const, contribution: "any" as const }))
    : job.requirements.map((requirement, index) => ({ id: `req-${index + 1}`, ...requirement }));
  if (job.requirements === undefined) limitations.push(job.skillIds.length
    ? "未填写结构化要求；仅使用用户明确填写的JD技能编号作均权、非硬门槛覆盖，不能推断完整要求或个人实现层级。"
    : "未选择明确技能或结构化要求，岗位要求保持未知。性格、学历与其他硬门槛未由文本推断。");
  if (job.requirements !== undefined && new Set(job.requirements.map(requirement => requirement.skillId)).size !== job.requirements.length) throw new StudioError("studio_duplicate_job_requirement_skill", 400);
  const availability = job.availability === "active" && job.verifiedAt === null ? "unknown" : job.availability;
  const simulationJob = SimulationJobSchema.parse({ id: job.id, revision: hash, sourceIds: [sourceId], availability,
    verifiedAt: job.verifiedAt, requirements, salary });
  // Core identifiers permit original platform labels, including non-ASCII.
  // Preserve them rather than pretending that every imported row is manual.
  const platform = job.platform.trim() || "unknown-platform";
  if (!job.platformJobId) limitations.push("没有独立平台岗位编号，platformJobId暂使用本次记录ID；这不能证明跨平台同岗或自动归并。");
  if (job.refreshTimes === undefined) limitations.push("缺少刷新观察记录；空列表表示未提供，不表示岗位从未刷新或长期不招人。");
  if (job.availability === "active" && job.verifiedAt === null) limitations.push("输入标记在招但缺少核对时间；派生可用性保守保留unknown，原始陈述仍由来源哈希绑定。");
  const forensicsObservation = JobForensicsObservationSchema.parse({ id: job.id, revision: hash, platform, platformJobId: job.platformJobId ?? job.id,
    sourceId, title: job.title, companyId: job.companyKey, roleKey: job.roleKey, locationKey: job.locationKey, departmentKey: job.departmentKey ?? null,
    availability, observedAt: job.capturedAt, publishedAt: job.publishedAt, firstSeenAt: job.firstSeenAt, lastSeenAt: job.lastSeenAt,
    refreshTimes: job.refreshTimes ?? [], salary, declaredSkillIds: job.skillIds });
  return { source, simulationJob, forensicsObservation, limitations };
}

/** Preserve one source and one observation per original row. Recommendations
 * may later be reviewed by core reconciliation, never written to the job pool. */
export function convertStudioJobObservations(raw: readonly unknown[]): { sources: IntelligenceSource[]; simulationJobs: StudioSimulationJob[];
  forensicsObservations: JobForensicsObservation[]; limitations: string[] } {
  if (!Array.isArray(raw) || raw.length > 200) throw new StudioError("studio_job_observation_limit", 400);
  const converted = raw.map(convertStudioJobObservation);
  if (new Set(converted.map(item => item.source.id)).size !== converted.length) throw new StudioError("studio_duplicate_job_observation", 400);
  return { sources: converted.map(item => item.source), simulationJobs: converted.map(item => item.simulationJob),
    forensicsObservations: converted.map(item => item.forensicsObservation), limitations: [...new Set(converted.flatMap(item => item.limitations))] };
}

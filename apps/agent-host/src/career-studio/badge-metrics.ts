import { createHash } from "node:crypto";
import { z } from "zod";
import type { UnderstandingEvidence, UnderstandingGrant } from "@better-me/agent-contracts";
import type { CapturedCommit } from "../evidence-harvester/git-source.js";
import type { EvidenceBroker, EvidenceRequest } from "../understanding/evidence-broker.js";
import { StudioError, studioHash } from "./storage.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digestText = (text: string) => createHash("sha256").update(text).digest("hex");
const readSelection = z.object({ path: z.string().min(1).max(2000), startLine: z.number().int().positive(), endLine: z.number().int().positive(), expectedSourceHash: hash.optional() }).strict()
  .refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < 200, "An exact positive range of at most 200 lines is required.");
export type BadgeMetricEvidence = Readonly<{ kind: "broker_excerpt"; id: string; path: string; sourceHash: string; excerptHash: string; startLine: number; endLine: number }>;
type ReadAuthority = { broker: Pick<EvidenceBroker, "execute">; grant: UnderstandingGrant; request: EvidenceRequest;
  record: UnderstandingEvidence; isCurrent(): boolean | Promise<boolean> };
const reads = new WeakMap<BadgeMetricEvidence, ReadAuthority>();
const evidenceHandle = z.custom<BadgeMetricEvidence>(value => Boolean(value && typeof value === "object" && reads.has(value as BadgeMetricEvidence)), "Only an original broker-minted evidence handle is accepted.");
const selectionInput = z.object({ targetHash: hash,
  transition: z.object({ evidence: evidenceHandle, format: z.literal("json") }).strict().optional(),
  coverage: z.object({ report: evidenceHandle, format: z.enum(["lcov", "cobertura"]), manifest: evidenceHandle.optional(), sources: z.array(evidenceHandle).min(1).max(8) }).strict().optional(),
  git: z.object({ repositoryId: hash, selectedCommits: z.array(oid).min(1).max(32) }).strict().optional(),
}).strict();
export type BadgeMetricSelection = z.infer<typeof selectionInput>;
export type BadgeMetricName = "declaredTransitionEntries" | "evolutionDays" | "testCoveragePercent";
export type BadgeMetricInputRef = BadgeMetricEvidence | { kind: "git_capture_metadata"; repositoryId: string; commit: string; committedAt: string; hash: string };
export type BadgeCollectedMetric = { value: number; method: string; scope: string; sourceHashes: string[]; receiptHash: string };
export type BadgeMetricReceipt = { schemaVersion: 1; metric: BadgeMetricName; value: number; targetHash: string; method: string; scope: string;
  inputs: BadgeMetricInputRef[]; executionVerified: false; limitations: string[]; hash: string };
export const BadgeMetricReceiptSchema = z.object({ schemaVersion: z.literal(1), metric: z.enum(["declaredTransitionEntries", "evolutionDays", "testCoveragePercent"]),
  value: z.number().finite().nonnegative(), targetHash: hash, method: z.string().min(1).max(240), scope: z.string().min(1).max(2000),
  inputs: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("broker_excerpt"), id: z.string().min(1).max(240), path: z.string().min(1).max(2000), sourceHash: hash, excerptHash: hash, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("git_capture_metadata"), repositoryId: hash, commit: oid, committedAt: z.string().datetime(), hash }).strict(),
  ])).min(1).max(32), executionVerified: z.literal(false), limitations: z.array(z.string().min(1).max(2000)).max(100), hash,
}).strict();
export type CollectedBadgeMetrics = { schemaVersion: 1; targetHash: string; status: "observed" | "unknown" | "stale" | "cancelled";
  metrics: Partial<Record<BadgeMetricName, BadgeCollectedMetric>>; metricReceipts: BadgeMetricReceipt[];
  unknowns: string[]; limitations: string[] };
export type BadgeMetricOptions = { isCurrent(): boolean | Promise<boolean>; signal?: AbortSignal; timeoutMs?: number;
  /** Registered Host adapter only, never an HTTP/model-supplied callback or
   * numeric metric. It resolves existing explicitly authorized capture results;
   * this collector itself runs no Git command or repository code. */
  resolveGitCaptures?(selection: { repositoryId: string; selectedCommits: readonly string[] }, signal: AbortSignal): Promise<readonly Pick<CapturedCommit, "repositoryId" | "commit" | "committedAt">[]>;
};
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new StudioError("badge_metric_cancelled"));
    if (signal.aborted) { void promise.catch(() => {}); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(value => { signal.removeEventListener("abort", stop); if (signal.aborted) stop(); else resolve(value); }, error => { signal.removeEventListener("abort", stop); reject(error); });
  });
}
function budget(options: { signal?: AbortSignal; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new StudioError("invalid_badge_metric_budget", 400);
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
}
async function current(check: () => boolean | Promise<boolean>, signal: AbortSignal) {
  if (!await bounded(Promise.resolve().then(check), signal)) throw new StudioError("badge_metric_context_stale");
}

/** Exact existing EvidenceBroker reads only. No FS fallback, new extension or
 * coverage-directory exception. The opaque object is process-local and cannot
 * be forged by JSON/model output, cloned or renewed after an identity change. */
export async function readBadgeMetricEvidence(input: { broker: Pick<EvidenceBroker, "execute">; grant: UnderstandingGrant;
  selection: z.input<typeof readSelection>; isCurrent(): boolean | Promise<boolean>; signal?: AbortSignal; timeoutMs?: number }): Promise<BadgeMetricEvidence> {
  const selection = readSelection.parse(input.selection), signal = budget(input);
  await current(input.isCurrent, signal);
  const request = { operation: "read" as const, path: selection.path, startLine: selection.startLine, endLine: selection.endLine };
  const result = await bounded(input.broker.execute(input.grant, request, signal), signal);
  await current(input.isCurrent, signal);
  const record = result.evidence[0];
  if (result.truncated || result.evidence.length !== 1 || !record || record.startLine !== selection.startLine || record.endLine !== selection.endLine
    || !hash.safeParse(record.hash).success || Buffer.byteLength(record.excerpt) > 64000) throw new StudioError("badge_metric_read_incomplete");
  if (selection.expectedSourceHash && record.hash !== selection.expectedSourceHash) throw new StudioError("badge_metric_source_changed");
  const handle: BadgeMetricEvidence = Object.freeze({ kind: "broker_excerpt", id: record.id, path: record.path, sourceHash: record.hash,
    excerptHash: digestText(record.excerpt), startLine: record.startLine, endLine: record.endLine });
  reads.set(handle, { broker: input.broker, grant: input.grant, request, record: structuredClone(record), isCurrent: input.isCurrent });
  return handle;
}
async function revalidate(handle: BadgeMetricEvidence, signal: AbortSignal) {
  const read = reads.get(handle); if (!read) throw new StudioError("badge_metric_handle_untrusted", 400);
  await current(read.isCurrent, signal);
  const result = await bounded(read.broker.execute(read.grant, read.request, signal), signal), actual = result.evidence[0];
  if (result.truncated || result.evidence.length !== 1 || !actual || actual.hash !== handle.sourceHash || actual.path !== handle.path
    || actual.startLine !== handle.startLine || actual.endLine !== handle.endLine || digestText(actual.excerpt) !== handle.excerptHash) throw new StudioError("badge_metric_source_changed");
  await current(read.isCurrent, signal);
}
const textOf = (handle: BadgeMetricEvidence) => { const read = reads.get(handle); if (!read) throw new StudioError("badge_metric_handle_untrusted", 400); return read.record.excerpt; };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function transitionEntries(handle: BadgeMetricEvidence): number {
  const parsed: unknown = JSON.parse(textOf(handle)); if (!object(parsed)) throw new StudioError("transition_table_literal_required");
  const states = Object.entries(parsed); if (states.length > 100) throw new StudioError("transition_table_budget");
  let count = 0;
  for (const [state, events] of states) {
    if (!state || state.length > 200 || !object(events)) throw new StudioError("transition_table_shape_unsupported");
    for (const [event, target] of Object.entries(events)) {
      if (!event || event.length > 200 || typeof target !== "string" || !target || target.length > 200) throw new StudioError("transition_table_shape_unsupported");
      count++; if (count > 2000) throw new StudioError("transition_table_budget");
    }
  }
  return count;
}
const CoverageManifestSchema = z.object({ protocol: z.literal("betterme.coverage-source-binding.v1"), reportHash: hash,
  files: z.array(z.object({ reportPath: z.string().min(1).max(2000), sourcePath: z.string().min(1).max(2000), sourceHash: hash }).strict()).min(1).max(32),
}).strict();
type LcovRecords = Map<string, Map<number, boolean>>;
function parseLcov(text: string): LcovRecords {
  const output: LcovRecords = new Map(); let file: string | undefined, records = new Map<number, boolean>(), found: number | undefined, hit: number | undefined;
  const close = () => {
    if (!file || !records.size || found !== undefined && found !== records.size || hit !== undefined && hit !== [...records.values()].filter(Boolean).length) throw new StudioError("lcov_record_incomplete_or_inconsistent");
    const merged = output.get(file) ?? new Map<number, boolean>(); for (const [line, covered] of records) merged.set(line, Boolean(merged.get(line) || covered)); output.set(file, merged);
    file = undefined; records = new Map(); found = undefined; hit = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith("TN:")) continue;
    if (line.startsWith("SF:")) { if (file) throw new StudioError("lcov_record_not_terminated"); file = line.slice(3); if (!file || file.length > 2000) throw new StudioError("lcov_source_invalid"); continue; }
    if (line === "end_of_record") { close(); continue; }
    if (!file) throw new StudioError("lcov_source_missing");
    if (line.startsWith("DA:")) {
      const match = /^DA:([1-9]\d*),(\d+)(?:,[a-fA-F0-9]{1,64})?$/.exec(line); if (!match) throw new StudioError("lcov_line_invalid");
      const number = Number(match[1]), hits = Number(match[2]); if (!Number.isSafeInteger(number) || !Number.isSafeInteger(hits) || records.has(number)) throw new StudioError("lcov_line_invalid"); records.set(number, hits > 0); continue;
    }
    if (/^(LF|LH):/.test(line)) { const match = /^(LF|LH):(\d+)$/.exec(line); if (!match || !Number.isSafeInteger(Number(match[2]))) throw new StudioError("lcov_summary_invalid"); if (match[1] === "LF") { if (found !== undefined) throw new StudioError("lcov_summary_duplicate"); found = Number(match[2]); } else { if (hit !== undefined) throw new StudioError("lcov_summary_duplicate"); hit = Number(match[2]); } continue; }
    if (/^(FN|FNDA|FNF|FNH|BRDA|BRF|BRH):/.test(line)) continue;
    throw new StudioError("lcov_field_unsupported");
  }
  if (file || !output.size) throw new StudioError("lcov_record_not_terminated"); return output;
}
function coverage(selection: NonNullable<BadgeMetricSelection["coverage"]>): { value: number; scope: string } {
  if (selection.format !== "lcov") throw new StudioError("cobertura_parser_not_available");
  if (!selection.manifest) throw new StudioError("coverage_source_hash_manifest_required");
  const manifest = CoverageManifestSchema.parse(JSON.parse(textOf(selection.manifest)));
  if (manifest.reportHash !== selection.report.sourceHash) throw new StudioError("coverage_report_hash_mismatch");
  if (new Set(manifest.files.map(file => file.reportPath)).size !== manifest.files.length || new Set(manifest.files.map(file => file.sourcePath)).size !== manifest.files.length) throw new StudioError("coverage_manifest_ambiguous");
  const records = parseLcov(textOf(selection.report)), considered = new Map<string, boolean>();
  for (const source of selection.sources) {
    const bound = manifest.files.find(file => file.sourcePath === source.path); if (!bound || bound.sourceHash !== source.sourceHash) throw new StudioError("coverage_source_hash_mismatch");
    const lines = records.get(bound.reportPath); if (!lines) throw new StudioError("coverage_exact_report_path_missing");
    for (const [line, hit] of lines) if (line >= source.startLine && line <= source.endLine) considered.set(`${source.path}:${line}`, hit);
  }
  if (!considered.size) throw new StudioError("coverage_selected_lines_not_reported");
  const hit = [...considered.values()].filter(Boolean).length;
  return { value: Math.round(hit / considered.size * 1000000) / 10000,
    scope: `所选${selection.sources.length}个源码片段内，报告列明DA行${considered.size}、命中${hit}；仅所选报告声明，不是全项目覆盖率或本轮执行认证。` };
}

/** Static/declared observations only. A target hash binds the result receipt;
 * it is never substituted for an actual code/report hash. Missing or invalid
 * measurements stay absent rather than being guessed from code size or prose. */
export async function collectBadgeMetrics(raw: BadgeMetricSelection, options: BadgeMetricOptions): Promise<CollectedBadgeMetrics> {
  const input = selectionInput.parse(raw), signal = budget(options), output: CollectedBadgeMetrics = { schemaVersion: 1, targetHash: input.targetHash, status: "unknown", metrics: {}, metricReceipts: [], unknowns: [],
    limitations: ["targetHash仅绑定调用方选择的回执目标，不表示它等于源码或报告哈希；每项实际输入另列。", "本模块不执行项目代码、项目测试、Git命令或模型；不认证作者、投入工时、生产运行复杂度或业务效果。"] };
  const handles = [...new Set([...(input.transition ? [input.transition.evidence] : []), ...(input.coverage ? [input.coverage.report, ...(input.coverage.manifest ? [input.coverage.manifest] : []), ...input.coverage.sources] : [])])];
  const add = (name: BadgeMetricName, value: number, method: string, scope: string, refs: BadgeMetricInputRef[], limitations: string[]) => {
    const unsigned = { schemaVersion: 1 as const, metric: name, value, targetHash: input.targetHash, method, scope, inputs: refs, executionVerified: false as const, limitations };
    const receipt: BadgeMetricReceipt = { ...unsigned, hash: studioHash(unsigned) }; output.metricReceipts.push(receipt);
    output.metrics[name] = { value, method, scope, sourceHashes: [...new Set(refs.map(ref => ref.kind === "broker_excerpt" ? ref.sourceHash : ref.hash))], receiptHash: receipt.hash };
  };
  const observe = (name: BadgeMetricName, work: () => void) => { try { work(); } catch (error) { output.unknowns.push(`${name}:${error instanceof StudioError ? error.code : "selected_artifact_invalid"}`); } };
  try {
    await current(options.isCurrent, signal); for (const handle of handles) await revalidate(handle, signal);
    if (input.transition) observe("declaredTransitionEntries", () => add("declaredTransitionEntries", transitionEntries(input.transition!.evidence), "explicit_json_state_event_target_literal_count",
      `仅${input.transition!.evidence.path} L${input.transition!.evidence.startLine}–${input.transition!.evidence.endLine}中的JSON声明条目数。`, [input.transition!.evidence], ["静态state→event→target字符串表的声明条目，不是运行时状态机复杂度、执行覆盖、并发能力或个人工作量。", "JSON重复键按JSON解析后的有效映射计算；不声称语法层重复声明数。"]));
    else output.unknowns.push("declaredTransitionEntries:not_selected");
    if (input.coverage) observe("testCoveragePercent", () => { const result = coverage(input.coverage!); add("testCoveragePercent", result.value, "selected_lcov_declared_line_hits_with_source_hash_manifest", result.scope,
      [input.coverage!.report, input.coverage!.manifest!, ...input.coverage!.sources], ["报告与manifest是用户明确选择的文件声明；哈希匹配不证明报告真实运行、测试充分或工具链可信。", "只计算所选片段内报告列出的DA行，不推断未列出的可执行行、全项目或分支覆盖率。"]); });
    else output.unknowns.push("testCoveragePercent:not_selected");
    if (!input.git) output.unknowns.push("evolutionDays:not_selected");
    else if (!options.resolveGitCaptures) output.unknowns.push("evolutionDays:authorized_capture_provider_unavailable");
    else {
      const selected = input.git;
      if (new Set(selected.selectedCommits).size !== selected.selectedCommits.length) throw new StudioError("badge_git_duplicate_commit", 400);
      const captures = await bounded(options.resolveGitCaptures(selected, signal), signal);
      observe("evolutionDays", () => {
        const schema = z.array(z.object({ repositoryId: hash, commit: oid, committedAt: z.string().datetime() }).passthrough()).max(32), validated = schema.parse(captures);
        if (validated.length < 2 || validated.length !== selected.selectedCommits.length || new Set(validated.map(item => item.commit)).size !== validated.length
          || validated.some(item => item.repositoryId !== selected.repositoryId || !selected.selectedCommits.includes(item.commit))) throw new StudioError("badge_git_capture_scope_mismatch");
        const refs = validated.map(item => { const metadata = { repositoryId: item.repositoryId, commit: item.commit, committedAt: item.committedAt }; return { kind: "git_capture_metadata" as const, ...metadata, hash: studioHash(metadata) }; });
        const times = validated.map(item => Date.parse(item.committedAt)), days = Math.round((Math.max(...times) - Math.min(...times)) / 86400000 * 10000) / 10000;
        add("evolutionDays", days, "selected_same_repository_git_committer_timestamp_span", `同仓库明确选择的${validated.length}个提交时间戳跨度；不是连续开发时长。`, refs, ["Git提交时间戳可被设置；只观察已授权元数据，不证明真实投入时间、作者身份、连续演进或本人贡献。"]);
      });
    }
    for (const handle of handles) await revalidate(handle, signal); await current(options.isCurrent, signal);
    output.status = output.metricReceipts.length ? "observed" : "unknown"; return output;
  } catch (error) {
    output.metrics = {}; output.metricReceipts = [];
    const stale = error instanceof StudioError && ["badge_metric_context_stale", "badge_metric_source_changed"].includes(error.code);
    output.status = stale ? "stale" : signal.aborted ? options.signal?.aborted ? "cancelled" : "unknown" : "unknown";
    output.unknowns.push(stale ? "evidence_or_authority_changed" : signal.aborted ? "measurement_cancelled_or_budget_exhausted" : "authorized_measurement_unavailable"); return output;
  }
}

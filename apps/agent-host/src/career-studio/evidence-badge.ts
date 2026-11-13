import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { StudioError, studioHash } from "./storage.js";
import { BadgeMetricReceiptSchema } from "./badge-metrics.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(240);
const metric = z.object({ value: z.number().finite().nonnegative(), sourceHash: hashSchema, method: id, scope: z.string().min(1).max(2000) }).strict();
const measuredMetric = z.object({ value: z.number().finite().nonnegative(), sourceHashes: z.array(hashSchema).min(1).max(32), receiptHash: hashSchema, method: id, scope: z.string().min(1).max(2000) }).strict();
export const BadgeObservationSchema = z.object({ schemaVersion: z.literal(1), artifactId: id, sourceHash: hashSchema,
  receipt: z.object({ id, targetHash: hashSchema, status: z.literal("passed"), verifierVersion: id, checks: z.array(z.string().min(1).max(1000)).min(1).max(100), at: z.string().datetime() }).strict(),
  metrics: z.object({ evolutionDays: z.union([metric, measuredMetric]).optional(), stateTransitions: metric.optional(),
    declaredTransitionEntries: measuredMetric.extend({ value: z.number().int().nonnegative() }).optional(),
    testCoveragePercent: z.union([metric.extend({ value: z.number().finite().min(0).max(100) }), measuredMetric.extend({ value: z.number().finite().min(0).max(100) })]).optional() }).strict(),
  metricReceipts: z.array(BadgeMetricReceiptSchema).max(3).optional(),
  skillIds: z.array(id).max(100), personalContribution: z.enum(["implementation", "design", "not_mine", "unknown"]),
}).strict();
export type BadgeObservation = z.infer<typeof BadgeObservationSchema>;

/** A trusted receipt resolver supplies input; HTTP/model cannot manufacture it.
 * Visual channels encode measured observations, never competence or hiring odds. */
export function compileEvidenceBadge(raw: BadgeObservation) {
  const input = BadgeObservationSchema.parse(raw);
  if (input.receipt.targetHash !== input.sourceHash) throw new StudioError("badge_receipt_source_mismatch");
  for (const [name, observation] of Object.entries(input.metrics)) {
    // Legacy internal observations retain their original exact-source gate.
    // New collector metrics bind their own actual source hashes via a separate
    // measurement receipt; a claim hash is never relabelled as a code hash.
    if ("sourceHash" in observation) { if (observation.sourceHash !== input.sourceHash) throw new StudioError("badge_receipt_source_mismatch"); continue; }
    const receipt = input.metricReceipts?.find(item => item.hash === observation.receiptHash);
    if (!receipt) throw new StudioError("badge_metric_receipt_missing");
    const { hash, ...unsigned } = receipt, actualHashes = [...new Set(receipt.inputs.map(ref => ref.kind === "broker_excerpt" ? ref.sourceHash : ref.hash))];
    if (hash !== studioHash(unsigned) || receipt.targetHash !== input.sourceHash || receipt.metric !== name || receipt.value !== observation.value
      || receipt.method !== observation.method || receipt.scope !== observation.scope || studioHash(actualHashes) !== studioHash(observation.sourceHashes)) throw new StudioError("badge_metric_receipt_mismatch");
  }
  const metrics = input.metrics;
  const entries = metrics.declaredTransitionEntries ?? metrics.stateTransitions;
  const facets = entries ? 6 + Math.min(10, Math.floor(Math.log2(1 + entries.value))) : 6;
  const radius = metrics.evolutionDays ? 0.75 + Math.min(0.55, Math.log2(1 + metrics.evolutionDays.value) / 16) : 0.75;
  const ior = metrics.testCoveragePercent ? 1.4 + metrics.testCoveragePercent.value / 500 : 1.4;
  const spectrum: [number, number, number] = metrics.testCoveragePercent ? [0.3 + metrics.testCoveragePercent.value / 200, 0.64, 0.92] : [0.6, 0.65, 0.7];
  const facetNodes = Array.from({ length: facets }, (_, index) => ({ type: "mesh", name: `facet_${index}`, translation: [Math.cos(index * 2 * Math.PI / facets) * (radius + 0.3), 0.5 + index % 3 * 0.25, Math.sin(index * 2 * Math.PI / facets) * (radius + 0.3)],
    geometry: { std: "box", size: [0.11, 0.2 + (index % 3) * 0.09, 0.11] }, materials: [{ inputs: { base_color: spectrum, base_metalness: 0.85, specular_roughness: 0.2 } }] }));
  const scene = { $schema: "https://voyager.so/vork/schema/scene.schema.json", version: 2, nodes: [
    { type: "mesh", name: "receipt_crystal", translation: [0, 1.2, 0], geometry: { std: "sphere", radius, segments: facets * 4, rings: facets * 2 }, materials: [{ inputs: { base_color: spectrum, transmission_weight: 0.86, specular_roughness: 0.1, specular_ior: ior, coat_weight: 0.5 } }] },
    ...facetNodes,
    { type: "mesh", name: "pedestal", geometry: { std: "grid", size: [20, 20] }, materials: [{ inputs: { base_color: [0.025, 0.03, 0.04], specular_roughness: 0.18 } }] },
    { type: "light", shape: "rectangle", translation: [-4, 6, 4], target: [0, 1, 0], energy: 1800, size: 5, color: [0.5, 0.75, 1] },
    { type: "light", shape: "rectangle", translation: [4, 4, -2], target: [0, 1, 0], energy: 1600, size: 4, color: [1, 0.75, 0.5] },
    { type: "camera", translation: [3.2, 2.7, 5.4], target: [0, 1, 0] },
  ], render: { resolution: [768, 768], duration: 1 } };
  return { id: `badge-${studioHash(input).slice(0, 32)}`, observation: input, scene, sceneHash: studioHash(scene), parameters: { facets, radius, ior, spectrum },
    mapping: [{ channel: "facet_count", metric: metrics.stateTransitions && !metrics.declaredTransitionEntries ? "stateTransitions" : "declaredTransitionEntries", value: entries?.value ?? null, rule: "6 + min(10, floor(log2(1+declared entries))); unknown uses 6; not runtime complexity" },
      { channel: "radius", metric: "evolutionDays", value: metrics.evolutionDays?.value ?? null, rule: ".75 + min(.55, log2(1+days)/16); unknown uses .75" },
      { channel: "refraction_and_color", metric: "testCoveragePercent", value: metrics.testCoveragePercent?.value ?? null, rule: "ior=1.4+percent/500; unknown is neutral; no coverage is inferred" }],
    limitations: ["几何和材质只编码当前测量范围，不是能力分、算力工作量证明或个人真实性认证。", "哈希与 Verification Receipt 只绑定本次检查的版本和范围，不证明作者身份或业务业绩。", "JSON声明条目数不是运行时状态机复杂度；报告行命中不认证本轮执行。", "未观测指标保持未知；不以代码行数、复杂度或测试数量推算吞吐、覆盖率和个人贡献。", "颜色是观测数据的视觉映射，不是物理色散光谱测量。"],
  };
}
export type EvidenceBadge = ReturnType<typeof compileEvidenceBadge>;
let rendering = false;

/** Only the compiler's built-in primitive scene is accepted, in a new private
 * directory per invocation. No caller-supplied scene, texture/file path or shell. */
export async function renderEvidenceBadge(badge: EvidenceBadge, options: { binaryPath: string; ownerId: string; signal: AbortSignal; isCurrent: () => Promise<boolean>; timeoutMs?: number; onProgress?: (phase: "compiling" | "rendering") => void }) {
  if (rendering) throw new StudioError("badge_renderer_busy", 429);
  const compiled = compileEvidenceBadge(badge.observation);
  if (compiled.id !== badge.id || compiled.sceneHash !== badge.sceneHash || studioHash(badge.scene) !== compiled.sceneHash) throw new StudioError("badge_scene_changed");
  const binary = await fs.realpath(options.binaryPath).catch(() => ""), stat = binary && await fs.stat(binary);
  if (!path.isAbsolute(options.binaryPath) || binary !== options.binaryPath || !stat || !stat.isFile() || !options.ownerId || options.signal.aborted || !await options.isCurrent()) throw new StudioError("badge_renderer_unavailable", 503);
  const timeoutMs = Math.min(300_000, options.timeoutMs ?? 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new StudioError("invalid_badge_render_budget", 400);
  if (rendering) throw new StudioError("badge_renderer_busy", 429);
  rendering = true;
  let temp: string | undefined;
  try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-receipt-badge-"));
    await fs.chmod(temp, 0o700); const scene = path.join(temp, "scene.json"), output = path.join(temp, "badge.png");
    await fs.writeFile(scene, JSON.stringify(compiled.scene), { mode: 0o600 });
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]), started = Date.now();
    await new Promise<void>((resolve, reject) => { const child = execFile(binary, ["render", scene, "--out", output, "--profile", "std/draft", "--set", "samples=8", "--set", "denoise=false"], {
      cwd: temp, signal, timeout: timeoutMs, maxBuffer: 32_000, windowsHide: true,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C", HOME: os.homedir(), TMPDIR: temp },
    }, error => error ? reject(new StudioError(signal.aborted ? "badge_render_cancelled" : "badge_render_failed", 503)) : resolve());
      child.stderr?.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); if (/compil|setup|shader/i.test(text)) options.onProgress?.("compiling"); else if (/render|frame/i.test(text)) options.onProgress?.("rendering"); });
    });
    signal.throwIfAborted();
    const outputStat = await fs.lstat(output);
    if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size > 8_000_000) throw new StudioError("invalid_badge_render", 503);
    const bytes = await fs.readFile(output);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== 768 || bytes.readUInt32BE(20) !== 768) throw new StudioError("invalid_badge_render", 503);
    if (!await options.isCurrent() || signal.aborted) throw new StudioError("badge_result_stale");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, receipt: { id: randomUUID(), ownerId: options.ownerId, badgeId: badge.id,
      verificationReceiptId: badge.observation.receipt.id, sourceHash: badge.observation.sourceHash, sceneHash: badge.sceneHash, artifactHash: sha256,
      resolution: [768, 768], renderer: "vork", hardware: "not_measured", elapsedMs: Date.now() - started, at: new Date().toISOString() } };
  } finally { rendering = false; if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}

export type SkillJobLinkInput = { id: string; skillIds: string[]; sourceHash: string; coordinates?: { longitude: number; latitude: number; precision: "office" | "city" | "unknown"; verified: boolean }; persisted: boolean; indexed: boolean };
export function createSkillJobLinks(badge: EvidenceBadge, jobs: readonly SkillJobLinkInput[]) {
  const skills = new Set(badge.observation.personalContribution === "implementation" ? badge.observation.skillIds : []);
  const links = jobs.flatMap(job => {
    const c = job.coordinates, overlap = [...new Set(job.skillIds)].filter(id => skills.has(id));
    if (!job.persisted || !job.indexed || !c?.verified || c.precision !== "office" || !Number.isFinite(c.longitude) || !Number.isFinite(c.latitude) || Math.abs(c.longitude) > 180 || Math.abs(c.latitude) > 90 || !overlap.length || !hashSchema.safeParse(job.sourceHash).success) return [];
    return [{ id: `${badge.id}:${job.id}`, badgeId: badge.id, jobId: job.id, skillIds: overlap, sourceHash: job.sourceHash, longitude: c.longitude, latitude: c.latitude,
      strength: overlap.length / Math.max(1, new Set(job.skillIds).size), meaning: "explicit_skill_evidence_overlap_not_hiring_probability" as const }];
  });
  return { links, excludedJobs: jobs.length - links.length, limitations: ["连线只表示显式技能证据交集，不代表录用概率、岗位仍在招或公司认可。", "仅持久化、已索引且经过办公坐标核对的岗位可上图；不会把城市文本变成办公室。", "技能节点为虚拟空间节点，不是个人住址或实际办公地址。"] };
}

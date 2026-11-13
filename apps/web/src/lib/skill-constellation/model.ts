/** The Host's authorized context, not fields supplied by a model or a map pick. */
export interface SkillConstellationBinding {
  ownerId: string;
  sessionGeneration: number;
  contextId: string;
  revision: string;
}

export interface SkillConstellationBadge {
  id: string;
  label: string;
  verificationReceiptId: string;
  sourceHash: string;
  skillIds: readonly string[];
}

/** Accept only createSkillJobLinks' trusted projection. These fields alone do
 * not prove location provenance; the Host must derive them from the selected,
 * persisted, indexed, verified-office records, never from city text or a model. */
export interface VerifiedSkillJobLink {
  id: string;
  badgeId: string;
  jobId: string;
  skillIds: readonly string[];
  sourceHash: string;
  longitude: number;
  latitude: number;
  strength: number;
  meaning: "explicit_skill_evidence_overlap_not_hiring_probability";
}

/** Display-only metadata deliberately has no coordinates or HTML/URL fields. */
export interface SkillConstellationJobMetadata {
  jobId: string;
  label: string;
  company?: string;
  officeLabel?: string;
}

export interface SkillConstellationEntry extends VerifiedSkillJobLink {
  label: string;
  company?: string;
  officeLabel?: string;
}

export interface SkillConstellationInput {
  binding: SkillConstellationBinding;
  badge: SkillConstellationBadge;
  links: readonly VerifiedSkillJobLink[];
  jobMetadata?: readonly SkillConstellationJobMetadata[];
  excludedJobs?: number;
  limitations?: readonly string[];
}

export interface SkillConstellationModel {
  status: "ready" | "empty" | "invalid";
  binding: SkillConstellationBinding;
  badge: SkillConstellationBadge;
  entries: readonly SkillConstellationEntry[];
  rejectedLinks: readonly { id: string; reason: string }[];
  excludedJobs: number | null;
  limitations: readonly string[];
  /** Dimensionless Earth-centred scene vector; this is NOT an office/address. */
  virtualNode: { kind: "virtual"; position: readonly [number, number, number]; meaning: "evidence_node_not_a_geographic_location" };
  detail?: string;
}

export const SKILL_CONSTELLATION_LIMITS = { links: 500, skills: 100, metadata: 1000, limitations: 30 } as const;
export const SKILL_CONSTELLATION_LIMITATIONS = [
  "连线只表示本次授权版本中的显式技能证据交集，不是录用概率、企业认可或岗位仍在招的证明。",
  "办公点仅采用 Host 从已持久化、已索引、已核对办公坐标的岗位生成的连线；不会由城市名称补点。",
  "技能证据节点是地心空间中的虚拟展示节点，不表示个人住址、工作地或真实办公室。",
  "这里的节点符号与连线不是 Vork 光追渲染；真实渲染图片和文件回执应另行查看。",
] as const;

const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 600 && [...value].every(character => character.charCodeAt(0) >= 32);
const display = (value: unknown, maximum = 240) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const skillList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= SKILL_CONSTELLATION_LIMITS.skills
  && value.every(identifier) && new Set(value).size === value.length;

export function sameSkillConstellationBinding(left: SkillConstellationBinding, right: SkillConstellationBinding): boolean {
  return left.ownerId === right.ownerId && left.sessionGeneration === right.sessionGeneration
    && left.contextId === right.contextId && left.revision === right.revision;
}
export function validSkillConstellationBinding(binding: SkillConstellationBinding): boolean {
  return !!binding && identifier(binding.ownerId) && Number.isSafeInteger(binding.sessionGeneration) && binding.sessionGeneration >= 0
    && identifier(binding.contextId) && identifier(binding.revision);
}

/** This payload key invalidates stale scene picks; it is not a signature. */
export function skillConstellationFingerprint(model: SkillConstellationModel): string {
  return JSON.stringify({ binding: model.binding, badge: model.badge, entries: model.entries, virtualNode: model.virtualNode });
}

export function constellationUnitVector(longitude: number, latitude: number): [number, number, number] {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function virtualNode(entries: readonly VerifiedSkillJobLink[]): SkillConstellationModel["virtualNode"] {
  const vector: [number, number, number] = [0, 0, 0];
  for (const entry of entries) { const unit = constellationUnitVector(entry.longitude, entry.latitude); vector[0] += unit[0]; vector[1] += unit[1]; vector[2] += unit[2]; }
  const magnitude = Math.hypot(...vector);
  // A geometric scene placement, never inferred candidate geography. Antipodal
  // offices have no stable mean direction, so use an explicit non-geographic axis.
  const position: [number, number, number] = magnitude > 1e-8 ? vector.map(value => value / magnitude * 1.65) as [number, number, number] : [0, 0, 1.65];
  return { kind: "virtual", position, meaning: "evidence_node_not_a_geographic_location" };
}

export function prepareSkillConstellation(input: SkillConstellationInput): SkillConstellationModel {
  const base: SkillConstellationModel = { status: "invalid", binding: { ...input.binding }, badge: { ...input.badge, skillIds: [...(input.badge.skillIds ?? [])] },
    entries: [], rejectedLinks: [], excludedJobs: Number.isSafeInteger(input.excludedJobs) && input.excludedJobs! >= 0 ? input.excludedJobs! : null,
    limitations: [...SKILL_CONSTELLATION_LIMITATIONS], virtualNode: virtualNode([]) };
  if (!validSkillConstellationBinding(input.binding)) return { ...base, detail: "缺少有效的当前身份、会话或授权版本。" };
  if (!identifier(input.badge.id) || !display(input.badge.label) || !identifier(input.badge.verificationReceiptId) || !hash(input.badge.sourceHash) || !skillList(input.badge.skillIds)) {
    return { ...base, detail: "徽章缺少有效的来源版本、检查回执或授权技能列表。" };
  }
  if (!Array.isArray(input.links) || input.links.length > SKILL_CONSTELLATION_LIMITS.links
    || input.jobMetadata && (!Array.isArray(input.jobMetadata) || input.jobMetadata.length > SKILL_CONSTELLATION_LIMITS.metadata)
    || input.limitations && (!Array.isArray(input.limitations) || input.limitations.length > SKILL_CONSTELLATION_LIMITS.limitations || !input.limitations.every(item => display(item, 2000)))) {
    return { ...base, detail: "输入超出有界地图范围或格式不可用；请缩小本次目标岗位池，不会静默截断成完整结果。" };
  }
  const metadata = new Map<string, SkillConstellationJobMetadata>();
  for (const item of input.jobMetadata ?? []) {
    if (!identifier(item.jobId) || !display(item.label) || item.company !== undefined && !display(item.company)
      || item.officeLabel !== undefined && !display(item.officeLabel, 500) || metadata.has(item.jobId)) continue;
    metadata.set(item.jobId, { ...item });
  }
  const skills = new Set(input.badge.skillIds), rejected: { id: string; reason: string }[] = [], entries = new Map<string, SkillConstellationEntry>();
  const conflicting = new Set<string>();
  for (let index = 0; index < input.links.length; index++) {
    const link: VerifiedSkillJobLink | undefined = input.links[index];
    const id = link && identifier(link.id) ? link.id : `invalid-link-${index + 1}`;
    if (!link || !identifier(link.id) || !identifier(link.jobId) || link.badgeId !== input.badge.id || !hash(link.sourceHash)
      || link.meaning !== "explicit_skill_evidence_overlap_not_hiring_probability" || !skillList(link.skillIds) || link.skillIds.length === 0
      || !link.skillIds.every(skill => skills.has(skill)) || !Number.isFinite(link.strength) || link.strength <= 0 || link.strength > 1
      || !Number.isFinite(link.longitude) || Math.abs(link.longitude) > 180 || !Number.isFinite(link.latitude) || Math.abs(link.latitude) > 90) {
      rejected.push({ id, reason: "连线的徽章绑定、技能交集、版本哈希或来源坐标无效；未上图。" }); continue;
    }
    const item = metadata.get(link.jobId), entry: SkillConstellationEntry = { ...link, skillIds: [...link.skillIds], label: item?.label ?? link.jobId,
      ...(item?.company ? { company: item.company } : {}), ...(item?.officeLabel ? { officeLabel: item.officeLabel } : {}) };
    const existing = entries.get(link.jobId);
    if (conflicting.has(link.jobId)) { rejected.push({ id, reason: "同一岗位存在冲突连线，保持未知并全部不绘制。" }); continue; }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(entry)) { rejected.push({ id, reason: "完全相同的岗位连线已去重。" }); continue; }
      entries.delete(link.jobId); conflicting.add(link.jobId); rejected.push({ id: existing.id, reason: "同一岗位存在冲突连线，保持未知并全部不绘制。" }, { id, reason: "同一岗位存在冲突连线，保持未知并全部不绘制。" }); continue;
    }
    if ([...entries.values()].some(item => item.id === link.id)) { rejected.push({ id, reason: "连线标识重复，不能作为独立岗位依据。" }); continue; }
    entries.set(link.jobId, entry);
  }
  const accepted = [...entries.values()];
  return { ...base, status: accepted.length ? "ready" : "empty", entries: accepted, rejectedLinks: rejected,
    limitations: [...new Set([...SKILL_CONSTELLATION_LIMITATIONS, ...(input.limitations ?? [])])], virtualNode: virtualNode(accepted) };
}

/** Spherical, dimensionless path geometry, not new office coordinates. All paths
 * terminate at the original supplied longitude/latitude; intermediate samples
 * and the virtual origin must never be persisted as geographic job records. */
export function constellationArc(entry: Pick<VerifiedSkillJobLink, "longitude" | "latitude">, origin: SkillConstellationModel["virtualNode"], segments = 32): readonly [number, number, number][] {
  if (!Number.isInteger(segments) || segments < 2 || segments > 64 || !Number.isFinite(entry.longitude) || Math.abs(entry.longitude) > 180
    || !Number.isFinite(entry.latitude) || Math.abs(entry.latitude) > 90 || origin.position.length !== 3 || !origin.position.every(Number.isFinite)) throw new Error("无效的连线几何预算或来源坐标。");
  const startRadius = Math.hypot(...origin.position);
  if (startRadius < 1.01 || startRadius > 3) throw new Error("虚拟节点必须在地球之外，不能作为办公坐标。");
  const start = origin.position.map(value => value / startRadius), end = constellationUnitVector(entry.longitude, entry.latitude);
  const dot = Math.max(-1, Math.min(1, start[0]! * end[0] + start[1]! * end[1] + start[2]! * end[2])), angle = Math.acos(dot);
  let tangent = end.map((value, index) => value - dot * start[index]!);
  const length = Math.hypot(...tangent);
  if (length < 1e-8) {
    const axis = Math.abs(start[2]!) < .8 ? [0, 0, 1] : [0, 1, 0];
    tangent = [start[1]! * axis[2]! - start[2]! * axis[1]!, start[2]! * axis[0]! - start[0]! * axis[2]!, start[0]! * axis[1]! - start[1]! * axis[0]!];
  }
  const tangentLength = Math.hypot(...tangent); tangent = tangent.map(value => value / tangentLength);
  return Array.from({ length: segments + 1 }, (_, index) => {
    if (index === 0) return [...origin.position] as [number, number, number];
    if (index === segments) return end;
    const t = index / segments, radius = 1 + (startRadius - 1) * (1 - t) + Math.sin(t * Math.PI) * .15;
    return start.map((value, dimension) => (value * Math.cos(angle * t) + tangent[dimension]! * Math.sin(angle * t)) * radius) as [number, number, number];
  });
}

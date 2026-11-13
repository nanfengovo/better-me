/** 绑定来自宿主身份与授权快照；图中的文字、模型输出不能授予权限。 */
export interface ArchitectureBinding {
  ownerId: string;
  sessionGeneration: number;
  projectId: string;
  revision: string;
  contentHash: string;
}
export function sameArchitectureBinding(left: ArchitectureBinding, right: ArchitectureBinding): boolean {
  return left.ownerId === right.ownerId && left.sessionGeneration === right.sessionGeneration
    && left.projectId === right.projectId && left.revision === right.revision && left.contentHash === right.contentHash;
}
export interface ArchitectureEvidence {
  id: string;
  label: string;
  excerpt: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}
export type ArchitectureNodeKind = "client" | "service" | "store" | "queue" | "external";
export type ArchitectureGuard = "yes" | "no" | "unknown";
export interface ArchitectureNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  x: number;
  y: number;
  notes: string;
  evidenceIds: string[];
  /** 这是用户给模型的假设，不是对真实系统实现的认证。 */
  guards: { diskFull: ArchitectureGuard; sessionEpoch: ArchitectureGuard; idempotency: ArchitectureGuard };
}
export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: "request" | "read" | "write" | "event";
  failurePolicy: "propagate" | "isolate" | "unknown";
  sessionPolicy: "validate" | "forward" | "unknown";
  evidenceIds: string[];
}
export interface ArchitectureAnnotation { id: string; x: number; y: number; text: string }
export type ArchitectureFaultKind = "disk-full" | "session-switch" | "network-timeout" | "duplicate-event";
export type ArchitectureFaultState = "failed" | "at-risk" | "contained" | "unknown" | "unaffected";
export interface ArchitectureFaultRun {
  id: string;
  simulated: true;
  binding: ArchitectureBinding;
  graphFingerprint: string;
  graphRevision: number;
  fault: { kind: ArchitectureFaultKind; targetNodeId: string };
  outcomes: { nodeId: string; state: ArchitectureFaultState; detail: string; evidenceIds: string[] }[];
  propagation: { edgeId: string; from: string; to: string; state: ArchitectureFaultState }[];
  steps: number;
  truncated: boolean;
  assumptions: string[];
}
export interface ArchitectureQuestion {
  id: string;
  text: string;
  evidenceIds: string[];
  unknowns: string[];
}
export interface ArchitectureReview {
  support: "supported" | "partial" | "contradicted" | "unknown";
  summary: string;
  strengths: string[];
  gaps: string[];
  followUps: string[];
  evidenceIds: string[];
}
export interface ArchitectureInterviewTurn {
  id: string;
  graphRevision: number;
  graphFingerprint: string;
  faultRunId?: string;
  question: ArchitectureQuestion;
  answer?: string;
  draftAnswer?: string;
  review?: ArchitectureReview;
  createdAt: string;
}
export interface ArchitectureDocument {
  schemaVersion: 1;
  id: string;
  binding: ArchitectureBinding;
  title: string;
  revision: number;
  graphRevision: number;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  annotations: ArchitectureAnnotation[];
  evidence: ArchitectureEvidence[];
  faults: ArchitectureFaultRun[];
  turns: ArchitectureInterviewTurn[];
}

export const ARCHITECTURE_CANVAS = { width: 1200, height: 760, nodeWidth: 180, nodeHeight: 84 } as const;
export const ARCHITECTURE_LIMITS = { nodes: 80, edges: 160, annotations: 80, evidence: 200, turns: 80, faults: 80 } as const;
export const NODE_KIND_LABELS: Record<ArchitectureNodeKind, string> = { client: "客户端", service: "服务", store: "存储", queue: "队列", external: "外部服务" };
export const FAULT_KIND_LABELS: Record<ArchitectureFaultKind, string> = { "disk-full": "磁盘写满", "session-switch": "中途切换账号", "network-timeout": "网络超时", "duplicate-event": "重复事件" };

export function cloneArchitectureDocument(document: ArchitectureDocument): ArchitectureDocument {
  return JSON.parse(JSON.stringify(document)) as ArchitectureDocument;
}
export function createArchitectureDocument(binding: ArchitectureBinding, evidence: readonly ArchitectureEvidence[] = [], id = "architecture-document"): ArchitectureDocument {
  return { schemaVersion: 1, id, binding: { ...binding }, title: "项目架构推演", revision: 0, graphRevision: 0,
    nodes: [], edges: [], annotations: [], evidence: evidence.map(item => ({ ...item })), faults: [], turns: [] };
}
/** 稳定载荷键只用于版本对账，不是签名、作者身份或事实证明。 */
export function architectureGraphFingerprint(document: ArchitectureDocument): string {
  return JSON.stringify({ binding: document.binding, graphRevision: document.graphRevision, title: document.title,
    nodes: document.nodes, edges: document.edges, annotations: document.annotations, evidence: document.evidence });
}
export function architectureDocumentFingerprint(document: ArchitectureDocument): string { return JSON.stringify(document); }

/** Host-owned load seam for a stable project ID after reauthorization/restart.
 * It creates an UNSAVED graph draft, not a new grant, verified result or rewrite
 * of the historical record. The caller must retain old versions, use the loaded
 * storage CAS token, and require explicit preview/replace confirmation in UI. */
export function rebindArchitectureGraphDraft(document: ArchitectureDocument, currentBinding: ArchitectureBinding,
  authorizedEvidence: readonly ArchitectureEvidence[]): ArchitectureDocument {
  if (validateArchitectureDocument(document).length || document.binding.ownerId !== currentBinding.ownerId
    || document.binding.projectId !== currentBinding.projectId || document.binding.contentHash !== currentBinding.contentHash) {
    throw new Error("旧图与当前owner、稳定项目或源资料指纹不符，不能继承为当前授权草稿。");
  }
  const fresh = authorizedEvidence.map(item => ({ ...item }));
  const sameEvidence = (old: ArchitectureEvidence, current: ArchitectureEvidence) => old.id === current.id && old.label === current.label && old.excerpt === current.excerpt
    && old.path === current.path && old.startLine === current.startLine && old.endLine === current.endLine;
  const retained = new Set(document.evidence.filter(old => fresh.some(current => sameEvidence(old, current))).map(item => item.id));
  const next = cloneArchitectureDocument(document);
  next.binding = { ...currentBinding }; next.revision++; next.graphRevision++;
  next.evidence = fresh;
  next.nodes = next.nodes.map(node => ({ ...node, evidenceIds: node.evidenceIds.filter(id => retained.has(id)) }));
  next.edges = next.edges.map(edge => ({ ...edge, evidenceIds: edge.evidenceIds.filter(id => retained.has(id)) }));
  // Old simulation/model claims belong only to their old graph/scope. The Host
  // retains them in history; they cannot masquerade as this session's evidence.
  next.faults = []; next.turns = [];
  if (validateArchitectureDocument(next).length) throw new Error("当前授权库存或重绑定草稿结构无效，没有采用旧图。");
  return next;
}

function uniqueIds(items: readonly { id: string }[]) { return items.every(item => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 160) && new Set(items.map(item => item.id)).size === items.length; }
const boundedString = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;
const validPoint = (item: { x: number; y: number }) => Number.isFinite(item.x) && Number.isFinite(item.y) && item.x >= 0 && item.y >= 0
  && item.x <= ARCHITECTURE_CANVAS.width && item.y <= ARCHITECTURE_CANVAS.height;
const referencesExist = (ids: readonly string[], allowed: Set<string>) => Array.isArray(ids) && ids.length <= 200 && ids.every(id => allowed.has(id));

/** 存储和模型 Adapter 的输入输出仍需在宿主做权限检查；这里校验结构和引用。 */
export function validateArchitectureDocument(document: ArchitectureDocument): string[] {
  const errors: string[] = [];
  try {
    if (document.schemaVersion !== 1 || !document.id || !document.binding.ownerId || !document.binding.projectId
      || !document.binding.revision || !document.binding.contentHash || !Number.isSafeInteger(document.binding.sessionGeneration)
      || document.binding.sessionGeneration < 0 || !Number.isSafeInteger(document.revision) || document.revision < 0
      || !Number.isSafeInteger(document.graphRevision) || document.graphRevision < 0) errors.push("版本或身份绑定无效");
    if (!boundedString(document.title, 120) || !document.title.trim()) errors.push("请填写图的标题（最多120字）");
    for (const [key, maximum] of Object.entries(ARCHITECTURE_LIMITS)) {
      const items = document[key as keyof typeof ARCHITECTURE_LIMITS];
      if (!Array.isArray(items) || items.length > maximum || !uniqueIds(items)) errors.push(`${key} 超出数量限制或包含重复标识`);
    }
    if (errors.length) return errors;
    const evidenceIds = new Set(document.evidence.map(item => item.id)), nodeIds = new Set(document.nodes.map(item => item.id));
    for (const item of document.evidence) {
      if (!boundedString(item.label, 240) || !boundedString(item.excerpt, 12000) || (item.path !== undefined && !boundedString(item.path, 1000))
        || (item.startLine !== undefined && (!Number.isSafeInteger(item.startLine) || item.startLine < 1))
        || (item.endLine !== undefined && (!Number.isSafeInteger(item.endLine) || item.endLine < (item.startLine ?? 1)))) errors.push(`引用 ${item.id} 结构无效`);
    }
    for (const node of document.nodes) {
      if (!boundedString(node.label, 80) || !node.label.trim() || !Object.hasOwn(NODE_KIND_LABELS, node.kind) || !validPoint(node)
        || node.x > ARCHITECTURE_CANVAS.width - ARCHITECTURE_CANVAS.nodeWidth || node.y > ARCHITECTURE_CANVAS.height - ARCHITECTURE_CANVAS.nodeHeight
        || !boundedString(node.notes, 4000) || !referencesExist(node.evidenceIds, evidenceIds)
        || !node.guards || [node.guards.diskFull, node.guards.sessionEpoch, node.guards.idempotency].some(value => !["yes", "no", "unknown"].includes(value))) errors.push(`节点 ${node.id} 需要完整名称、有效坐标与引用`);
    }
    for (const edge of document.edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !boundedString(edge.label, 160)
        || !["request", "read", "write", "event"].includes(edge.kind) || !["propagate", "isolate", "unknown"].includes(edge.failurePolicy)
        || !["validate", "forward", "unknown"].includes(edge.sessionPolicy) || !referencesExist(edge.evidenceIds, evidenceIds)) errors.push(`连线 ${edge.id} 的端点、策略或引用无效`);
    }
    for (const note of document.annotations) if (!validPoint(note) || note.x > ARCHITECTURE_CANVAS.width - 220 || note.y > ARCHITECTURE_CANVAS.height - 56 || !boundedString(note.text, 2000)) errors.push(`标注 ${note.id} 无效`);
    const graphKey = architectureGraphFingerprint(document);
    for (const fault of document.faults) {
      if (fault.simulated !== true || !sameArchitectureBinding(fault.binding, document.binding)
        || !boundedString(fault.graphFingerprint, 1_000_000) || !fault.graphFingerprint
        || !Number.isSafeInteger(fault.graphRevision) || fault.graphRevision < 0 || fault.graphRevision > document.graphRevision
        || !Object.hasOwn(FAULT_KIND_LABELS, fault.fault.kind) || !boundedString(fault.fault.targetNodeId, 160)
        || !Array.isArray(fault.outcomes) || fault.outcomes.length > ARCHITECTURE_LIMITS.nodes
        || !fault.outcomes.every(item => boundedString(item.nodeId, 160) && ["failed", "at-risk", "contained", "unknown", "unaffected"].includes(item.state)
          && boundedString(item.detail, 4000) && referencesExist(item.evidenceIds, evidenceIds))
        || !Array.isArray(fault.propagation) || fault.propagation.length > 10000
        || !fault.propagation.every(item => boundedString(item.edgeId, 160) && boundedString(item.from, 160) && boundedString(item.to, 160)
          && ["failed", "at-risk", "contained", "unknown", "unaffected"].includes(item.state))
        || !Number.isSafeInteger(fault.steps) || fault.steps < 0 || fault.steps > 10000 || typeof fault.truncated !== "boolean"
        || !Array.isArray(fault.assumptions) || fault.assumptions.length > 20 || fault.assumptions.some(item => !boundedString(item, 2000))) errors.push(`故障记录 ${fault.id} 无效或越界`);
    }
    for (const turn of document.turns) {
      if (!boundedString(turn.question.id, 160) || !turn.question.id || !boundedString(turn.question.text, 6000) || !referencesExist(turn.question.evidenceIds, evidenceIds)
        || !Array.isArray(turn.question.unknowns) || turn.question.unknowns.length > 30 || turn.question.unknowns.some(value => !boundedString(value, 2000))
        || (turn.answer !== undefined && !boundedString(turn.answer, 12000))
        || (turn.draftAnswer !== undefined && !boundedString(turn.draftAnswer, 12000))
        || (turn.review && (!referencesExist(turn.review.evidenceIds, evidenceIds) || !boundedString(turn.review.summary, 6000)
          || !["supported", "partial", "contradicted", "unknown"].includes(turn.review.support)
          || (!turn.review.evidenceIds.length && turn.review.support !== "unknown")
          || [turn.review.strengths, turn.review.gaps, turn.review.followUps].some(items => !Array.isArray(items) || items.length > 30 || items.some(item => !boundedString(item, 2000)))))) errors.push(`问答 ${turn.id} 无效或引用越界`);
      // 旧回合可以保留，不要求它继续匹配当前图；模型调用必须另行核对 graphFingerprint。
      if (!turn.graphFingerprint || turn.graphFingerprint.length > 1_000_000 || !Number.isSafeInteger(turn.graphRevision) || turn.graphRevision < 0 || turn.graphRevision > document.graphRevision
        || !Number.isFinite(Date.parse(turn.createdAt)) || (turn.faultRunId !== undefined && !document.faults.some(fault => fault.id === turn.faultRunId))) errors.push(`问答 ${turn.id} 缺少版本`);
    }
    if (graphKey.length > 1_000_000 || architectureDocumentFingerprint(document).length > 4_000_000) errors.push("图与会话超过有界载荷预算");
  } catch { errors.push("文档结构不完整，未读取或采用"); }
  return errors;
}

export type ArchitectureCommand =
  | { type: "add-node"; node: ArchitectureNode }
  | { type: "update-node"; id: string; patch: Partial<Omit<ArchitectureNode, "id">> }
  | { type: "remove-node"; id: string }
  | { type: "add-edge"; edge: ArchitectureEdge }
  | { type: "update-edge"; id: string; patch: Partial<Omit<ArchitectureEdge, "id">> }
  | { type: "remove-edge"; id: string }
  | { type: "add-annotation"; annotation: ArchitectureAnnotation }
  | { type: "update-annotation"; id: string; patch: Partial<Omit<ArchitectureAnnotation, "id">> }
  | { type: "remove-annotation"; id: string }
  | { type: "rename"; title: string };

/** 允许表单暂时清空名称；保存/推演/模型调用前必须 validate。 */
export function applyArchitectureCommand(document: ArchitectureDocument, command: ArchitectureCommand): ArchitectureDocument {
  const next = cloneArchitectureDocument(document);
  switch (command.type) {
    case "add-node":
      if (next.nodes.length >= ARCHITECTURE_LIMITS.nodes || next.nodes.some(node => node.id === command.node.id)) throw new Error("节点数量已达上限或标识重复");
      next.nodes.push({ ...command.node, guards: { ...command.node.guards }, evidenceIds: [...command.node.evidenceIds] }); break;
    case "update-node": next.nodes = next.nodes.map(node => node.id === command.id ? { ...node, ...command.patch } : node); break;
    case "remove-node": next.nodes = next.nodes.filter(node => node.id !== command.id); next.edges = next.edges.filter(edge => edge.from !== command.id && edge.to !== command.id); break;
    case "add-edge":
      if (next.edges.length >= ARCHITECTURE_LIMITS.edges || next.edges.some(edge => edge.id === command.edge.id)
        || !next.nodes.some(node => node.id === command.edge.from) || !next.nodes.some(node => node.id === command.edge.to)) throw new Error("连线数量、标识或端点无效");
      next.edges.push({ ...command.edge, evidenceIds: [...command.edge.evidenceIds] }); break;
    case "update-edge": next.edges = next.edges.map(edge => edge.id === command.id ? { ...edge, ...command.patch } : edge); break;
    case "remove-edge": next.edges = next.edges.filter(edge => edge.id !== command.id); break;
    case "add-annotation":
      if (next.annotations.length >= ARCHITECTURE_LIMITS.annotations || next.annotations.some(note => note.id === command.annotation.id)) throw new Error("标注数量已达上限或标识重复");
      next.annotations.push({ ...command.annotation }); break;
    case "update-annotation": next.annotations = next.annotations.map(note => note.id === command.id ? { ...note, ...command.patch } : note); break;
    case "remove-annotation": next.annotations = next.annotations.filter(note => note.id !== command.id); break;
    case "rename": next.title = command.title; break;
  }
  next.revision++;
  next.graphRevision++;
  return next;
}

export function newArchitectureNode(id: string, kind: ArchitectureNodeKind, x = 60, y = 60): ArchitectureNode {
  return { id, kind, label: NODE_KIND_LABELS[kind], x, y, notes: "", evidenceIds: [], guards: { diskFull: "unknown", sessionEpoch: "unknown", idempotency: "unknown" } };
}

export function clientToArchitecturePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return undefined;
  return { x: (clientX - rect.left) * ARCHITECTURE_CANVAS.width / rect.width,
    y: (clientY - rect.top) * ARCHITECTURE_CANVAS.height / rect.height };
}

/** 导出不是恢复凭据，不携带 owner/session、资料原文或本机绝对路径。 */
export function exportArchitectureArtifact(document: ArchitectureDocument): { filename: string; mime: string; text: string } {
  const errors = validateArchitectureDocument(document);
  if (errors.length) throw new Error(errors.join("；"));
  const snapshot = cloneArchitectureDocument(document);
  const artifact = { schemaVersion: 1, kind: "betterme-architecture-snapshot", simulated: true,
    source: { projectId: snapshot.binding.projectId, revision: snapshot.binding.revision, contentHash: snapshot.binding.contentHash },
    document: { id: snapshot.id, title: snapshot.title, revision: snapshot.revision, graphRevision: snapshot.graphRevision,
      nodes: snapshot.nodes, edges: snapshot.edges, annotations: snapshot.annotations,
      evidence: snapshot.evidence.map(item => ({ id: item.id, label: item.label, startLine: item.startLine, endLine: item.endLine })),
      faults: snapshot.faults.map(({ binding: _binding, graphFingerprint: _fingerprint, ...fault }) => fault),
      turns: snapshot.turns.map(({ graphFingerprint: _fingerprint, ...turn }) => turn) },
    warning: "仅为用户绘制的模拟图与问答。引用原文已排除；注释、名称与回答仍可能包含用户输入的敏感内容，请在分享前人工核对。" };
  return { filename: `architecture-${encodeURIComponent(snapshot.id)}-r${snapshot.revision}.json`, mime: "application/json", text: JSON.stringify(artifact, null, 2) };
}

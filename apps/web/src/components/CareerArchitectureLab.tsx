import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Download, Link2, Plus, Redo2, Save, Square, StickyNote, Undo2 } from "lucide-react";
import {
  ARCHITECTURE_CANVAS, ARCHITECTURE_LIMITS, FAULT_KIND_LABELS, NODE_KIND_LABELS,
  applyArchitectureCommand, architectureDocumentFingerprint, architectureGraphFingerprint, clientToArchitecturePoint,
  cloneArchitectureDocument, createArchitectureDocument, exportArchitectureArtifact, newArchitectureNode,
  rebindArchitectureGraphDraft, runArchitectureOperation, sameArchitectureBinding, simulateArchitectureFault, validateArchitectureDocument,
  validateArchitectureInterviewEnvelope, validateArchitectureSaveReceipt, validateArchitectureStoredRecord,
  type ArchitectureAnnotation, type ArchitectureBinding, type ArchitectureCommand, type ArchitectureDocument,
  type ArchitectureEdge, type ArchitectureEvidence, type ArchitectureEvidenceImport, type ArchitectureFaultKind,
  type ArchitectureGuard, type ArchitectureInterviewContext, type ArchitectureInterviewerAdapter,
  type ArchitectureNode, type ArchitectureNodeKind, type ArchitectureSaveReceipt, type ArchitectureStorageAdapter,
  type ArchitectureStoredRecord,
} from "../lib/architecture-lab";
import "./CareerArchitectureLab.css";

export interface CareerArchitectureLabProps {
  binding: ArchitectureBinding;
  /** 本次明确授权给模拟面试的资料快照；不会自行读源码或扫描仓库。 */
  evidence?: readonly ArchitectureEvidence[];
  initialDocument?: ArchitectureDocument;
  getCurrentBinding(): ArchitectureBinding;
  storage?: ArchitectureStorageAdapter;
  interviewer?: ArchitectureInterviewerAdapter;
  /** Explicit reuse of an already authorized, completed readset; not a scanner. */
  importEvidence?(binding: ArchitectureBinding, signal: AbortSignal): Promise<ArchitectureEvidenceImport>;
  onEvidenceInventoryChanged?(evidence: readonly ArchitectureEvidence[]): void;
  onSaved?(document: ArchitectureDocument, receipt: Extract<ArchitectureSaveReceipt, { status: "saved" }>): void;
  onExport?(artifact: { filename: string; mime: string; text: string }): void;
  operationTimeoutMs?: number;
}

type Selection = { kind: "node" | "edge" | "annotation"; id: string } | undefined;
type GraphSnapshot = Pick<ArchitectureDocument, "title" | "nodes" | "edges" | "annotations">;
type Drag = { pointerId: number; kind: "node" | "annotation"; id: string; start: { x: number; y: number }; origin: { x: number; y: number }; before: GraphSnapshot; moved: boolean };
const stateLabels = { failed: "注入点不可用", "at-risk": "假设下有风险", contained: "假设下已阻断", unknown: "未知", unaffected: "图内未触及" } as const;
const supportLabels = { supported: "有证据支持", partial: "部分支持", contradicted: "存在冲突", unknown: "证据未知" } as const;
const short = (text: string, limit = 20) => Array.from(text).slice(0, limit).join("") + (Array.from(text).length > limit ? "…" : "");
const graphSnapshot = (document: ArchitectureDocument): GraphSnapshot => JSON.parse(JSON.stringify({ title: document.title, nodes: document.nodes, edges: document.edges, annotations: document.annotations })) as GraphSnapshot;
const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));
let nextLocalId = 0;
const localId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++nextLocalId}`}`;

function initialState(props: CareerArchitectureLabProps): { document: ArchitectureDocument; error: string } {
  const fallback = createArchitectureDocument(props.binding, props.evidence ?? [], `architecture-${props.binding.projectId.slice(0, 100)}`);
  const candidate = props.initialDocument ?? fallback;
  const error = !sameArchitectureBinding(candidate.binding, props.binding) ? "初始记录的账号或项目版本不匹配，未读取。" : validateArchitectureDocument(candidate).join("；");
  return error ? { document: createArchitectureDocument(props.binding), error } : { document: cloneArchitectureDocument(candidate), error: "" };
}

export default function CareerArchitectureLab(props: CareerArchitectureLabProps) {
  return <ArchitectureSession key={JSON.stringify(props.binding)} {...props} />;
}
export { CareerArchitectureLab };

function ArchitectureSession(props: CareerArchitectureLabProps) {
  const [initial] = useState(() => initialState(props));
  const [document, setDocument] = useState(initial.document);
  const documentRef = useRef(document); documentRef.current = document;
  const [selection, setSelection] = useState<Selection>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(initial.error);
  const [working, setWorking] = useState("");
  const operation = useRef<AbortController | null>(null), alive = useRef(true);
  const [storageVersion, setStorageVersion] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [loaded, setLoaded] = useState<ArchitectureStoredRecord | null>(null);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [pendingEvidence, setPendingEvidence] = useState<(ArchitectureEvidenceImport & { fingerprint: string })>();
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const [exportArtifact, setExportArtifact] = useState<ReturnType<typeof exportArchitectureArtifact>>();
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [zoom, setZoom] = useState(100);
  const canvas = useRef<SVGSVGElement>(null), viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [connectFrom, setConnectFrom] = useState<string>();
  const connection = useRef<{ from: string; pointerId: number } | null>(null);
  const suppressPortClick = useRef<string | undefined>(undefined);
  const [connectionPoint, setConnectionPoint] = useState<{ x: number; y: number }>();
  const history = useRef<{ past: GraphSnapshot[]; future: GraphSnapshot[] }>({ past: [], future: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [faultKind, setFaultKind] = useState<ArchitectureFaultKind>("disk-full");
  const [targetId, setTargetId] = useState("");
  const [askConsent, setAskConsent] = useState(false), [reviewConsent, setReviewConsent] = useState(false);
  const [answer, setAnswer] = useState("");
  const answerRef = useRef(answer); answerRef.current = answer;
  const markerId = useId().replace(/:/g, ""), helpId = useId(), titleId = useId();
  void historyVersion;
  const graphKey = architectureGraphFingerprint(document);
  const currentFault = [...document.faults].reverse().find(fault => fault.graphFingerprint === graphKey);
  const currentTurn = [...document.turns].reverse().find(turn => turn.graphFingerprint === graphKey && turn.faultRunId === currentFault?.id);
  const selectedNode = selection?.kind === "node" ? document.nodes.find(node => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? document.edges.find(edge => edge.id === selection.id) : undefined;
  const selectedAnnotation = selection?.kind === "annotation" ? document.annotations.find(note => note.id === selection.id) : undefined;
  const faultTargets = document.nodes.filter(node => faultKind !== "disk-full" || node.kind === "store");
  const selectedTarget = faultTargets.find(node => node.id === targetId)?.id ?? faultTargets[0]?.id ?? "";
  const busy = !!working;
  let currentBinding = false;
  try { currentBinding = !!props.binding.ownerId && sameArchitectureBinding(props.binding, props.getCurrentBinding()); } catch { /* 不读取旧账号图。 */ }

  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => { const draft = currentTurn?.draftAnswer ?? ""; setAnswer(draft); answerRef.current = draft; setReviewConsent(false); }, [currentTurn?.id, currentTurn?.draftAnswer]);

  function checkCurrent() {
    try {
      if (sameArchitectureBinding(props.binding, props.getCurrentBinding()) && props.binding.ownerId) return true;
    } catch { /* 失效保持失效。 */ }
    setError("账号、会话或授权项目版本已变化，请重新打开本面试舱。");
    operation.current?.abort();
    return false;
  }
  function update(next: ArchitectureDocument, graphChanged = false) {
    documentRef.current = next; setDocument(next);
    if (graphChanged) { setAskConsent(false); setReviewConsent(false); setAnswer(""); setExportArtifact(undefined); setConnectFrom(undefined); connection.current = null; setConnectionPoint(undefined); }
  }
  function pushHistory(snapshot: GraphSnapshot) {
    history.current.past = [...history.current.past.slice(-49), snapshot]; history.current.future = []; setHistoryVersion(value => value + 1);
  }
  function mutate(command: ArchitectureCommand, record = true) {
    if (!checkCurrent()) return;
    try {
      const before = documentRef.current;
      const next = applyArchitectureCommand(before, command);
      if (record) pushHistory(graphSnapshot(before));
      update(next, true); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "这次编辑没有应用。"); }
  }
  function restoreGraph(snapshot: GraphSnapshot) {
    update({ ...documentRef.current, ...snapshot, revision: documentRef.current.revision + 1, graphRevision: documentRef.current.graphRevision + 1 }, true);
  }
  function undo(redo = false) {
    if (!checkCurrent()) return;
    const from = redo ? history.current.future : history.current.past;
    const snapshot = from.pop(); if (!snapshot) return;
    const into = redo ? history.current.past : history.current.future;
    into.push(graphSnapshot(documentRef.current)); restoreGraph(snapshot); setHistoryVersion(value => value + 1);
    setNotice(redo ? "已重做图编辑，历史问答未覆盖。" : "已撤销图编辑，历史问答未覆盖。");
  }
  function addNode(kind: ArchitectureNodeKind) {
    const id = localId("node"), offset = document.nodes.length % 8 * 24;
    mutate({ type: "add-node", node: newArchitectureNode(id, kind, 60 + offset, 60 + offset) }); setSelection({ kind: "node", id });
  }
  function addAnnotation() {
    const id = localId("note"); mutate({ type: "add-annotation", annotation: { id, x: 300, y: 60, text: "待核对的架构假设" } }); setSelection({ kind: "annotation", id });
  }
  function removeSelected() {
    if (!selection) return;
    mutate({ type: selection.kind === "node" ? "remove-node" : selection.kind === "edge" ? "remove-edge" : "remove-annotation", id: selection.id }); setSelection(undefined);
  }
  function graphPoint(event: { clientX: number; clientY: number }) {
    return canvas.current ? clientToArchitecturePoint(event.clientX, event.clientY, canvas.current.getBoundingClientRect()) : undefined;
  }
  function capture(pointerId: number) { try { canvas.current?.setPointerCapture?.(pointerId); } catch { /* DOM降级仍有键盘和表单。 */ } }
  function release(pointerId: number) { try { canvas.current?.releasePointerCapture?.(pointerId); } catch { /* 捕获可能已释放。 */ } }
  function beginDrag(event: PointerEvent<SVGGElement>, item: ArchitectureNode | ArchitectureAnnotation, kind: "node" | "annotation") {
    if (!checkCurrent() || drag.current || connection.current || event.button !== 0) return;
    const point = graphPoint(event); if (!point) return;
    event.stopPropagation(); event.preventDefault(); event.currentTarget.focus();
    setSelection({ kind, id: item.id });
    drag.current = { pointerId: event.pointerId, kind, id: item.id, start: point, origin: { x: item.x, y: item.y }, before: graphSnapshot(documentRef.current), moved: false };
    capture(event.pointerId);
  }
  function completeConnection(to: string) {
    const from = connection.current?.from ?? connectFrom;
    if (!from || !checkCurrent()) return;
    if (from === to) { setNotice("请选择另一个节点；显式画出队列或重试节点能更清楚表达环路。"); return; }
    const id = localId("edge");
    mutate({ type: "add-edge", edge: { id, from, to, label: "", kind: "request", failurePolicy: "unknown", sessionPolicy: "unknown", evidenceIds: [] } });
    setSelection({ kind: "edge", id }); setConnectFrom(undefined); connection.current = null; setConnectionPoint(undefined); setNotice("已建立连线。请在详情中声明传播/会话策略；默认保持未知。");
  }
  function beginConnection(event: PointerEvent<SVGCircleElement>, node: ArchitectureNode) {
    if (!checkCurrent() || drag.current || connection.current || event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    connection.current = { from: node.id, pointerId: event.pointerId }; setConnectFrom(node.id);
    suppressPortClick.current = node.id;
    setConnectionPoint({ x: node.x + ARCHITECTURE_CANVAS.nodeWidth, y: node.y + ARCHITECTURE_CANVAS.nodeHeight / 2 }); capture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const point = graphPoint(event); if (!point) return;
    const moving = drag.current;
    if (moving && moving.pointerId === event.pointerId) {
      if (!moving.moved) { pushHistory(moving.before); moving.moved = true; }
      const x = clamp(moving.origin.x + point.x - moving.start.x, ARCHITECTURE_CANVAS.width - (moving.kind === "node" ? ARCHITECTURE_CANVAS.nodeWidth : 220));
      const y = clamp(moving.origin.y + point.y - moving.start.y, ARCHITECTURE_CANVAS.height - (moving.kind === "node" ? ARCHITECTURE_CANVAS.nodeHeight : 56));
      // 指针编辑不重设连线状态，也不为每一个像素建立撤销项。
      mutate({ type: moving.kind === "node" ? "update-node" : "update-annotation", id: moving.id, patch: { x, y } }, false);
    } else if (connection.current?.pointerId === event.pointerId) setConnectionPoint(point);
  }
  function pointerEnd(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const moving = drag.current;
    if (moving?.pointerId === event.pointerId) {
      drag.current = null; release(event.pointerId);
      if (cancelled && moving.moved) restoreGraph(moving.before);
      return;
    }
    const drawing = connection.current;
    if (drawing?.pointerId !== event.pointerId) return;
    const point = graphPoint(event); release(event.pointerId);
    if (!cancelled && point) {
      const target = documentRef.current.nodes.find(node => Math.hypot(point.x - node.x, point.y - (node.y + ARCHITECTURE_CANVAS.nodeHeight / 2)) <= 28);
      if (target) { completeConnection(target.id); return; }
    }
    connection.current = null; setConnectionPoint(undefined);
    if (cancelled) setConnectFrom(undefined); else setNotice("已选择起点。点击另一节点左侧端点，或用Tab定位端点后按Enter完成连线。");
  }
  function itemKey(event: KeyboardEvent<SVGElement>, item: ArchitectureNode | ArchitectureAnnotation, kind: "node" | "annotation") {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelection({ kind, id: item.id }); return; }
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault(); const step = event.shiftKey ? 24 : 8;
      mutate({ type: kind === "node" ? "update-node" : "update-annotation", id: item.id,
        patch: { x: clamp(item.x + direction[0] * step, ARCHITECTURE_CANVAS.width - (kind === "node" ? 180 : 220)), y: clamp(item.y + direction[1] * step, ARCHITECTURE_CANVAS.height - (kind === "node" ? 84 : 56)) } });
    }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); mutate({ type: kind === "node" ? "remove-node" : "remove-annotation", id: item.id }); setSelection(undefined); }
  }
  function canvasKey(event: KeyboardEvent<SVGSVGElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); }
    if (event.key === "Escape") { setConnectFrom(undefined); connection.current = null; setConnectionPoint(undefined); if (drag.current) { const moving = drag.current; drag.current = null; release(moving.pointerId); if (moving.moved) restoreGraph(moving.before); } }
  }
  function startOperation(label: string) {
    if (operation.current || !checkCurrent()) return undefined;
    const controller = new AbortController(); operation.current = controller; setWorking(label); setError(""); setNotice(""); return controller;
  }
  function endOperation(controller: AbortController) {
    if (operation.current === controller) operation.current = null;
    if (alive.current) setWorking("");
  }
  function validDocument() { const errors = validateArchitectureDocument(documentRef.current); if (errors.length) { setError(errors.join("；")); return false; } return true; }

  async function saveDocument() {
    if (!props.storage || saveBlocked || !validDocument()) return;
    const controller = startOperation("正在核对保存回执"); if (!controller) return;
    const snapshot = cloneArchitectureDocument(documentRef.current), fingerprint = architectureDocumentFingerprint(snapshot);
    const result = await runArchitectureOperation({ binding: props.binding, fingerprint, getCurrentBinding: props.getCurrentBinding,
      getCurrentFingerprint: () => architectureDocumentFingerprint(documentRef.current), signal: controller.signal, timeoutMs: props.operationTimeoutMs,
      invoke: signal => props.storage!.save({ binding: { ...props.binding }, document: cloneArchitectureDocument(snapshot), expectedVersion: storageVersion, fingerprint }, signal),
      validate: receipt => validateArchitectureSaveReceipt(receipt, snapshot) });
    endOperation(controller); if (!alive.current) return;
    if (result.status === "ok" && result.value.status === "saved") { setStorageVersion(result.value.storageVersion); setSavedFingerprint(fingerprint); setSaveBlocked(false); setNotice("已收到当前图与问答的版本保存回执。"); props.onSaved?.(cloneArchitectureDocument(snapshot), result.value); }
    else { setSaveBlocked(true); setError(result.status === "ok" && result.value.status === "conflict" ? `版本冲突：${result.value.detail}。请先加载对账。` : `${result.status !== "ok" ? result.detail : "未取得当前版本回执。"} 保存结果可能未知，请先加载对账，不会自动重试。`); }
  }
  async function loadDocument() {
    if (!props.storage) return;
    const controller = startOperation("正在读取已保存版本"); if (!controller) return;
    const fingerprint = architectureDocumentFingerprint(documentRef.current);
    const result = await runArchitectureOperation({ binding: props.binding, fingerprint, getCurrentBinding: props.getCurrentBinding,
      getCurrentFingerprint: () => architectureDocumentFingerprint(documentRef.current), signal: controller.signal, timeoutMs: props.operationTimeoutMs,
      invoke: signal => props.storage!.load({ ...props.binding }, signal), validate: record => validateArchitectureStoredRecord(record, props.binding) });
    endOperation(controller); if (!alive.current) return;
    if (result.status !== "ok") { setError(result.detail); return; }
    if (!result.value) { setLoaded(null); setStorageVersion(null); setSaveBlocked(false); setNotice("没有读取到已保存版本。本地草稿未改动，结果不表示历史记录不存在。"); return; }
    setLoaded({ ...result.value, document: cloneArchitectureDocument(result.value.document) }); setReplaceConfirmed(false); setNotice("已读取存储版本。确认替换前，本地草稿保持不动。");
  }
  function adoptLoaded() {
    if (!loaded || !replaceConfirmed || !checkCurrent()) return;
    const invalid = validateArchitectureStoredRecord(loaded, props.binding); if (invalid) { setError(invalid); return; }
    const snapshot = cloneArchitectureDocument(loaded.document); update(snapshot, true); setStorageVersion(loaded.storageVersion); setSavedFingerprint(loaded.restoredGraphOnly ? "" : architectureDocumentFingerprint(snapshot));
    props.onEvidenceInventoryChanged?.(snapshot.evidence);
    setSaveBlocked(false); setLoaded(null); setPendingEvidence(undefined); setSelection(undefined); history.current = { past: [], future: [] }; setHistoryVersion(value => value + 1);
    setNotice(loaded.restoredGraphOnly ? "已将历史图恢复为当前授权下的未保存草稿；旧故障、问答与未重新授权的源码引用未继承，历史版本未覆盖。" : "已采用明确选择的存储版本；其他持久历史仍由存储Adapter保留。");
  }
  async function readAuthorizedEvidence() {
    if (!props.importEvidence) return;
    const controller = startOperation("正在重读已授权的精确源码行段"); if (!controller) return;
    const fingerprint = architectureDocumentFingerprint(documentRef.current);
    const result = await runArchitectureOperation({ binding: props.binding, fingerprint, getCurrentBinding: props.getCurrentBinding,
      getCurrentFingerprint: () => architectureDocumentFingerprint(documentRef.current), signal: controller.signal, timeoutMs: props.operationTimeoutMs,
      invoke: signal => props.importEvidence!({ ...props.binding }, signal), validate: value => {
        try {
          if (!value.receiptId || !Array.isArray(value.limitations) || value.limitations.length > 20) return "源码引用回执无效。";
          return validateArchitectureDocument(createArchitectureDocument(props.binding, value.evidence)).join("；") || undefined;
        } catch { return "源码引用回执无效。"; }
      } });
    endOperation(controller); if (!alive.current) return;
    if (result.status !== "ok") { setError(result.detail); return; }
    setPendingEvidence({ receiptId: result.value.receiptId, evidence: result.value.evidence.map(item => ({ ...item })), limitations: [...result.value.limitations], fingerprint });
    setEvidenceConfirmed(false); setNotice("已重读已授权行段。请预览并确认更新；尚未改变本地草稿、授权引用或原始事实。");
  }
  function adoptEvidenceInventory() {
    if (!pendingEvidence || !evidenceConfirmed || !checkCurrent()) return;
    if (architectureDocumentFingerprint(documentRef.current) !== pendingEvidence.fingerprint) { setPendingEvidence(undefined); setError("读取后图已变化，请重新读取并审阅引用；晚结果未采用。"); return; }
    try {
      const next = rebindArchitectureGraphDraft(documentRef.current, props.binding, pendingEvidence.evidence);
      update(next, true); props.onEvidenceInventoryChanged?.(next.evidence);
      history.current = { past: [], future: [] }; setHistoryVersion(value => value + 1); setLoaded(null); setPendingEvidence(undefined);
      setNotice("已明确更新当前图的引用库存。旧故障和问答不冒充新引用的结果；节点、连线与标注保留。尚未保存，也未写入Fact Base。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "引用库存未采用。"); }
  }
  function runFault() {
    if (!checkCurrent() || !validDocument()) return;
    if (document.faults.length >= ARCHITECTURE_LIMITS.faults) { setError("本会话故障记录已达上限，请先保存或导出；不会覆盖历史。"); return; }
    try {
      const fault = simulateArchitectureFault(documentRef.current, { kind: faultKind, targetNodeId: selectedTarget }, { id: localId("fault") });
      update({ ...documentRef.current, revision: documentRef.current.revision + 1, faults: [...documentRef.current.faults, fault] });
      setAskConsent(false); setReviewConsent(false); setAnswer(""); setError(""); setNotice("已生成图上故障推演；没有触碰真实磁盘、网络、账号或运行服务。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "故障推演不可用。"); }
  }
  function currentInterviewKey() {
    const key = architectureGraphFingerprint(documentRef.current);
    const fault = [...documentRef.current.faults].reverse().find(item => item.graphFingerprint === key);
    return `${key}\u0000${fault?.id ?? "no-fault"}`;
  }
  function interviewContext(): ArchitectureInterviewContext {
    const snapshot = cloneArchitectureDocument(documentRef.current), key = architectureGraphFingerprint(snapshot);
    const fault = [...snapshot.faults].reverse().find(item => item.graphFingerprint === key);
    // 只派送当前图、授权资料与本次故障，不把以往问答批量发给模型。
    snapshot.turns = []; snapshot.faults = [];
    return { requestId: localId("interview-request"), binding: { ...props.binding }, graphFingerprint: key, document: snapshot, fault };
  }
  async function askQuestion() {
    if (!props.interviewer || !askConsent || !validDocument() || !document.nodes.length) return;
    if (document.turns.length >= ARCHITECTURE_LIMITS.turns) { setError("问答记录已达上限；请保存或导出，不会覆盖旧回合。"); return; }
    const controller = startOperation("正在基于授权资料提问"); if (!controller) return;
    const context = interviewContext(), fingerprint = currentInterviewKey(); setAskConsent(false);
    const result = await runArchitectureOperation({ binding: props.binding, fingerprint, getCurrentBinding: props.getCurrentBinding, getCurrentFingerprint: currentInterviewKey,
      signal: controller.signal, timeoutMs: props.operationTimeoutMs, invoke: signal => props.interviewer!.ask(context, signal),
      validate: envelope => validateArchitectureInterviewEnvelope(envelope, context.document, context.requestId) });
    endOperation(controller); if (!alive.current) return;
    if (result.status !== "ok") { setError(result.detail); return; }
    const turn = { id: localId("turn"), graphRevision: context.document.graphRevision, graphFingerprint: context.graphFingerprint,
      faultRunId: context.fault?.id, question: result.value.value, createdAt: new Date().toISOString() };
    update({ ...documentRef.current, revision: documentRef.current.revision + 1, turns: [...documentRef.current.turns, turn] }); setAnswer(""); setReviewConsent(false);
  }
  async function reviewAnswer() {
    if (!props.interviewer || !reviewConsent || !answer.trim() || !currentTurn || !validDocument()) return;
    if (document.turns.length >= ARCHITECTURE_LIMITS.turns) { setError("问答记录已达上限；不会覆盖原答案与复盘。"); return; }
    const controller = startOperation("正在核对回答与证据"); if (!controller) return;
    const context = interviewContext(), selectedTurn = currentTurn, submitted = answer;
    const reviewKey = () => {
      const key = architectureGraphFingerprint(documentRef.current);
      const fault = [...documentRef.current.faults].reverse().find(item => item.graphFingerprint === key);
      const turn = [...documentRef.current.turns].reverse().find(item => item.graphFingerprint === key && item.faultRunId === fault?.id);
      return `${currentInterviewKey()}\u0000${turn?.id ?? ""}\u0000${answerRef.current}`;
    };
    const fingerprint = reviewKey(); setReviewConsent(false);
    const result = await runArchitectureOperation({ binding: props.binding, fingerprint, getCurrentBinding: props.getCurrentBinding, getCurrentFingerprint: reviewKey,
      signal: controller.signal, timeoutMs: props.operationTimeoutMs, invoke: signal => props.interviewer!.review({ ...context, question: selectedTurn.question, answer: submitted }, signal),
      validate: envelope => validateArchitectureInterviewEnvelope(envelope, context.document, context.requestId) });
    endOperation(controller); if (!alive.current) return;
    if (result.status !== "ok") { setError(result.detail); return; }
    update({ ...documentRef.current, revision: documentRef.current.revision + 1, turns: [...documentRef.current.turns,
      { ...selectedTurn, id: localId("turn-review"), answer: submitted, review: result.value.value, createdAt: new Date().toISOString() }] }); setNotice("已保留本次回答与复盘；旧回合未覆盖，支持程度仍需人工核对。");
  }
  function prepareExport() {
    if (!checkCurrent()) return;
    try { setExportArtifact(exportArchitectureArtifact(documentRef.current)); setExportConfirmed(false); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "当前图无法导出。"); }
  }
  function downloadExport() {
    if (!exportArtifact || !exportConfirmed || !checkCurrent()) return;
    const latest = exportArchitectureArtifact(documentRef.current);
    if (latest.text !== exportArtifact.text) { setError("图或问答已变化，请重新预览导出。"); setExportArtifact(undefined); return; }
    if (props.onExport) props.onExport(exportArtifact);
    else {
      const url = URL.createObjectURL(new Blob([exportArtifact.text], { type: exportArtifact.mime }));
      const link = globalThis.document.createElement("a"); link.href = url; link.download = exportArtifact.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    setNotice("已交付当前明确确认的导出快照。分享前仍请检查注释与回答中的私人信息。"); setExportArtifact(undefined);
  }
  function evidenceLinks(ids: readonly string[]) {
    return <ul className="cal-evidence-list">{ids.map(id => { const evidence = document.evidence.find(item => item.id === id);
      return <li key={id}><details><summary>{evidence?.label ?? `未知引用 ${id}`}</summary>{evidence?.path && <code>{evidence.path}{evidence.startLine ? `:${evidence.startLine}${evidence.endLine ? `–${evidence.endLine}` : ""}` : ""}</code>}<pre>{evidence?.excerpt ?? "未取得授权原文。"}</pre></details></li>;
    })}</ul>;
  }
  function toggleEvidence(ids: string[], id: string, checked: boolean) { return checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id); }
  function edgePath(edge: ArchitectureEdge) {
    const from = document.nodes.find(node => node.id === edge.from), to = document.nodes.find(node => node.id === edge.to); if (!from || !to) return "";
    const startX = from.x + 180, startY = from.y + 42, endX = to.x, endY = to.y + 42, distance = Math.max(50, Math.abs(endX - startX) / 2);
    return `M ${startX} ${startY} C ${startX + distance} ${startY}, ${endX - distance} ${endY}, ${endX} ${endY}`;
  }

  if (!currentBinding) return <section className="architecture-lab" aria-label="架构白板与故障面试舱"><p role="alert">当前账号、会话或授权项目版本不可用。旧图未展示，也不会继续模型调用或保存。</p></section>;
  return <section className="architecture-lab" aria-labelledby={titleId}>
    <header className="cal-header"><div><p className="cal-eyebrow">项目理解 · 离线架构推演</p><h2 id={titleId}>架构白板与故障面试舱</h2><p>先画出真实理解，再用边界条件检验。图中的防护是你的假设，不是源码认证。</p></div><span className="cal-save-state">{savedFingerprint === architectureDocumentFingerprint(document) ? "已核对保存版本" : "本地草稿 · 未保存"}</span></header>
    <div className="cal-toolbar" aria-label="白板工具">
      {(Object.keys(NODE_KIND_LABELS) as ArchitectureNodeKind[]).map(kind => <button key={kind} type="button" data-action={`add-${kind}`} onClick={() => addNode(kind)} disabled={document.nodes.length >= ARCHITECTURE_LIMITS.nodes}><Plus size={14} aria-hidden="true" />{NODE_KIND_LABELS[kind]}</button>)}
      <button type="button" onClick={addAnnotation} disabled={document.annotations.length >= ARCHITECTURE_LIMITS.annotations}><StickyNote size={15} aria-hidden="true" />标注</button>
      <span className="cal-divider" /><button type="button" onClick={() => undo()} disabled={!history.current.past.length} title="撤销图编辑"><Undo2 size={15} aria-hidden="true" />撤销</button><button type="button" onClick={() => undo(true)} disabled={!history.current.future.length} title="重做图编辑"><Redo2 size={15} aria-hidden="true" />重做</button>
      <button type="button" onClick={saveDocument} disabled={busy || !props.storage || saveBlocked}><Save size={15} aria-hidden="true" />保存会话</button><button type="button" onClick={loadDocument} disabled={busy || !props.storage}>加载对账</button><button type="button" onClick={readAuthorizedEvidence} disabled={busy || !props.importEvidence}>读取已授权源码</button><button type="button" onClick={prepareExport}><Download size={15} aria-hidden="true" />预览导出</button>
    </div>
    {!props.storage && <p className="cal-notice">尚未接入当前账号的版本存储。编辑只在本次打开期间保留；可明确导出，未伪称已保存。</p>}
    <div className="cal-messages" aria-live="polite">{working && <p role="status">{working}… <button type="button" onClick={() => operation.current?.abort()}>取消本次操作</button></p>}{error && <p role="alert" className="cal-error">{error}</p>}{notice && <p role="status">{notice}</p>}</div>
    {!props.importEvidence && <p className="cal-notice">源码不会自动扫描或导入。须先在当前授权内完成含精确代码行段的抗压测试，再明确读取与确认；没有时只使用本人选中的自述。</p>}
    {pendingEvidence && <div className="cal-loaded"><strong>待确认引用库存 · {pendingEvidence.evidence.length} 条</strong><p>只包含当前已授权行段。更新后保留图，但清除不属于新库存版本的故障与问答；未逐字段匹配的旧代码引用不会继承。</p><ul>{pendingEvidence.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><ul className="cal-evidence-list">{pendingEvidence.evidence.map(item => <li key={item.id}><details><summary>{item.label}</summary>{item.path && <code>{item.path}:{item.startLine}–{item.endLine}</code>}<pre>{item.excerpt}</pre></details></li>)}</ul><label><input type="checkbox" checked={evidenceConfirmed} onChange={event => setEvidenceConfirmed(event.target.checked)} />我已审阅，明确将这些引用用于当前架构图，不将源码存在视为本人贡献证明</label><button type="button" disabled={!evidenceConfirmed || busy} onClick={adoptEvidenceInventory}>确认更新引用库存</button><button type="button" onClick={() => setPendingEvidence(undefined)}>保留当前引用</button></div>}
    {loaded && <div className="cal-loaded"><strong>已读取：{loaded.document.title} · 图版本 {loaded.document.graphRevision}</strong><p>有 {loaded.document.nodes.length} 个节点、{loaded.document.turns.length} 条问答。替换前请保存或导出当前未保存草稿。</p>{loaded.restoredGraphOnly && <p>这是历史图在当前授权下的未保存草稿：旧故障和问答已清除；没有当前精确授权的源码引用不继承。原历史记录保留。</p>}<label><input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} />我明确选择用此存储版本替换当前本地草稿</label><button type="button" disabled={!replaceConfirmed || busy} onClick={adoptLoaded}>采用已加载版本</button><button type="button" onClick={() => setLoaded(null)}>保留本地草稿</button></div>}
    <div className="cal-workspace">
      <div className="cal-board">
        <div className="cal-canvas-controls"><label>图的标题<input value={document.title} maxLength={120} onChange={event => mutate({ type: "rename", title: event.target.value })} /></label><label>缩放<select value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[25, 40, 60, 80, 100, 125, 150].includes(zoom) ? null : <option value={zoom}>{zoom}%</option>}{[25, 40, 60, 80, 100, 125, 150].map(value => <option value={value} key={value}>{value}%</option>)}</select></label><button type="button" onClick={() => setZoom(Math.max(20, Math.min(100, Math.floor((viewport.current?.clientWidth ?? 1200) / 1200 * 100))))}>适应宽度</button></div>
        <p id={helpId} className="cal-help">拖动节点移动；从右侧端点拖到另一节点左侧端点连线，也可依次点击端点。Tab选择节点后，方向键移动、Shift加速、Delete删除；⌘/Ctrl+Z撤销，Esc取消。下方节点列表和详情提供等效键盘操作。</p>
        {connectFrom && <p className="cal-connecting"><Link2 size={14} aria-hidden="true" />正在连接“{document.nodes.find(node => node.id === connectFrom)?.label || "节点"}” → 请选择目标左端点<button type="button" onClick={() => { setConnectFrom(undefined); connection.current = null; setConnectionPoint(undefined); }}>取消连线</button></p>}
        <div ref={viewport} className="cal-canvas-viewport" tabIndex={0} aria-label="可滚动架构画布">
          <svg ref={canvas} data-architecture-canvas="true" width={1200 * zoom / 100} height={760 * zoom / 100} viewBox="0 0 1200 760" role="group" aria-label="可编辑架构图" aria-describedby={helpId}
            onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)} onKeyDown={canvasKey}>
            <defs><pattern id={`${markerId}-grid`} width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="cal-grid-dot" /></pattern><marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="cal-arrow" /></marker></defs>
            <rect width="1200" height="760" fill={`url(#${markerId}-grid)`} />
            {!document.nodes.length && <text x="60" y="90" className="cal-empty-canvas">从工具栏添加一个真实项目节点。没有预置架构或虚构事实。</text>}
            {document.edges.map(edge => <g key={edge.id} data-edge-id={edge.id} tabIndex={0} role="button" aria-label={`连线 ${document.nodes.find(node => node.id === edge.from)?.label || "起点"} 到 ${document.nodes.find(node => node.id === edge.to)?.label || "终点"}，${edge.label || "未填写说明"}`} className={`cal-edge ${selection?.id === edge.id ? "is-selected" : ""}`} onClick={() => setSelection({ kind: "edge", id: edge.id })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelection({ kind: "edge", id: edge.id }); } if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); mutate({ type: "remove-edge", id: edge.id }); } }}><path d={edgePath(edge)} className="cal-edge-hit" /><path d={edgePath(edge)} id={`${markerId}-edge-${edge.id}`} className="cal-edge-line" markerEnd={`url(#${markerId}-arrow)`} />{edge.label && <text className="cal-edge-label" dy="-6"><textPath href={`#${markerId}-edge-${edge.id}`} startOffset="50%" textAnchor="middle">{short(edge.label, 22)}</textPath></text>}<title>{edge.label || "策略待补充"}</title></g>)}
            {connectionPoint && connectFrom && (() => { const from = document.nodes.find(node => node.id === connectFrom); return from ? <path d={`M ${from.x + 180} ${from.y + 42} L ${connectionPoint.x} ${connectionPoint.y}`} className="cal-connection-draft" /> : null; })()}
            {document.nodes.map(node => { const outcome = currentFault?.outcomes.find(item => item.nodeId === node.id); return <g key={node.id} data-node-id={node.id} transform={`translate(${node.x} ${node.y})`} className={`cal-node ${selection?.id === node.id ? "is-selected" : ""} ${outcome ? `is-${outcome.state}` : ""}`} tabIndex={0} role="button" aria-label={`节点 ${node.label || "未命名"}，${NODE_KIND_LABELS[node.kind]}，方向键移动，Delete删除`} onPointerDown={event => beginDrag(event, node, "node")} onClick={() => setSelection({ kind: "node", id: node.id })} onKeyDown={event => itemKey(event, node, "node")}>
              <rect width="180" height="84" rx="9" /><text x="14" y="22" className="cal-node-kind">{NODE_KIND_LABELS[node.kind]} · {outcome ? stateLabels[outcome.state] : "未推演"}</text><text x="14" y="45" className="cal-node-title">{short(node.label || "未命名节点", 12)}</text><text x="14" y="65" className="cal-node-meta">{node.evidenceIds.length ? `${node.evidenceIds.length} 条授权引用` : "尚未绑定引用"}</text>
              <circle cx="0" cy="42" r="13" data-port="input" data-port-node={node.id} className="cal-port" role="button" tabIndex={0} aria-label={`连接到 ${node.label || "未命名节点"}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); completeConnection(node.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); event.preventDefault(); completeConnection(node.id); } }} />
              <circle cx="180" cy="42" r="13" data-port="output" data-port-node={node.id} className="cal-port" role="button" tabIndex={0} aria-label={`从 ${node.label || "未命名节点"} 开始连线`} onPointerDown={event => beginConnection(event, node)} onClick={event => { event.stopPropagation(); if (suppressPortClick.current === node.id) { suppressPortClick.current = undefined; return; } setConnectFrom(node.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); event.preventDefault(); setConnectFrom(node.id); setNotice("起点已选择，请用Tab到目标左端点并按Enter。"); } }} />
              <title>{node.label}{node.notes ? `：${node.notes}` : ""}</title>
            </g>; })}
            {document.annotations.map(note => <g key={note.id} data-annotation-id={note.id} transform={`translate(${note.x} ${note.y})`} className={`cal-annotation ${selection?.id === note.id ? "is-selected" : ""}`} tabIndex={0} role="button" aria-label={`标注 ${short(note.text, 30)}，方向键移动`} onPointerDown={event => beginDrag(event, note, "annotation")} onClick={() => setSelection({ kind: "annotation", id: note.id })} onKeyDown={event => itemKey(event, note, "annotation")}><rect width="220" height="56" rx="6" /><text x="12" y="24">{short(note.text, 16)}</text><text x="12" y="42" className="cal-node-meta">用户标注 · 非已验证事实</text></g>)}
          </svg>
        </div>
        <details className="cal-node-list" open><summary>节点与连线列表（完整键盘替代） · {document.nodes.length} / {document.edges.length}</summary><ul>{document.nodes.map(node => <li key={node.id}><button type="button" onClick={() => setSelection({ kind: "node", id: node.id })}><Square size={14} aria-hidden="true" />{node.label || "未命名节点"} · {NODE_KIND_LABELS[node.kind]}</button><button type="button" onClick={() => { setConnectFrom(node.id); setNotice("已选连接起点，选择目标节点的“连入此处”。"); }}>设为连线起点</button><button type="button" disabled={!connectFrom || connectFrom === node.id} onClick={() => completeConnection(node.id)}>连入此处</button></li>)}</ul>{!document.nodes.length && <p>图为空，先添加节点。</p>}<ul>{document.edges.map(edge => <li key={edge.id}><button type="button" onClick={() => setSelection({ kind: "edge", id: edge.id })}>连线：{document.nodes.find(node => node.id === edge.from)?.label} → {document.nodes.find(node => node.id === edge.to)?.label} · {edge.label || "策略待补充"}</button></li>)}</ul></details>
      </div>
      <aside className="cal-details" aria-label="选中对象详情"><h3>对象详情</h3>
        {!selection && <p>选择节点、连线或标注，编辑真实职责、传播策略与证据定位。</p>}
        {selectedNode && <><label>节点名称<input value={selectedNode.label} maxLength={80} onChange={event => mutate({ type: "update-node", id: selectedNode.id, patch: { label: event.target.value } })} /></label><label>节点类型<select value={selectedNode.kind} onChange={event => mutate({ type: "update-node", id: selectedNode.id, patch: { kind: event.target.value as ArchitectureNodeKind } })}>{(Object.keys(NODE_KIND_LABELS) as ArchitectureNodeKind[]).map(kind => <option key={kind} value={kind}>{NODE_KIND_LABELS[kind]}</option>)}</select></label><label>节点说明<textarea value={selectedNode.notes} maxLength={4000} rows={3} onChange={event => mutate({ type: "update-node", id: selectedNode.id, patch: { notes: event.target.value } })} /></label><div className="cal-coordinate-fields">{(["x", "y"] as const).map(axis => <label key={axis}>{axis === "x" ? "横坐标" : "纵坐标"}<input type="number" value={selectedNode[axis]} min={0} max={axis === "x" ? 1020 : 676} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) mutate({ type: "update-node", id: selectedNode.id, patch: { [axis]: clamp(value, axis === "x" ? 1020 : 676) } }); }} /></label>)}</div><fieldset><legend>防护声明（需要证据核对）</legend>{([["diskFull", "正确处理磁盘写满"], ["sessionEpoch", "写入前校验账号会话代次"], ["idempotency", "重复事件幂等防护"]] as const).map(([key, label]) => <label key={key}>{label}<select value={selectedNode.guards[key]} onChange={event => mutate({ type: "update-node", id: selectedNode.id, patch: { guards: { ...selectedNode.guards, [key]: event.target.value as ArchitectureGuard } } })}><option value="unknown">未知 / 待核对</option><option value="yes">声明有防护</option><option value="no">声明无防护</option></select></label>)}</fieldset><fieldset><legend>本次授权引用</legend>{document.evidence.length ? document.evidence.map(item => <label className="cal-checkbox" key={item.id}><input type="checkbox" checked={selectedNode.evidenceIds.includes(item.id)} onChange={event => mutate({ type: "update-node", id: selectedNode.id, patch: { evidenceIds: toggleEvidence(selectedNode.evidenceIds, item.id, event.target.checked) } })} />{item.label}</label>) : <p>没有授权引用。图与防护仍是自述假设。</p>}</fieldset>{evidenceLinks(selectedNode.evidenceIds)}</>}
        {selectedEdge && <><p>端点：{document.nodes.find(node => node.id === selectedEdge.from)?.label} → {document.nodes.find(node => node.id === selectedEdge.to)?.label}</p><label>连线说明<input value={selectedEdge.label} maxLength={160} onChange={event => mutate({ type: "update-edge", id: selectedEdge.id, patch: { label: event.target.value } })} /></label><label>交互类型<select value={selectedEdge.kind} onChange={event => mutate({ type: "update-edge", id: selectedEdge.id, patch: { kind: event.target.value as ArchitectureEdge["kind"] } })}><option value="request">请求</option><option value="read">读取</option><option value="write">写入</option><option value="event">事件</option></select></label><label>依赖失败时<select value={selectedEdge.failurePolicy} onChange={event => mutate({ type: "update-edge", id: selectedEdge.id, patch: { failurePolicy: event.target.value as ArchitectureEdge["failurePolicy"] } })}><option value="unknown">未知 / 待核对</option><option value="propagate">失败向调用方传播</option><option value="isolate">隔离并阻断传播</option></select></label><label>账号会话交接<select value={selectedEdge.sessionPolicy} onChange={event => mutate({ type: "update-edge", id: selectedEdge.id, patch: { sessionPolicy: event.target.value as ArchitectureEdge["sessionPolicy"] } })}><option value="unknown">未知 / 待核对</option><option value="validate">此链路校验会话代次</option><option value="forward">不校验，继续传递</option></select></label><fieldset><legend>连线引用</legend>{document.evidence.map(item => <label className="cal-checkbox" key={item.id}><input type="checkbox" checked={selectedEdge.evidenceIds.includes(item.id)} onChange={event => mutate({ type: "update-edge", id: selectedEdge.id, patch: { evidenceIds: toggleEvidence(selectedEdge.evidenceIds, item.id, event.target.checked) } })} />{item.label}</label>)}</fieldset>{evidenceLinks(selectedEdge.evidenceIds)}</>}
        {selectedAnnotation && <><label>标注内容<textarea rows={5} maxLength={2000} value={selectedAnnotation.text} onChange={event => mutate({ type: "update-annotation", id: selectedAnnotation.id, patch: { text: event.target.value } })} /></label><p>标注只记录你的推演，不会自动转为Fact。</p></>}
        {selection && <button type="button" className="cal-danger-button" onClick={removeSelected}>删除所选{selection.kind === "node" ? "节点与关联连线" : selection.kind === "edge" ? "连线" : "标注"}</button>}
      </aside>
    </div>
    <div className="cal-interview-grid">
      <section className="cal-fault-panel" aria-label="图上故障注入"><h3>图上故障注入</h3><p>仅模拟，不操作真实环境。未声明的防护与边界条件维持未知。</p><div className="cal-fault-fields"><label>故障类型<select value={faultKind} onChange={event => setFaultKind(event.target.value as ArchitectureFaultKind)}>{(Object.keys(FAULT_KIND_LABELS) as ArchitectureFaultKind[]).map(kind => <option value={kind} key={kind}>{FAULT_KIND_LABELS[kind]}</option>)}</select></label><label>注入节点<select value={selectedTarget} onChange={event => setTargetId(event.target.value)}>{!faultTargets.length && <option value="">{faultKind === "disk-full" ? "先添加存储节点" : "先添加节点"}</option>}{faultTargets.map(node => <option value={node.id} key={node.id}>{node.label || "未命名"}</option>)}</select></label><button type="button" disabled={busy || !selectedTarget} onClick={runFault}>运行离线推演</button></div>
        {currentFault ? <><p className="cal-fault-caption">推演：{FAULT_KIND_LABELS[currentFault.fault.kind]} · 图版本 {currentFault.graphRevision} · {currentFault.steps} 条传播检查{currentFault.truncated ? " · 预算用尽，部分未知" : ""}</p><ol className="cal-outcomes">{currentFault.outcomes.map(outcome => <li key={outcome.nodeId} className={`is-${outcome.state}`}><strong>{document.nodes.find(node => node.id === outcome.nodeId)?.label} · {stateLabels[outcome.state]}</strong><p>{outcome.detail}</p>{evidenceLinks(outcome.evidenceIds)}</li>)}</ol><details><summary>模型假设与范围</summary><ul>{currentFault.assumptions.map(item => <li key={item}>{item}</li>)}</ul></details></> : <p className="cal-empty">尚无当前图版本的推演。编辑图后，旧推演不会被当作当前结果。</p>}
      </section>
      <section className="cal-interview-panel" aria-label="证据面试与复盘"><h3>证据面试与复盘</h3>{props.interviewer ? <p>固定面试官：{props.interviewer.label} · {props.interviewer.location === "local" ? "本地推理" : props.interviewer.location === "cloud" ? "云端推理" : "位置未证实，可能发送云端"}。不会失败后换模型。</p> : <p className="cal-notice">未接入授权模型，提问与复盘不可用。画图和离线故障推演仍可用，不会伪造Agent回答。</p>}
        <label className="cal-checkbox"><input type="checkbox" checked={askConsent} disabled={busy || !props.interviewer} onChange={event => setAskConsent(event.target.checked)} />允许将当前图、所选授权资料摘要与本次故障发送给上述面试官，仅用于本次提问</label><button type="button" disabled={busy || !props.interviewer || !askConsent || !document.nodes.length} onClick={askQuestion}>基于当前图提问</button>
        {currentTurn ? <><blockquote>{currentTurn.question.text}</blockquote>{evidenceLinks(currentTurn.question.evidenceIds)}{currentTurn.question.unknowns.length > 0 && <div className="cal-unknown"><strong>仍未知</strong><ul>{currentTurn.question.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}<label>你的架构答复<textarea value={answer} rows={5} maxLength={12000} onChange={event => { const value = event.target.value; setAnswer(value); answerRef.current = value; setReviewConsent(false); update({ ...documentRef.current, revision: documentRef.current.revision + 1, turns: documentRef.current.turns.map(turn => turn.id === currentTurn.id ? { ...turn, draftAnswer: value } : turn) }); }} placeholder="说明故障传播、原子性、会话边界与证据；不确定的部分可以直接说明。" /></label><label className="cal-checkbox"><input type="checkbox" checked={reviewConsent} disabled={busy || !props.interviewer} onChange={event => setReviewConsent(event.target.checked)} />允许将当前答复、问题与相同授权资料发送给上述面试官，仅用于本次复盘</label><button type="button" disabled={busy || !props.interviewer || !reviewConsent || !answer.trim()} onClick={reviewAnswer}>提交答复并复盘</button>{currentTurn.review && <div className="cal-review"><strong>{supportLabels[currentTurn.review.support]}</strong><p>{currentTurn.review.summary}</p>{([ ["已站住的论点", currentTurn.review.strengths], ["还需补足", currentTurn.review.gaps], ["继续追问", currentTurn.review.followUps] ] as const).map(([label, items]) => items.length ? <div key={label}><h4>{label}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null)}{evidenceLinks(currentTurn.review.evidenceIds)}</div>}</> : <p className="cal-empty">当前图与故障还没有问题。资料不足时，面试官必须明确未知，不能把画出的图当作本人实现证明。</p>}
      </section>
    </div>
    <details className="cal-history"><summary>保留的模拟历史 · {document.faults.length} 次故障 / {document.turns.length} 条问答</summary><ol>{[...document.turns].reverse().map(turn => <li key={turn.id}><strong>图版本 {turn.graphRevision} · {turn.graphFingerprint === graphKey ? "当前图" : "历史图，不能作为当前结果"}</strong><p>{turn.question.text}</p>{turn.answer && <blockquote>{turn.answer}</blockquote>}{turn.review && <p>{supportLabels[turn.review.support]}：{turn.review.summary}</p>}</li>)}</ol>{!document.turns.length && <p>尚无问答记录。</p>}</details>
    {exportArtifact && <section className="cal-export" aria-label="导出预览"><h3>导出预览</h3><p>排除owner、会话、授权资料原文与本机引用路径；图名称、注释和回答仍可能包含你输入的私人信息。导出不是授权恢复凭据，也不是工程能力认证。</p><textarea aria-label="将导出的JSON" readOnly rows={8} value={exportArtifact.text} /><label className="cal-checkbox"><input type="checkbox" checked={exportConfirmed} onChange={event => setExportConfirmed(event.target.checked)} />我已检查这份快照，确认其中没有不应导出的内容</label><button type="button" onClick={downloadExport} disabled={!exportConfirmed}>确认下载JSON</button><button type="button" onClick={() => setExportArtifact(undefined)}>取消导出</button></section>}
  </section>;
}

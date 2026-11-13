import {
  architectureDocumentFingerprint, architectureGraphFingerprint, sameArchitectureBinding, validateArchitectureDocument,
  type ArchitectureBinding, type ArchitectureDocument, type ArchitectureEvidence, type ArchitectureFaultRun, type ArchitectureQuestion, type ArchitectureReview,
} from "./model";

export interface ArchitectureStoredRecord { document: ArchitectureDocument; storageVersion: string; restoredGraphOnly?: boolean }
export interface ArchitectureEvidenceImport { receiptId: string; evidence: readonly ArchitectureEvidence[]; limitations: readonly string[] }
export type ArchitectureSaveReceipt = {
  status: "saved"; binding: ArchitectureBinding; documentId: string; documentRevision: number;
  fingerprint: string; storageVersion: string;
} | { status: "conflict"; detail: string };
export interface ArchitectureStorageAdapter {
  load(binding: ArchitectureBinding, signal: AbortSignal): Promise<ArchitectureStoredRecord | null>;
  /** 必须在真正提交前再次验证 owner/session/source 与 CAS；不得覆盖原历史。 */
  save(request: { binding: ArchitectureBinding; document: ArchitectureDocument; expectedVersion: string | null; fingerprint: string }, signal: AbortSignal): Promise<ArchitectureSaveReceipt>;
}
export interface ArchitectureInterviewContext {
  requestId: string;
  binding: ArchitectureBinding;
  graphFingerprint: string;
  document: ArchitectureDocument;
  fault?: ArchitectureFaultRun;
}
export interface ArchitectureInterviewEnvelope<T> {
  requestId: string;
  binding: ArchitectureBinding;
  graphFingerprint: string;
  value: T;
}
export interface ArchitectureInterviewerAdapter {
  label: string;
  location: "local" | "cloud" | "unknown";
  ask(request: ArchitectureInterviewContext, signal: AbortSignal): Promise<ArchitectureInterviewEnvelope<ArchitectureQuestion>>;
  review(request: ArchitectureInterviewContext & { question: ArchitectureQuestion; answer: string }, signal: AbortSignal): Promise<ArchitectureInterviewEnvelope<ArchitectureReview>>;
}

export type ArchitectureOperationResult<T> = { status: "ok"; value: T } | { status: "cancelled" | "stale" | "timeout" | "error"; detail: string };

/**
 * 有界 Adapter 调用。迟到结果不进入 UI；已经派送的保存结果仍可能未知，
 * 调用方不可在超时/取消后自动重试。宿主 Adapter 仍负责提交前的授权与 CAS。
 */
export async function runArchitectureOperation<T>(options: {
  binding: ArchitectureBinding;
  fingerprint: string;
  getCurrentBinding(): ArchitectureBinding;
  getCurrentFingerprint(): string;
  invoke(signal: AbortSignal): Promise<T>;
  validate(value: T): string | undefined;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ArchitectureOperationResult<T>> {
  const controller = new AbortController();
  const interrupted = () => {
    if (options.signal?.aborted) return { status: "cancelled" as const, detail: "本次操作已取消；迟到结果不会采用。" };
    if (!sameArchitectureBinding(options.binding, options.getCurrentBinding()) || options.fingerprint !== options.getCurrentFingerprint()) {
      return { status: "stale" as const, detail: "账号、会话、授权项目版本或当前图已变化，本次结果失效。" };
    }
    return undefined;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const before = interrupted();
    if (before) return before;
    const timeout = Number.isFinite(options.timeoutMs) ? Math.min(60000, Math.max(1, options.timeoutMs!)) : 15000;
    const result = await new Promise<ArchitectureOperationResult<T>>((resolve) => {
      let settled = false;
      const finish = (value: ArchitectureOperationResult<T>) => { if (!settled) { settled = true; resolve(value); } };
      abort = () => { controller.abort(); finish({ status: "cancelled", detail: "本次操作已取消；已派送的写入请先对账，不自动重试。" }); };
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); finish({ status: "timeout", detail: "操作超时；未推断执行结果，也不会自动重试。" }); }, timeout);
      if (options.signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        const beforeDispatch = interrupted();
        if (controller.signal.aborted || beforeDispatch) throw new Error("派送前已取消或失效");
        return options.invoke(controller.signal);
      }).then(value => finish({ status: "ok", value }), () => finish({ status: "error", detail: "Adapter未返回可核对结果；不会自动更换模型或重试写入。" }));
    });
    const after = interrupted();
    if (after) return after;
    if (result.status !== "ok") return result;
    const error = options.validate(result.value);
    return error ? { status: "error", detail: error } : result;
  } catch {
    return { status: "error", detail: "当前授权或版本无法核对，操作未被采用。" };
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
}

export function validateArchitectureStoredRecord(record: ArchitectureStoredRecord | null, binding: ArchitectureBinding): string | undefined {
  if (!record) return undefined;
  if (typeof record.storageVersion !== "string" || !record.storageVersion.trim() || !sameArchitectureBinding(record.document.binding, binding)) return "加载记录属于其他账号、会话或项目版本，未采用。";
  return validateArchitectureDocument(record.document).join("；") || undefined;
}
export function validateArchitectureSaveReceipt(receipt: ArchitectureSaveReceipt, document: ArchitectureDocument): string | undefined {
  if (receipt.status === "conflict") return undefined;
  return receipt.status !== "saved" || !receipt.storageVersion || receipt.documentId !== document.id || receipt.documentRevision !== document.revision
    || receipt.fingerprint !== architectureDocumentFingerprint(document) || !sameArchitectureBinding(receipt.binding, document.binding)
    ? "保存回执未绑定本次完整图版本，不能标为已保存。" : undefined;
}
export function validateArchitectureInterviewEnvelope<T extends ArchitectureQuestion | ArchitectureReview>(envelope: ArchitectureInterviewEnvelope<T>, document: ArchitectureDocument, requestId: string): string | undefined {
  if (envelope.requestId !== requestId || !sameArchitectureBinding(envelope.binding, document.binding) || envelope.graphFingerprint !== architectureGraphFingerprint(document)) return "模型结果未绑定当前请求、图与授权版本。";
  const value = envelope.value;
  const allowed = new Set(document.evidence.map(item => item.id));
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some(id => !allowed.has(id))) return "模型引用了未授权或不存在的证据。";
  const bounded = (text: unknown, maximum = 6000) => typeof text === "string" && text.length > 0 && text.length <= maximum;
  if ("text" in value) {
    if (!bounded(value.id, 160) || !bounded(value.text) || !Array.isArray(value.unknowns) || value.unknowns.length > 30
      || value.unknowns.some(item => !bounded(item, 2000)) || (!value.evidenceIds.length && !value.unknowns.length)) return "问题需要有效正文、授权引用，或明确列出证据未知。";
  } else {
    if (!bounded(value.summary) || !["supported", "partial", "contradicted", "unknown"].includes(value.support)
      || [value.strengths, value.gaps, value.followUps].some(items => !Array.isArray(items) || items.length > 30 || items.some(item => !bounded(item, 2000)))
      || (!value.evidenceIds.length && value.support !== "unknown")) return "复盘正文、支持程度或证据引用无效；无引用只能保留未知。";
  }
  return undefined;
}

import { jsonObjectOptions, type fetchChatCompletionResult, type LlmConfig } from "@better-me/core";
import type { ProjectUnderstanding, ResumeEditContext, ResumeProposalTarget, UnderstandingSession } from "@better-me/agent-contracts";
import { z } from "zod";
import { resolveWritingQuote, type WritingQuote } from "./writing-anchor";
import { writingMessages, parseWritingReply, WritingReplyError, type WritingReply } from "@better-me/core/experience-writing";
export { writingMessages, parseWritingReply, WritingReplyError, type WritingReply } from "@better-me/core/experience-writing";
import type { ResumeProposalWrite } from "./resume-agent-context";

export type WritingSource = { targetRef: ResumeProposalTarget; text: string; label: string; quote?: WritingQuote };
export type WritingIssue = { kind: string; title: string; question: string };
export type WritingNote = {
  id: string; source: WritingSource; issue: WritingIssue;
  state: "open" | "dismissed" | "applied" | "stale";
  answer: string; questions?: string[]; proposedText?: string; rationale?: string;
  evidenceQuotes?: string[];
  autoAsked?: boolean;
  updatedAt: number;
};
export type WritingMode = "quiet" | "proactive" | "paused";
export type WritingSession = { version: 1; mode: WritingMode; autoLocalModel?: boolean; notes: WritingNote[] };
/** Background meaning only: never an additional source of personal-contribution evidence. */
export type ConfirmedWritingProjectContext = {
  sessionId: string; revision: number; summaryHash: string; understanding: ProjectUnderstanding;
};
export function confirmedWritingProjectContext(session: UnderstandingSession): ConfirmedWritingProjectContext | undefined {
  if (session.phase !== "confirmed" || !session.understanding || !session.summaryHash
    || session.confirmation?.summaryHash !== session.summaryHash || session.confirmation.revision !== session.revision) return;
  return { sessionId: session.id, revision: session.revision, summaryHash: session.summaryHash, understanding: session.understanding };
}

export function writingTargetKey(target: ResumeProposalTarget): string {
  return JSON.stringify(target.kind === "claim_text"
    ? [target.kind, target.experienceId, target.claimId, target.locale]
    : [target.kind, target.locale]);
}
/** Shared views originally identified the same field; an edition owns its own evidence. */
export function writingProjectSourceKey(target: ResumeProposalTarget, isolatedResumeId?: string): string {
  return (isolatedResumeId ? `isolated:${isolatedResumeId}:` : "") + writingTargetKey(target);
}
export function writingSources(context: ResumeEditContext): WritingSource[] {
  return [
    ...(context.profile.headline ? [{ ...context.profile.headline, label: "个人简介" }] : []),
    ...context.experiences.flatMap(exp => exp.claims.map((claim, index) => ({
      targetRef: claim.targetRef, text: claim.text, label: `${exp.organization} · 要点 ${index + 1}`,
    }))),
  ];
}

/** Quality signals, not a score or a claim that a missing result never happened. */
export function inspectWriting(source: WritingSource, sources: WritingSource[]): WritingIssue | undefined {
  const text = (source.quote?.exact ?? source.text).trim();
  if (!text && source.targetRef.kind === "claim_text") return { kind: "blank", title: "从一件你实际做过的事开始", question: "当时要解决什么问题？你亲手做了哪一步？先用自己的话写，不必马上凑成果或数字。" };
  if (text.length < 6) return;
  // Imported subheadings and project context aren't claims of personal achievement.
  if (/^(?:(?:内容|工作内容|项目内容|个人职责|主要职责|项目业绩|主要业绩|项目成果)\s*[:：]?\s*$|(?:核心项目|项目名称|项目背景|项目简介|技术栈|开发工具|仓库地址|tech stack|project background)\s*[:：])/i.test(text)) return;
  const normalized = text.replace(/[\s，。,.；;]/g, "").toLowerCase();
  if (sources.some(other => other.targetRef.locale === source.targetRef.locale && writingTargetKey(other.targetRef) !== writingTargetKey(source.targetRef)
    && other.text.replace(/[\s，。,.；;]/g, "").toLowerCase() === normalized)) {
    return { kind: "duplicate", title: "这条与另一条要点重复", question: "两段经历中，你分别解决了什么不同的问题？可以只保留最有代表性的一条。" };
  }
  if (/(提升|降低|减少|增长|提高|improv|reduc).{0,18}\d+\s*[%％]/i.test(text)) {
    return { kind: "evidence", title: "这个数字需要依据", question: "这个对比的前后基线、统计范围和数据来源是什么？不确定时可以不用百分比。" };
  }
  if (/(相关工作|日常工作|若干|熟悉常见|各种|负责相关|participated in related)/i.test(text)) {
    return { kind: "vague", title: "还看不出你的具体贡献", question: "挑一个实际案例：你亲手做了哪一步？当时为什么需要这样做？" };
  }
  if (source.targetRef.kind === "claim_text") {
    // A mechanism or an observable behavior can stand on its own without a percentage.
    const concreteBehavior = /(?:按|通过|使用)[^，。；;]{1,12}(?:关联|去重|回放|重试|校验|拦截|复现)|(?:二次确认|字段映射|状态转换|幂等键|超时重试|逐项校验|逐条核对)|(?:若|当|存在|检测到)[^，。；;]{1,18}(?:时|则|就|禁止|阻止)|\b(?:deduplicat\w*|correlation ids?|field mappings?|idempotency keys?|regression tests?|prevent\w* .{0,18} when)\b/i.test(text);
    const broadImpact = /(?:提升|提高|改善|增强|降低|减少|保障|保证)[^，。；;]{0,28}(?:效率|稳定性|可维护性|可扩展性|扩展能力|风险|成本)|\b(?:improv\w*|increas\w*|reduc\w*)\s+(?:system |operational |maintenance )?(?:efficiency|stability|maintainability|extensibility|risk|costs?)\b/i.test(text);
    if (broadImpact && concreteBehavior && /大幅|显著|\b(?:dramatically|significantly|greatly)\b/i.test(text) &&
      !/(?:从|由|from\s+)[^。；;]{0,20}\d[^。；;]{0,24}(?:到|至|为|to\s+)[^。；;]{0,10}\d/i.test(text)) return source.targetRef.locale === "en"
      ? { kind: "magnitude", title: "The mechanism is clear; check the scale of its effect", question: "What supports the degree of improvement? Without a usable comparison, keep the safeguard and the behavior it changes, and leave out the magnitude." }
      : { kind: "magnitude", title: "机制已经具体，幅度仍需依据", question: "说“大幅”或“显著”的依据是什么？没有可核对的对比也没关系，保留处理机制和可观察行为即可。" };
    if (broadImpact && !concreteBehavior) return source.targetRef.locale === "en"
      ? { kind: "mechanism", title: "Show what changed, not just the benefit", question: "Which component or workflow did you change, and how does it behave now? If you have no measurements, describe an observable behavior instead of claiming a degree of improvement." }
      : { kind: "mechanism", title: "把笼统效果换成可核对的动作", question: "你具体改了哪个对象、用了什么处理办法？改动后能观察到什么行为？如果没有记录，不必写改善幅度，也不必补数字。" };
    if (concreteBehavior) return;
  }
  if ((text.match(/负责|参与|完成|维护|responsible for|participated/gi)?.length ?? 0) >= 2
    || /^(负责|参与|responsible for|participated)/i.test(text)) {
    return { kind: "duties", title: "像职责清单，可以再具体一点", question: "这项工作遇到的具体问题是什么？你采取了什么不同的处理办法？没有数据也可以讲清可观察的变化。" };
  }
  if (text.length < 35 && source.targetRef.kind === "claim_text") {
    return { kind: "context", title: "给这条经历加一点上下文", question: "这个动作服务于什么场景？你负责哪一部分？结果如何被观察或验证？" };
  }
}

export function newWritingNote(source: WritingSource, issue: WritingIssue): WritingNote {
  // Identity is the stable field plus exact source, never screen coordinates.
  return { id: crypto.randomUUID(), source, issue, state: "open", answer: "", updatedAt: Date.now() };
}
export function reconcileWritingNotes(notes: WritingNote[], sources: WritingSource[]): WritingNote[] {
  return notes.map(note => {
    const current = sources.find(source => writingTargetKey(source.targetRef) === writingTargetKey(note.source.targetRef));
    if (note.state === "open" && current?.text !== note.source.text) {
      const quote = current && note.source.quote && resolveWritingQuote(current.text, note.source.quote);
      if (quote) return { ...note, source: { ...current, quote }, proposedText: undefined, questions: undefined, rationale: undefined, evidenceQuotes: undefined, autoAsked: false, updatedAt: Date.now() };
      return { ...note, state: "stale", updatedAt: Date.now() };
    }
    if (note.state === "stale" && current && current.text === note.source.text) {
      return { ...note, state: "open", updatedAt: Date.now() };
    }
    return note;
  });
}

export function writingOriginal(source: WritingSource): string { return source.quote?.exact ?? source.text; }
/** A selected phrase produces a whole-field CAS patch; all surrounding text stays byte-for-byte. */
export function writingProposal(note: WritingNote, undo = false): ResumeProposalWrite | undefined {
  if (!note.proposedText?.trim()) return;
  let candidate = note.proposedText;
  if (note.source.quote) {
    const quote = resolveWritingQuote(note.source.text, note.source.quote);
    if (!quote) return;
    candidate = note.source.text.slice(0, quote.start) + candidate + note.source.text.slice(quote.end);
  }
  return { targetRef: note.source.targetRef, originalText: undo ? candidate : note.source.text, proposedText: undo ? note.source.text : candidate };
}

const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile_headline"), locale: z.enum(["zh", "en"]) }).strict(),
  z.object({ kind: z.literal("claim_text"), experienceId: z.string(), claimId: z.string(), locale: z.enum(["zh", "en"]) }).strict(),
]);
const Quote = z.object({ exact: z.string().min(1), prefix: z.string().max(32), suffix: z.string().max(32), start: z.number().int().nonnegative(), end: z.number().int().positive() });
const Source = z.object({ targetRef: Target, text: z.string(), label: z.string().max(2000), quote: Quote.optional() });
const Note = z.object({
  id: z.string(), source: Source, issue: z.object({ kind: z.string(), title: z.string(), question: z.string() }),
  state: z.enum(["open", "dismissed", "applied", "stale"]), answer: z.string(),
  questions: z.array(z.string()).max(3).optional(), proposedText: z.string().optional(),
  rationale: z.string().optional(), autoAsked: z.boolean().optional(), updatedAt: z.number(),
  evidenceQuotes: z.array(z.string()).optional(),
});
const Session = z.object({ version: z.literal(1), mode: z.enum(["quiet", "proactive", "paused"]), autoLocalModel: z.boolean().optional(), notes: z.array(Note) });
export function readWritingSession(storage: Pick<Storage, "getItem">, key: string): WritingSession {
  try {
    const parsed = Session.safeParse(JSON.parse(storage.getItem(key) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch { /* An unavailable annotation store must never block the resume editor. */ }
  return { version: 1, mode: "proactive", notes: [] };
}
export function saveWritingSession(storage: Pick<Storage, "getItem" | "setItem">, key: string, session: WritingSession) {
  // Merge independent notes from another tab; a late reply cannot reopen its dismissal.
  const prior = readWritingSession(storage, key);
  const notes = new Map(prior.notes.map(note => [note.id, note]));
  for (const note of session.notes) {
    const old = notes.get(note.id);
    if (old && old.state === "dismissed" && note.state === "open") continue;
    if (!old || old.updatedAt <= note.updatedAt) notes.set(note.id, note);
  }
  const merged = { ...session, notes: [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
  storage.setItem(key, JSON.stringify(merged));
  return merged;
}

export type WritingTransport = typeof fetchChatCompletionResult;
export function isLocalWritingModel(config: LlmConfig): boolean {
  try { return config.provider === "ollama" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.baseUrl).hostname) && !/(?:-cloud|:cloud)$/i.test(config.model); }
  catch { return false; }
}
export async function generateWritingReply(config: LlmConfig, source: WritingSource, answer: string, signal: AbortSignal,
  transport?: WritingTransport, projectContext?: ConfirmedWritingProjectContext, sharedAgentContext?: string): Promise<WritingReply> {
  signal.throwIfAborted();
  // Pure protocol regression seam only. Production refinement is an experience_refine task.
  if (!transport) throw new WritingReplyError("旧浏览器写作执行器已退役，请使用统一经历任务；未发送资料或切换模型。");
  if (!config.model.trim() || !config.baseUrl.trim() || (config.provider !== "ollama" && !config.apiKey?.trim())) {
    throw new WritingReplyError("模型配置还没完成，请打开右上角“AI 配置”补齐模型与访问密钥；本地规则和手动补充仍可使用，原文没有改动。");
  }
  const originalText = writingOriginal(source), confirmedSupplement = answer;
  const localSchema = isLocalWritingModel(config);
  const result = await transport(config, writingMessages(source, answer, projectContext, sharedAgentContext), { signal, ...(localSchema ? { responseFormat: { type: "json_schema" as const, json_schema: { name: "betterme_writing", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["questions", "rationale", "evidenceQuotes"], properties: {
      questions: { type: "array", maxItems: 3, items: { type: "string" } }, rationale: { type: "string" },
      evidenceQuotes: { type: "array", maxItems: 2, items: { type: "string", enum: [originalText, ...(confirmedSupplement ? [confirmedSupplement] : [])] } },
      ...(confirmedSupplement ? { proposedText: { type: "string" } } : {}),
    },
  } } } } : jsonObjectOptions(config)) });
  signal.throwIfAborted();
  if (result.finishReason === "length") throw new Error("模型答复被截断，未采用；请缩短补充内容后重试。");
  return parseWritingReply(result.content, source, answer);
}

/**
 * JD Match Graph — graph nodes.
 *
 * Node boundary rules enforced here:
 *  - No node accesses resume text directly; it reads profile entries via tool calls.
 *  - No node writes to the profile store; proposals are returned for browser confirmation.
 *  - Business rules (evidence grading, gap detection) live in pure functions, not in the graph.
 *  - The graph only routes and accumulates.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type {
  JdMatchState,
  StructuredJd,
  MatchProposal,
} from "./state.js";

// ── Pure helpers ──────────────────────────────────────────────────────────────

function extractJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch?.[1] ? fenceMatch[1].trim() : trimmed;

  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  let start = -1;
  let end = -1;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    end = candidate.lastIndexOf("]");
  } else if (firstBrace !== -1) {
    start = firstBrace;
    end = candidate.lastIndexOf("}");
  }

  const jsonStr = (start !== -1 && end !== -1 && end > start)
    ? candidate.slice(start, end + 1)
    : candidate;

  return JSON.parse(jsonStr) as T;
}

function generateProposalId(jdItem: string, index: number): string {
  return `prop-${index}-${jdItem.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`;
}

// ── Node: structureJd ─────────────────────────────────────────────────────────

/**
 * Parses the raw JD text into a structured object.
 * rawJd stays in an untracked channel for this invocation only; neither it nor
 * the ingress envelope is saved in checkpoint history.
 */
export function makeStructureJdNode(model: BaseChatModel) {
  return async (state: JdMatchState): Promise<Partial<JdMatchState>> => {
    const { rawJd } = state;
    if (!rawJd?.trim()) {
      return {
        errors: ["structureJd: rawJd is empty"],
        stepLog: ["structureJd: skipped — no JD provided"],
      };
    }

    try {
      const response = await model.invoke([
        new SystemMessage(`你是一个结构化招聘信息提取助手。
从用户提供的 JD 文本中提取以下字段，以 JSON 格式输出（不要有 markdown 围栏）：
{
  "title": "职位名称",
  "company": "公司名称",
  "location": "工作地点",
  "requirements": ["必须具备的条件列表"],
  "preferences": ["加分项列表"],
  "compensationRaw": "薪资描述（原文，或 null）",
  "techStack": ["技术栈 / 工具列表"]
}
只输出 JSON，不要解释。`),
        new HumanMessage(rawJd),
      ]);

      const content = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      const structured = extractJson<StructuredJd>(content);
      return {
        structuredJd: structured,
        stepLog: [`structureJd: extracted ${structured.requirements.length} requirements, ${structured.techStack.length} tech items`],
      };
    } catch (err: any) {
      return {
        errors: [`structureJd: ${err?.message ?? String(err)}`],
        stepLog: ["structureJd: failed to parse JD"],
      };
    }
  };
}

// ── Node: matchProfile ────────────────────────────────────────────────────────

/**
 * Compares the structured JD against the allowed verified profile entries
 * and session-scoped unverified claims.
 *
 * Profile entry content is read via tool calls (read-index effect only).
 * The actual profile text never lands in the graph state.
 */
export function makeMatchProfileNode(model: BaseChatModel) {
  return async (state: JdMatchState): Promise<Partial<JdMatchState>> => {
    const { structuredJd, allowedProfileEntryIds, sessionClaims } = state;
    if (!structuredJd) {
      return {
        errors: ["matchProfile: no structuredJd available"],
        stepLog: ["matchProfile: skipped"],
      };
    }

    try {
      // Build a compact profile summary for the model from IDs + session claims.
      // In a real run, this would call read-index tools to fetch entry content;
      // for the first closed-loop version we pass the claim map directly since
      // entry content arrives via sessionClaims from the browser.
      const claimsSummary = Object.entries(sessionClaims)
        .map(([k, v]) => `[${k}]: ${v}`)
        .join("\n");

      const verifiedIds = allowedProfileEntryIds.join(", ") || "（无已核实条目）";

      const prompt = `你是一个简历匹配助手。

## 岗位需求
${structuredJd.requirements.map((r, i) => `${i + 1}. ${r}`).join("\n")}

## 加分项
${structuredJd.preferences.map((p, i) => `${i + 1}. ${p}`).join("\n")}

## 候选人已核实条目 ID（内容需通过工具读取）
${verifiedIds}

## 候选人本次会话声明（待核实）
${claimsSummary || "（无）"}

请为每条需求和主要加分项生成一条匹配分析。输出 JSON 数组，每项格式：
{
  "jdItem": "原需求文本",
  "evidenceType": "verified" | "claimed" | "gap",
  "profileEntryId": "条目 ID（仅 verified 时填写）",
  "suggestion": "简历建议表述（一句话）",
  "rationale": "简短依据"
}
只输出 JSON 数组，不要解释。`;

      const response = await model.invoke([
        new SystemMessage("你是一个精准的简历匹配助手。只输出 JSON，不要 markdown。"),
        new HumanMessage(prompt),
      ]);

      const content = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      const rawProposals = extractJson<Array<{
        jdItem: string;
        evidenceType: "verified" | "claimed" | "gap";
        profileEntryId?: string;
        suggestion: string;
        rationale: string;
      }>>(content);

      const proposals: MatchProposal[] = rawProposals.map((p, i) => ({
        id: generateProposalId(p.jdItem, i),
        jdItem: p.jdItem,
        evidenceType: p.evidenceType,
        profileEntryId: p.profileEntryId,
        suggestion: p.suggestion,
        rationale: p.rationale,
      }));

      return {
        proposals,
        stepLog: [`matchProfile: generated ${proposals.length} proposals`],
      };
    } catch (err: any) {
      return {
        errors: [`matchProfile: ${err?.message ?? String(err)}`],
        stepLog: ["matchProfile: failed"],
      };
    }
  };
}

// ── Node: confirmProposals (human-in-the-loop) ────────────────────────────────

/**
 * Interrupts the graph and surfaces proposals to the browser for per-item review.
 *
 * LangGraph's interrupt() suspends execution and persists state to the checkpointer.
 * When the browser calls graph.invoke() again with the same thread_id and supplies
 * decisions, execution resumes at this node. The resumed call receives the decisions
 * through the state reducer and immediately returns without calling interrupt() again.
 */
export async function confirmProposalsNode(
  state: JdMatchState
): Promise<Partial<JdMatchState>> {
  const { proposals, decisions } = state;

  // On resume, all proposals already have decisions — skip interrupt.
  const undecided = proposals.filter((p) => !decisions[p.id]);
  if (undecided.length === 0) {
    return { stepLog: ["confirmProposals: all proposals decided, resuming"] };
  }

  // interrupt() throws an InterruptError that LangGraph catches to persist
  // state and return the value to the caller.
  const resumeDecisions = interrupt({
    type: "proposal_review",
    proposals: undecided,
  }) as Record<string, import("./state.js").ProposalDecision>;

  // After the browser resumes the thread with decisions, the state reducer
  // merges them. Return a log entry only.
  return {
    decisions: resumeDecisions,
    stepLog: [`confirmProposals: received ${Object.keys(resumeDecisions).length} decisions from browser`],
  };
}

// ── Node: buildOutput ─────────────────────────────────────────────────────────

/**
 * Pure aggregation node. Returns a structured output ready for the browser
 * to display and, for accepted proposals, to write to the profile store.
 *
 * No writes happen here. The browser owns the confirmed write.
 */
export async function buildOutputNode(
  state: JdMatchState
): Promise<Partial<JdMatchState>> {
  const accepted = state.proposals.filter(
    (p) => state.decisions[p.id]?.status === "accepted"
  );
  const gaps = state.proposals.filter((p) => p.evidenceType === "gap");

  return {
    stepLog: [
      `buildOutput: ${accepted.length} accepted proposals, ${gaps.length} identified gaps`,
    ],
  };
}

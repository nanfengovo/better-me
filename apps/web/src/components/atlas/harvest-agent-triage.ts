import type { HarvestIssue } from "./harvest-issue-presentation";

/** A deterministic, read-only assessment. Neither an LLM nor this presenter may infer unseen pages or saved jobs. */
export function buildHarvestTriage(issues: readonly HarvestIssue[], saved?: number) {
  const sourceCount = issues.filter(issue => issue.scope === "source").length;
  const gateCount = issues.filter(issue => issue.action.kind === "login").length;
  const ingestionCount = issues.filter(issue => issue.scope === "ingestion").length;
  const runCount = issues.filter(issue => issue.scope === "run" || issue.scope === "query").length;
  const lead = saved === undefined ? "已收到的岗位会保留" : `已确认保存 ${saved} 张输入卡片`;
  const summary = [lead, sourceCount ? `${sourceCount} 个来源未完整读取` : "", gateCount ? `${gateCount} 处需人工登录或验证` : "", ingestionCount ? "部分入库回执待核对" : "", runCount ? "本轮检索有未确认项" : ""].filter(Boolean).join("；") + "。";
  const nextStep = ingestionCount
    ? "先核对入库回执，避免重复提交；已确认保存的岗位不受影响。"
    : gateCount
      ? "在独立浏览器里完成平台登录或验证，再由你决定是否继续读取。"
      : sourceCount || runCount
        ? "先查看对应原站是否已加载，再由你决定是否从断点继续；未返回的页面不算已覆盖。"
        : "已收到的结果会保留；如需更多页面，可检查来源回执后继续。";
  return { summary, nextStep, sourceCount, gateCount, ingestionCount, runCount };
}

/** Only structured labels and counters leave this UI for model analysis; no raw page text, URL, resume or credentials. */
export function createHarvestAgentPrompt(issues: readonly HarvestIssue[], saved?: number): string {
  const triage = buildHarvestTriage(issues, saved);
  const categories = issues.slice(0, 12).map(issue => `${issue.title}（${issue.scope}，${issue.action.kind}）`).join("；");
  return `你是岗位采集故障说明助手。只根据以下结构化回执给出最多三句直白建议，不推断没有回执的平台状态，不声称已自动修复或全部覆盖，不建议绕过验证。不要触发任何工具、修改简历、重新采集、登录或提交。诊断概况：${triage.summary} 已知类别：${categories || "未提供"}。先说已经保留了什么，再说需要用户确认的下一步。`;
}

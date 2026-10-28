import type { HarvestProgressState } from "./harvest-progress-presentation";
import { finiteProgressStat, stringProgressStat } from "./harvest-progress-presentation";
import type { LiveHarvestProvider } from "./live-harvest-view";
import type { LivePlatformImportSummary } from "./live-platform-auto-import";

export type HarvestIssue = {
  id: string;
  scope: "source" | "query" | "ingestion" | "run";
  severity: "info" | "warning" | "error";
  source: string;
  title: string;
  reason: string;
  action: { kind: "login" | "resume" | "details"; label: string; provider?: LiveHarvestProvider["provider"] };
  advice: string;
  rawDetails: string[];
};

export type HarvestIssueInput = {
  providers?: readonly LiveHarvestProvider[];
  progress?: HarvestProgressState | null;
  failed?: boolean;
  cancelled?: boolean;
  importFailures?: readonly Pick<LivePlatformImportSummary["importFailures"][number], "platform" | "cards" | "error">[];
  /** A run-level catch only, not an error shared with unrelated workspace actions. */
  failureMessage?: string;
};

const CREDENTIAL_KEYS = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "xapikey", "key", "secret", "clientsecret",
  "password", "passwd", "pwd", "credential", "credentials", "authorization", "auth", "authcode",
  "authorizationcode", "signature", "sig", "session", "sessionid", "cookie", "setcookie", "jwt",
]);

function isCredentialKey(key: string): boolean {
  let decoded = key;
  try { decoded = decodeURIComponent(key); } catch { /* Malformed diagnostic text stays readable. */ }
  const normalized = decoded.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return CREDENTIAL_KEYS.has(normalized) || /^(?:xamz|xgoog)(?:credential|signature|securitytoken)$/.test(normalized);
}

/** Limited defensive redaction, not a claim that arbitrary free text contains no sensitive data. */
export function sanitizeHarvestDiagnostic(value: string | null | undefined): string {
  const hidden = "[已隐藏]";
  return (value ?? "")
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, `$1${hidden}@`)
    .replace(/([?&#])([^=\s&#]+)=([^&#\s"'<>]*)/g, (match, separator: string, key: string) => isCredentialKey(key) ? `${separator}${key}=${hidden}` : match)
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${hidden}`)
    .replace(/\b(Bearer|Basic)[ \t]+(?:\[已隐藏\]|[^\s"'<>;,}\]]+)/gi, `$1 ${hidden}`)
    .replace(/\b([a-z][a-z0-9_-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\[已隐藏\]|[^\s,;&}\]]+)/gi, (match, key: string, separator: string, secret: string) => {
      if (!isCredentialKey(key)) return match;
      const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : "";
      return `${key}${separator}${quote}${hidden}${quote}`;
    });
}

type SourceDescription = Pick<HarvestIssue, "title" | "reason" | "severity" | "advice"> & {
  kind: HarvestIssue["action"]["kind"];
  label: string;
};

function sourceIssue(provider: LiveHarvestProvider, code: string, description: SourceDescription): HarvestIssue {
  const rawDetails = [...new Set([provider.error, ...provider.warnings].filter((value): value is string => Boolean(value?.trim())).map(value => value.trim()))];
  const reported = rawDetails[0];
  return {
    id: `source:${provider.provider}:${code}`, scope: "source", severity: description.severity, source: provider.platform,
    title: description.title,
    reason: description.reason + (reported && !description.reason.includes(reported) ? ` 平台返回：${reported}` : ""),
    action: { kind: description.kind, label: description.label, provider: provider.provider },
    advice: description.advice, rawDetails,
  };
}

const statusDescriptions: Partial<Record<LiveHarvestProvider["status"], SourceDescription>> = {
  login_required: { title: "需要登录", reason: "平台要求先登录，当前读取无法继续。", severity: "warning",
    kind: "login", label: "打开平台登录", advice: "完成登录后再继续读取；已收到的岗位会保留。" },
  verification_required: { title: "需要安全验证", reason: "平台要求验证码或安全验证，当前读取无法继续。", severity: "warning",
    kind: "login", label: "打开平台验证", advice: "请在平台页面完成验证后再继续读取，不保证验证后可读取全部页面。" },
  unknown_layout: { title: "未识别到可读取列表", reason: "当前页面未被读取器识别，尚无法确认岗位列表。", severity: "warning",
    kind: "details", label: "查看原始诊断", advice: "查看平台页面与原始诊断，确认列表可见后再尝试读取。" },
  oversized: { title: "页面内容超过读取上限", reason: "页面内容超过当前读取上限，本轮未能继续解析。", severity: "warning",
    kind: "details", label: "查看原始诊断", advice: "如需缩小范围，请修改关键词或地区后重新采集；断点继续仍使用原来的查询条件。" },
  unsupported_page: { title: "不支持当前页面", reason: "当前读取器不支持该平台页面。", severity: "warning",
    kind: "details", label: "查看原始诊断", advice: "检查是否为该平台支持的招聘列表页面，再决定如何继续读取。" },
};

function coverageDescription(provider: LiveHarvestProvider): SourceDescription | undefined {
  const coverage = provider.coverage;
  const budget = { severity: "info", kind: "resume", label: "继续读取", advice: "可按需要继续读取；本轮预算不是平台岗位总量，也不代表服务故障。" } as const;
  switch (coverage.stopReason) {
    case "page_limit": return { ...budget, title: "达到本轮页数上限", reason: `已读取 ${coverage.pagesVisited} / ${coverage.pageLimit} 页，本轮按预算停止，未声明覆盖全部岗位。` };
    case "scroll_limit": return { ...budget, title: "达到本轮滚动上限", reason: `已滚动 ${coverage.scrollSteps} / ${coverage.scrollLimit} 次，本轮按预算停止，未声明覆盖全部岗位。` };
    case "card_limit": return { ...budget, title: "达到本轮卡片上限", reason: `本轮卡片预算为 ${coverage.cardLimit} 张，达到预算后停止读取，未声明覆盖全部岗位。` };
    case "no_progress": return { title: "读取未取得进展", reason: "翻页或滚动后未确认页码或列表继续变化，已停止本轮读取。", severity: "warning",
      kind: "resume", label: "检查后继续读取", advice: "检查原站列表是否已加载，再决定是否继续；未确认的后续页面不计作已覆盖。" };
    case "gate": return { title: "需要登录或验证", reason: "来源要求登录或安全验证，但未返回具体拦截类型。", severity: "warning",
      kind: "login", label: "检查平台登录态", advice: "请在平台页面查看实际要求，完成后再继续读取。" };
    case "cancelled": return { title: "已停止读取", reason: "本轮已请求停止，未继续读取的页面不计作已覆盖。", severity: "info",
      kind: "resume", label: "继续读取", advice: "已收到的卡片保留；继续读取前可先核对本轮回执。" };
    case "exhausted":
      return coverage.partial ? { title: "仅确认部分覆盖", reason: "本轮仅确认部分页面或卡片，未声明覆盖全部岗位。", severity: "warning",
        kind: "resume", label: "继续读取", advice: "查看平台覆盖回执，再决定是否继续读取。" } : undefined;
    case "error": return undefined;
  }
}

/** Presentation only: source receipts never imply an ingestion result. */
export function summarizeHarvestIssues({ providers = [], progress, failed = false, cancelled = false, importFailures = [], failureMessage }: HarvestIssueInput): HarvestIssue[] {
  const issues = providers.flatMap(provider => {
    const hasReportedDiagnostic = Boolean(provider.error?.trim() || provider.warnings.some(warning => warning.trim()));
    if (provider.status === "running" || provider.status === "queued") {
      if (!failed && !cancelled && progress?.stage !== "completed") return [];
      return [sourceIssue(provider, "missing_receipt", {
        title: cancelled ? "已停止，未收到最终回执" : "未收到最终回执",
        reason: cancelled ? "已请求停止，该平台未返回最终回执，已收到的卡片保留。"
          : `本轮已结束，但该平台未返回最终回执，无法确认完整读取结果。${hasReportedDiagnostic ? "" : "平台未返回具体原因。"}`,
        severity: cancelled ? "info" : "error", kind: "details", label: "查看原始诊断",
        advice: "未返回的页面不计作已覆盖；核对当前回执后再决定是否继续读取。",
      })];
    }
    if (provider.status === "cancelled") return [sourceIssue(provider, "cancelled", {
      title: "已停止读取", reason: "本轮已请求停止，未继续读取的页面不计作已覆盖。", severity: "info",
      kind: "resume", label: "继续读取", advice: "已收到的卡片保留；继续读取前可先核对本轮回执。",
    })];
    const description = statusDescriptions[provider.status];
    if (description) return [sourceIssue(provider, provider.status, description)];
    if (provider.status === "error" || provider.coverage.stopReason === "error") return [sourceIssue(provider, "error", {
      title: provider.status === "ready" && provider.cardCount > 0 ? "部分页面读取失败" : "平台读取失败",
      reason: provider.error?.trim() || (hasReportedDiagnostic ? "平台读取未完成。" : "平台未返回具体原因。"), severity: "error", kind: "details", label: "查看原始诊断",
      advice: "查看平台返回的诊断后再决定是否重试；已收到的卡片不会因此被当作零结果。",
    })];
    const coverage = coverageDescription(provider);
    if (coverage) return [sourceIssue(provider, provider.coverage.stopReason, coverage)];
    return [];
  });
  const queryError = stringProgressStat(progress?.stats, "queryTermError")?.trim();
  if (queryError && !providers.some(provider => {
    if (!provider.error?.trim() || !issues.some(issue => issue.scope === "source" && issue.action.provider === provider.provider)) return false;
    const withoutPlatform = queryError.replace(new RegExp(`^${provider.platform}\\s*[:：]\\s*`), "");
    return withoutPlatform === provider.error.trim() || queryError === provider.error.trim();
  })) issues.push({
    id: "query:current", scope: "query", severity: "error", source: "本轮检索", title: "检索遇到异常", reason: queryError,
    action: { kind: "details", label: "查看原始诊断" }, advice: "根据这次检索返回的原因处理，再决定是否继续读取。", rawDetails: [queryError],
  });
  const unconfirmed = (finiteProgressStat(progress?.stats, "failedCards") ?? 0) + (finiteProgressStat(progress?.stats, "cancelledCards") ?? 0);
  const importDetails = [...new Set(importFailures.map(failure => `${failure.platform}${Number.isFinite(failure.cards) && failure.cards >= 0 ? `（${failure.cards} 张卡片）` : ""}：${failure.error.trim() || "未返回具体入库原因"}`))];
  const importReason = importDetails.join("；");
  if (unconfirmed > 0 || importDetails.length > 0) issues.push({
    id: "ingestion:unconfirmed", scope: "ingestion", severity: "warning", source: "岗位入库", title: "入库回执尚未确认",
    reason: `${unconfirmed > 0 ? `${unconfirmed} 张卡片的保存结果待确认；未收到回执不等于未写入。` : "入库提交返回异常，尚不能确认保存结果。"}${importReason ? ` 返回原因：${importReason}${/[。.!?！？]$/.test(importReason) ? "" : "。"}` : ""}`,
    action: { kind: "details", label: "查看入库回执" }, advice: "已确认保存的岗位不受影响。先核对提交回执，再处理未确认项；不要把发现的卡片数当作已保存数量。", rawDetails: importDetails,
  });
  const pending = finiteProgressStat(progress?.stats, "pendingCards") ?? 0;
  if (pending > 0 && (failed || cancelled || progress?.stage === "completed")) issues.push({
    id: "ingestion:pending", scope: "ingestion", severity: "warning", source: "岗位入库", title: "还有卡片待处理",
    reason: `有 ${pending} 张卡片尚待处理；待处理不等于已保存，已确认保存的岗位不受影响。`,
    action: { kind: "details", label: "查看入库回执" }, advice: "查看本轮队列与提交回执后，再决定如何继续。", rawDetails: [],
  });
  const runError = failureMessage?.trim();
  if (runError && !issues.some(issue => issue.reason === runError || issue.rawDetails.includes(runError))) issues.push({
    id: "run:reported", scope: "run", severity: cancelled ? "info" : "error", source: "本轮采集", title: cancelled ? "停止时的返回" : "本轮处理中断",
    reason: runError, action: { kind: "details", label: "查看原始诊断" },
    advice: "根据本轮实际返回的原因处理；已确认保存的岗位保留。", rawDetails: [runError],
  });
  const blocked = finiteProgressStat(progress?.stats, "blockedPlatforms") ?? 0;
  if (blocked > 0 && !issues.some(issue => issue.action.kind === "login")) issues.push({
    id: "run:gate", scope: "run", severity: "warning", source: "招聘来源", title: "有平台需要登录或验证",
    reason: `回执记录 ${blocked} 个平台需要登录或安全验证，未返回具体平台与拦截类型。`,
    action: { kind: "login", label: "查看平台登录态" }, advice: "在平台登录态中查看实际要求，完成后再决定是否继续读取。", rawDetails: [],
  });
  const partial = finiteProgressStat(progress?.stats, "partialPlatforms") ?? 0;
  if (partial > 0 && (failed || cancelled || progress?.stage === "completed") && !issues.some(issue => issue.scope === "source")) issues.push({
    id: "run:partial", scope: "run", severity: "warning", source: "招聘来源", title: "仅确认部分覆盖",
    reason: `回执记录 ${partial} 个平台仅部分覆盖，未返回具体停止原因。`,
    action: { kind: "details", label: "查看覆盖回执" }, advice: "部分覆盖不等于服务失败；未确认的页面不计作已覆盖。", rawDetails: [],
  });
  const hasFailureCounter = (finiteProgressStat(progress?.stats, "failedPlatforms") ?? 0) > 0
    || (finiteProgressStat(progress?.stats, "failedQueryTerms") ?? 0) > 0;
  const hasVisibleFailureCause = issues.some(issue => issue.severity === "error"
    || issue.scope === "source" && issue.severity === "warning");
  if ((failed && issues.length === 0 || hasFailureCounter && !queryError && !hasVisibleFailureCause) && !cancelled) {
    issues.push({ id: "run:unexplained", scope: "run", severity: "error", source: "本轮采集", title: "采集未完整完成",
      reason: "平台未返回具体原因。", action: { kind: "details", label: "查看原始诊断" },
      advice: "查看本轮回执与诊断后再决定是否重试；不能据此推断登录、网络或预算问题。",
      rawDetails: progress?.message.trim() ? [progress.message.trim()] : [],
    });
  }
  const priority = (issue: HarvestIssue) => issue.scope === "ingestion" ? 0 : issue.severity === "error" ? 1 : issue.action.kind === "login" ? 2 : issue.severity === "warning" ? 3 : 4;
  return issues.sort((left, right) => priority(left) - priority(right)).map(issue => ({
    ...issue, source: sanitizeHarvestDiagnostic(issue.source), reason: sanitizeHarvestDiagnostic(issue.reason),
    rawDetails: [...new Set(issue.rawDetails.map(sanitizeHarvestDiagnostic))],
  }));
}

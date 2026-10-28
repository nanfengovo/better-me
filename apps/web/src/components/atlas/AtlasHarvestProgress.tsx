import { Activity, AlertTriangle, Check, ChevronDown, Circle, Pause } from "lucide-react";
import type { HarvestProgressState } from "./harvest-progress-presentation";
import { finiteProgressStat, harvestStageHeadline, harvestStageName, harvestStepState, stringProgressStat } from "./harvest-progress-presentation";
import type { LiveHarvestProvider } from "./live-harvest-view";
import { summarizeHarvestIssues, sanitizeHarvestDiagnostic, type HarvestIssueInput } from "./harvest-issue-presentation";

const STAGE_COUNT = 5;

export function AtlasHarvestProgress({
  progress,
  busy,
  cancelled = false,
  failed = false,
  onCancel,
  discoveredCards,
  providers,
  onResume,
  onOpenLogin,
  recoveryMessage,
  recoveryPhase,
  importFailures,
  failureMessage,
}: {
  progress: HarvestProgressState | null;
  busy: boolean;
  cancelled?: boolean;
  failed?: boolean;
  onCancel?: () => void;
  /** Source-identity distinct live cards; do not infer this from saved job rows. */
  discoveredCards?: number;
  providers?: readonly LiveHarvestProvider[];
  onResume?: () => void;
  onOpenLogin?: () => void;
  recoveryMessage?: string;
  recoveryPhase?: string;
  importFailures?: HarvestIssueInput["importFailures"];
  failureMessage?: string;
}) {
  if (!progress && !busy && !cancelled && !failed && discoveredCards === undefined) return null;
  // Changing market scope prepares an intent without starting a harvest. That
  // empty placeholder is not a completed task or a source receipt.
  if (!busy && !cancelled && !failed && progress?.stage === "intent-expansion"
      && discoveredCards === undefined && !Object.keys(progress.stats ?? {}).length) return null;

  const activeIndex = Math.max(1, Math.min(STAGE_COUNT, progress?.stageIndex ?? 1));
  const stopped = cancelled && !busy;
  const headline = failed && !busy
    ? "本轮采集未完整完成"
    : stopped
    ? "已请求停止本轮采集"
    : progress
      ? harvestStageHeadline(progress.stage)
      : busy ? "正在准备实时采集" : "本轮岗位已保留";
  const stats = progress?.stats;
  const queryTermIndex = finiteProgressStat(stats, "queryTermIndex");
  const queryTermTotal = finiteProgressStat(stats, "queryTermTotal");
  const queryTerm = stringProgressStat(stats, "queryTerm");
  const failedTerms = finiteProgressStat(stats, "failedQueryTerms");
  const cardsFetched = finiteProgressStat(stats, "cardsFetched");
  const discovered = discoveredCards !== undefined && Number.isFinite(discoveredCards) && discoveredCards >= 0 ? discoveredCards : cardsFetched;
  const committedCards = finiteProgressStat(stats, "committedCards");
  const pendingCards = finiteProgressStat(stats, "pendingCards");
  const failedCards = finiteProgressStat(stats, "failedCards");
  const cancelledCards = finiteProgressStat(stats, "cancelledCards");
  const pendingBatches = finiteProgressStat(stats, "pendingBatches");
  const totalAdded = finiteProgressStat(stats, "totalAdded");
  const totalUpdated = finiteProgressStat(stats, "totalUpdated");
  const totalUnchanged = finiteProgressStat(stats, "totalUnchanged");
  const failedPlatforms = finiteProgressStat(stats, "failedPlatforms");
  const blockedPlatforms = finiteProgressStat(stats, "blockedPlatforms");
  const partialPlatforms = finiteProgressStat(stats, "partialPlatforms");
  const completedQueryTerms = finiteProgressStat(stats, "completedQueryTerms");
  const collectionFinished = queryTermTotal !== undefined && completedQueryTerms !== undefined && completedQueryTerms >= queryTermTotal;
  const concurrentIngestion = busy && !collectionFinished && (activeIndex === 3 || activeIndex === 2 && (pendingCards ?? 0) > 0);
  const unconfirmedCards = (failedCards ?? 0) + (cancelledCards ?? 0);
  const enrichmentSkipped = progress?.stage === "completed" && finiteProgressStat(stats, "enrichmentSkipped") === 1;
  const enrichmentBackground = finiteProgressStat(stats, "enrichmentBackground") === 1;
  const issues = summarizeHarvestIssues({ providers, progress, failed, cancelled, importFailures, failureMessage });
  const visibleIssues = issues.slice(0, 2);
  const needsLogin = issues.some(issue => issue.action.kind === "login");
  const showResume = !busy && Boolean(onResume);

  return (
    <section className={`atlas-harvest-progress ${busy ? "is-busy" : "is-settled"}${stopped ? " is-cancelled" : ""}`} data-state={failed && !busy ? "attention" : stopped ? "stopped" : busy ? "running" : "settled"} aria-label="实时采集与入库阶段" aria-busy={busy}>
      <header className="atlas-harvest-progress-heading">
        <span className="atlas-harvest-progress-indicator" aria-hidden="true">
          {failed && !busy ? <AlertTriangle size={16} /> : stopped ? <Pause size={16} /> : busy ? <Activity size={17} /> : <Check size={17} />}
        </span>
        <div className="atlas-harvest-progress-copy">
          <strong role="status" aria-live="polite" aria-atomic="true">{headline}</strong>
        </div>
        <dl className="atlas-harvest-progress-summary" aria-label="本轮卡片处理状态">
          <div><dt>发现</dt><dd>{discovered ?? "—"}</dd></div>
          <div><dt>已保存</dt><dd>{committedCards ?? "—"}</dd></div>
          {(busy || (pendingCards ?? 0) > 0) && <div><dt>待处理</dt><dd>{pendingCards ?? "—"}</dd></div>}
        </dl>
        {busy && onCancel && <button type="button" className="atlas-harvest-progress-cancel" onClick={onCancel}>停止采集</button>}
      </header>

      {visibleIssues.length > 0 && <ul className="atlas-harvest-issues" aria-label="本轮未完成原因">
        {visibleIssues.map(issue => <li className="atlas-harvest-issue" key={issue.id} data-severity={issue.severity}>
          <span className="atlas-harvest-issue-source">{issue.source}</span>
          <div className="atlas-harvest-issue-copy"><p className="atlas-harvest-issue-reason">{issue.reason}</p></div>
        </li>)}
      </ul>}
      {recoveryPhase === "error" && recoveryMessage && <p className="atlas-harvest-progress-error" role="alert">{sanitizeHarvestDiagnostic(recoveryMessage)}</p>}
      {!busy && issues.length > 0 && !showResume && !(needsLogin && onOpenLogin) && <p className="atlas-harvest-issue-advice">{issues[0]?.advice}</p>}

      <div className="atlas-harvest-footer">
      <details className="atlas-harvest-progress-details">
        <summary>
          <ChevronDown size={16} aria-hidden="true" /><span>{issues.length ? "原因与处理详情" : "查看处理详情"}</span>
          {issues.length > visibleIssues.length && <small>另有 {issues.length - visibleIssues.length} 项需关注</small>}
        </summary>
        {issues.length > 0 && <ul className="atlas-harvest-issue-details" aria-label="完整原因与处理建议">
          {issues.map(issue => <li key={issue.id}>
            <strong>{issue.source} · {issue.title}</strong><p>{issue.reason}</p><p>{issue.advice}</p>
            {issue.rawDetails.length > 0 && <details><summary>原始诊断</summary><ul>{issue.rawDetails.map((detail, index) => <li key={index}>{detail}</li>)}</ul></details>}
          </li>)}
        </ul>}
        {progress?.message && !stopped && !(failed && !busy && progress.stage !== "completed") && <p className="atlas-harvest-progress-message">{sanitizeHarvestDiagnostic(progress.message)}</p>}
        <ol className="atlas-harvest-progress-stages" aria-label="采集处理阶段">
          {Array.from({ length: STAGE_COUNT }, (_, offset) => {
            const index = offset + 1;
            const state = enrichmentSkipped && index === 4 ? "skipped" : progress?.stage === "completed" ? "complete" : harvestStepState(index, activeIndex, concurrentIngestion);
            const stepState = (stopped || failed && !busy) && state === "current" ? "stopped" : state;
            return (
              <li key={index} data-state={stepState}>
                <span className="atlas-harvest-progress-step-icon" aria-hidden="true">
                  {state === "complete" ? <Check size={12} /> : state === "current" ? <Circle size={10} /> : <span />}
                </span>
                <span>{harvestStageName(index)}{state === "skipped" ? enrichmentBackground ? "（后台）" : "（可补全）" : ""}</span>
              </li>
            );
          })}
        </ol>

        <dl className="atlas-harvest-progress-metrics" aria-label="已确认的采集统计">
          {queryTermIndex !== undefined && queryTermTotal !== undefined && (
            <div><dt>检索词</dt><dd>{queryTermIndex} / {queryTermTotal}{queryTerm ? `：${queryTerm}` : ""}</dd></div>
          )}
          {failedTerms !== undefined && <div data-warning={failedTerms > 0}><dt>失败检索词</dt><dd>{failedTerms}</dd></div>}
          {failedPlatforms !== undefined && <div data-warning={failedPlatforms > 0}><dt>平台失败</dt><dd>{failedPlatforms}</dd></div>}
          {blockedPlatforms !== undefined && <div data-warning={blockedPlatforms > 0}><dt>需登录 / 验证</dt><dd>{blockedPlatforms}</dd></div>}
          {partialPlatforms !== undefined && <div data-warning={partialPlatforms > 0}><dt>部分覆盖平台</dt><dd>{partialPlatforms}</dd></div>}
          {cardsFetched !== undefined && <div><dt>已抓取卡片</dt><dd>{cardsFetched}</dd></div>}
          {totalAdded !== undefined && <div><dt>新增入库</dt><dd>{totalAdded}</dd></div>}
          {totalUpdated !== undefined && <div><dt>更新入库</dt><dd>{totalUpdated}</dd></div>}
          {totalUnchanged !== undefined && <div><dt>未变入库</dt><dd>{totalUnchanged}</dd></div>}
          {pendingBatches !== undefined && <div><dt>待处理批次</dt><dd>{pendingBatches}</dd></div>}
          {pendingCards !== undefined && <div><dt>待处理卡片</dt><dd>{pendingCards}</dd></div>}
          {failedCards !== undefined && <div data-warning={failedCards > 0}><dt>失败 / 未确认</dt><dd>{failedCards}</dd></div>}
          {cancelledCards !== undefined && <div data-warning={cancelledCards > 0}><dt>取消 / 未确认</dt><dd>{cancelledCards}</dd></div>}
        </dl>
        <p className="atlas-harvest-progress-count-note">发现按来源卡片去重；已保存以成功回执确认的输入卡片计数，包含未变记录；待处理包含正在提交的批次。新增、更新、未变是岗位回执数，不等于唯一卡片数。— 表示尚无确认值。</p>
        {recoveryMessage && <p className="atlas-harvest-progress-count-note">{sanitizeHarvestDiagnostic(recoveryMessage)}</p>}
        {!busy && unconfirmedCards > 0 && <p className="atlas-harvest-progress-count-note">有 {unconfirmedCards} 张卡片的提交结果仍需核对；未收到回执不等于未写入。{onResume ? "断点已保留，继续采集时会先核对回执。" : "本轮内存队列不会在刷新后自动恢复。"}</p>}
        {!busy && (pendingCards ?? 0) > 0 && <p className="atlas-harvest-progress-count-note">尚有 {pendingCards} 张卡片未处理；{onResume ? "可从已保存的断点继续。" : "本轮内存队列不会在刷新后自动恢复。"}</p>}
        {failed && !busy && <p className="atlas-harvest-progress-count-note">未返回的平台或页面不计作已覆盖。</p>}
        {stopped && <p className="atlas-harvest-progress-count-note">已请求停止，保留本轮已收到的实时岗位和入库结果；未返回的页面不计作已覆盖。</p>}
      </details>
      {!busy && (showResume || needsLogin && onOpenLogin) && <div className="atlas-harvest-actions">
        {needsLogin && onOpenLogin && <button type="button" onClick={onOpenLogin}>检查平台登录</button>}
        {showResume && <button type="button" onClick={onResume}>继续上次采集</button>}
      </div>}
      </div>
    </section>
  );
}

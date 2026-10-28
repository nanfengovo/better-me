import { ChevronDown, ExternalLink, MapPin } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { getLiveHarvestPage, liveHarvestStopReasonLabel, type LiveHarvestCard, type LiveHarvestView } from "./live-harvest-view";
import { sanitizeHarvestDiagnostic } from "./harvest-issue-presentation";

const LIVE_CARDS_PER_PAGE = 50;

export { liveHarvestStopReasonLabel };

const LiveHarvestCards = memo(function LiveHarvestCards({ cards }: { cards: LiveHarvestCard[] }) {
  return <div className="atlas-live-harvest-list">
    {cards.map(({ provider, platform, card }) => (
      <article className="atlas-live-harvest-card" key={`${provider}:${card.url}`}>
        <div className="atlas-live-harvest-card-top">
          <span>{card.company}</span>
          <span className="atlas-badge-platform">{platform}</span>
        </div>
        <h4>{card.title}</h4>
        <div className="atlas-live-harvest-card-meta">
          {card.locationText && <span><MapPin size={12} aria-hidden="true" />{card.locationText}</span>}
          {card.salaryText && <span>{card.salaryText}</span>}
          {card.publicationText && <span>{card.publicationText}</span>}
        </div>
        <a href={card.url} target="_blank" rel="noreferrer">打开招聘原文 <ExternalLink size={13} aria-hidden="true" /></a>
        <details className="atlas-live-card-details"><summary>岗位摘要与采集证据</summary>
          <p className="atlas-live-harvest-card-text">{card.cardText}</p>
          <small>原站列表卡片摘要，不是完整 JD · 证据页：{card.evidence.pageUrl}</small>
        </details>
      </article>
    ))}
  </div>;
});

export function AtlasLiveHarvestResults({ view, busy = false, compactHeading = false }: { view: LiveHarvestView; busy?: boolean; compactHeading?: boolean }) {
  const queryKey = JSON.stringify([view.query.keyword, view.query.region, view.query.districtCode]);
  const [reading, setReading] = useState({ queryKey, page: 0, acknowledged: view.totalCards });
  const resetReading = reading.queryKey !== queryKey || view.totalCards < reading.acknowledged;
  const page = resetReading ? 0 : reading.page;
  const acknowledged = resetReading ? view.totalCards : reading.acknowledged;
  const newCards = acknowledged > 0 ? Math.max(0, view.totalCards - acknowledged) : 0;
  const currentPage = useMemo(() => getLiveHarvestPage(view.cards, page, LIVE_CARDS_PER_PAGE), [view.cards, page]);
  const runningProviders = view.providers.filter(provider => provider.status === "running").length;
  const attentionProviders = view.providers.filter(provider => provider.status !== "running" && provider.status !== "queued" && (provider.status !== "ready" && provider.status !== "empty" || provider.coverage.partial)).length;

  useEffect(() => {
    if (resetReading || reading.acknowledged === 0 && view.totalCards > 0) {
      setReading({ queryKey, page: 0, acknowledged: view.totalCards });
    }
  }, [resetReading, reading.acknowledged, queryKey, view.totalCards]);

  const showPage = (nextPage: number) => setReading({ queryKey, page: nextPage, acknowledged: view.totalCards });

  return (
    <section className={`atlas-live-harvest-results${compactHeading ? " is-compact" : ""}`} aria-label="本轮实时抓取结果" aria-busy={busy}>
      {!compactHeading && <header className="atlas-live-harvest-heading">
        <div>
          <span className="atlas-live-harvest-kicker">{view.query.keyword || "全部岗位"}</span>
          <h3>本轮原站岗位 <strong>{view.totalCards}</strong></h3>
          <p>{busy ? "已核验卡片持续追加，当前阅读页保持不变。" : `原站卡片 · 最近回执 ${new Date(view.capturedAt).toLocaleString()}`}</p>
        </div>
        <span className="atlas-live-harvest-live-dot">{busy ? "采集中" : "本轮回执"}</span>
      </header>}

      <details className="atlas-live-harvest-sources">
        <summary><ChevronDown size={13} aria-hidden="true" /><span>来源状态</span><small>{view.providers.length} 个平台{runningProviders > 0 ? ` · ${runningProviders} 个读取中` : ""}</small>{attentionProviders > 0 && <em>{attentionProviders} 个需关注</em>}</summary>
        <div className="atlas-live-harvest-coverage" aria-label="实时采集覆盖范围">
          {view.providers.map((provider) => (
            <details key={provider.provider} data-state={provider.status}>
              <summary>
                <span className="atlas-live-harvest-provider-name">{provider.platform}<i aria-hidden="true" /></span>
                <strong>{provider.cardCount} 张</strong>
                <small>{provider.status === "queued" ? `排队等待 · 预算 ${provider.coverage.cardLimit} 卡片`
                  : provider.status === "running" ? `${provider.provider === "boss" ? `当前关键词 · 已滚动 ${provider.coverage.scrollSteps} 步 · 预算 ${provider.coverage.scrollLimit} 步` : `当前关键词 · 已读 ${provider.coverage.pagesVisited} 页 · 预算 ${provider.coverage.pageLimit} 页`} · 候选 ${provider.progressCardsCaptured ?? 0} 张 · 继续读取`
                    : provider.provider === "boss" ? `已滚动 ${provider.coverage.scrollSteps} 步 · 预算 ${provider.coverage.scrollLimit} 步` : `已读 ${provider.coverage.pagesVisited} 页 · 预算 ${provider.coverage.pageLimit} 页`}
                  {provider.status !== "queued" && provider.status !== "running" && (provider.coverage.partial ? ` · 部分：${liveHarvestStopReasonLabel(provider.status, provider.coverage.stopReason)}` : ` · ${liveHarvestStopReasonLabel(provider.status, provider.coverage.stopReason)}`)}
                </small>
              </summary>
              {(provider.error || provider.warnings.length > 0) && (
                <ul>
                  {provider.error && <li role="alert">{sanitizeHarvestDiagnostic(provider.error)}</li>}
                  {provider.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{sanitizeHarvestDiagnostic(warning)}</li>)}
                </ul>
              )}
            </details>
          ))}
        </div>
        <p className="atlas-live-harvest-source-note">页数与滚动次数是本轮读取量和预算，不是网站总量；不同关键词的回执会累计，候选卡片不计入已核验列表。</p>
      </details>

      {view.totalCards > 0 ? (
        <>
          <div className="atlas-live-harvest-pagination" aria-label="实时岗位分页">
            <span>显示 {currentPage.firstItem}–{currentPage.lastItem} / {view.totalCards}</span>
            <div>
              <button type="button" onClick={() => showPage(Math.max(0, currentPage.pageIndex - 1))} disabled={currentPage.pageIndex === 0}>上一页</button>
              <span>{currentPage.pageIndex + 1} / {currentPage.pageCount}</span>
              <button type="button" onClick={() => showPage(Math.min(currentPage.pageCount - 1, currentPage.pageIndex + 1))} disabled={currentPage.pageIndex >= currentPage.pageCount - 1}>下一页</button>
            </div>
            {newCards > 0 && <div className="atlas-live-harvest-new-slot">
              <button type="button" className="atlas-live-harvest-new" onClick={() => showPage(Math.floor(acknowledged / LIVE_CARDS_PER_PAGE))}>查看新增 {newCards}</button>
            </div>}
          </div>
          <LiveHarvestCards cards={currentPage.items} />
        </>
      ) : busy ? (
        <div className="atlas-live-harvest-empty is-loading" role="status">
          正在等待第一个平台返回已核验的岗位卡片；地图仅显示已收录且具有真实办公坐标的岗位。
        </div>
      ) : (
        <div className="atlas-live-harvest-empty" role="status">
          本轮没有拿到可验证的岗位卡片；上方逐个平台状态会说明是空列表、登录验证、页面结构变化或读取异常。此结果不代表招聘网站没有岗位。
        </div>
      )}

      <details className="atlas-live-card-details atlas-live-harvest-method"><summary>来源与地图口径</summary><p className="atlas-live-harvest-footnote">
        岗位列表以本轮实时抓取为准；地图、企业性质和经过确认的办公坐标仍由本机索引提供。有限页数/滚动预算、登录验证和平台动态排序都会影响覆盖，不能据此声称网站全量。
      </p></details>
    </section>
  );
}

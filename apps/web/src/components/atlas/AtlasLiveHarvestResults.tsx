import { ChevronDown, ExternalLink, MapPin } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { getLiveHarvestPage, liveHarvestStopReasonLabel, type LiveHarvestCard, type LiveHarvestView } from "./live-harvest-view";
import { sanitizeHarvestDiagnostic } from "./harvest-issue-presentation";
import { AtlasWorkingConditions } from "./AtlasWorkingConditions";

const LIVE_CARDS_PER_PAGE = 50;

export { liveHarvestStopReasonLabel };

const LiveHarvestCards = memo(function LiveHarvestCards({ cards, onOpenIndexedJob, indexedUrls }: { cards: LiveHarvestCard[]; onOpenIndexedJob?: (url: string) => void; indexedUrls?: ReadonlySet<string> }) {
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
        <AtlasWorkingConditions text={card.cardText} sourceUrl={card.url} excerpt />
        <small>{card.locationText ? "来源地点披露 · 尚不代表已核实办公地址／坐标" : "工作地点待披露 · 不使用企业总部代替"}</small>
        {onOpenIndexedJob && <button type="button" className="atlas-live-card-index" disabled={!indexedUrls?.has(card.url)} onClick={() => onOpenIndexedJob(card.url)}>{indexedUrls?.has(card.url) ? "查看关联岗位／补全地址" : "尚未关联索引 · 不生成办公点"}</button>}
        <details className="atlas-live-card-details"><summary>岗位摘要与采集证据</summary>
          <p className="atlas-live-harvest-card-text">{card.cardText}</p>
          <small>原站列表卡片摘要，不是完整 JD · 证据页：{card.evidence.pageUrl}</small>
        </details>
      </article>
    ))}
  </div>;
});

export function AtlasLiveHarvestResults({ view, busy = false, compactHeading = false, indexedUrls, onOpenIndexedJob }: { view: LiveHarvestView; busy?: boolean; compactHeading?: boolean; indexedUrls?: ReadonlySet<string>; onOpenIndexedJob?: (url: string) => void }) {
  const queryKey = JSON.stringify([view.query.keyword, view.query.region, view.query.districtCode, view.query.market, view.query.countryCodes, view.query.regionGroups]);
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

      {view.scopeSummary && <details className="atlas-live-card-details atlas-live-scope" aria-label="地区过滤回执">
        <summary>本轮捕获 {view.scopeSummary.capturedCards} 张 · 地区匹配 {view.totalCards} 张 · 范围外 {view.scopeSummary.outside.length} 张 · 地点待核实 {view.scopeSummary.unknown.length} 张</summary>
        <p>只依据岗位披露地点过滤，不根据公司名称、总部或搜索条件补造地点。范围外和地点未知卡片保留供核对，不进入当前地区列表或本轮自动入库。</p>
        {[...view.scopeSummary.outside, ...view.scopeSummary.unknown].slice(0, 20).map(({ provider, card }) => <p key={`${provider}:${card.url}`}>
          <a href={card.url} target="_blank" rel="noreferrer">{card.title}</a> · {card.locationText || "地点未披露"}
        </p>)}
        {view.scopeSummary.outside.length + view.scopeSummary.unknown.length > 20 && <small>此处展示前20张待核对卡片；完整原始回执保留在本轮采集记录中。</small>}
      </details>}
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
          <LiveHarvestCards cards={currentPage.items} indexedUrls={indexedUrls} onOpenIndexedJob={onOpenIndexedJob} />
        </>
      ) : view.scopeSummary && view.scopeSummary.capturedCards > 0 ? (
        <div className="atlas-live-harvest-empty" role="status">
          本轮已捕获 {view.scopeSummary.capturedCards} 张卡片，{busy ? "暂未" : "但未"}找到当前地区的明确匹配；范围外和地点待核实卡片见地区过滤回执。{busy ? "其余平台仍在读取。" : "这不代表该地区没有岗位。"}
        </div>
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
        岗位列表以本轮地区匹配卡片为准；地图仅显示这些卡片中已关联本机索引且有可验证办公坐标的岗位。不把未入库卡片当成地图岗位，也不使用整个历史索引凑数。平台来源计数为原始捕获量，地区筛选数量见上方回执；有限预算不代表网站全量。
      </p></details>
    </section>
  );
}
